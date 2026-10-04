import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {EventType, Payload, StoredEvent} from '../src/protocol';
import {EventStore} from '../src/store';
import {ReplayTimeline, replaySnapshot} from '../src/replay';
import {metrics, type RunState} from '../src/state';

const origin = Date.parse('2026-01-01T00:00:00Z');
const attemptKey = JSON.stringify(['action-1', 'attempt-1']);

function event(cursor: number, type: EventType, payload: Payload = {}, extra: Partial<StoredEvent> = {}): StoredEvent {
  const occurred = new Date(origin + cursor * 1000).toISOString();
  return {
    schema_version: 1,
    event_id: `event-${cursor}`,
    run_id: 'run-1',
    producer_id: 'host-1',
    sequence: cursor,
    occurred_at: occurred,
    received_at: occurred,
    cursor,
    type,
    payload,
    ...extra,
  };
}

function checkLiveAndReplay(events: StoredEvent[], check: (run: RunState, source: string) => void) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-state-context-'));
  const store = new EventStore(directory);
  try {
    for (const row of events) {
      const {received_at: _received, cursor: _cursor, ...raw} = row;
      assert.equal(store.ingest(raw).accepted, true);
    }
    check(store.snapshot('run-1').run!, 'live');
    check(replaySnapshot(events, events.length, 'run-1').run!, 'replay');
    const timeline = new ReplayTimeline(events, 1);
    check(timeline.snapshot(events.length, 'run-1').run!, 'timeline');
    timeline.snapshot(1, 'run-1');
    check(timeline.snapshot(events.length, 'run-1').run!, 'timeline after rewind');
  } finally {
    store.close();
    fs.rmSync(directory, {recursive: true, force: true});
  }
}

test('context action IDs on non-action events do not create attempts or change execution state', () => {
  const contexts: {type: EventType; payload?: Payload; status: string; extra?: Partial<StoredEvent>}[] = [
    {type: 'heartbeat', status: 'executing'},
    {type: 'progress.updated', payload: {phase: 'working', completed: 2}, status: 'executing'},
    {type: 'telemetry.dropped', payload: {count: 3}, status: 'executing'},
    {type: 'run.started', payload: {name: 'task'}, status: 'executing'},
    {type: 'run.completed', status: 'completed'},
    {type: 'run.failed', status: 'failed'},
    {type: 'run.cancelled', status: 'cancelled'},
    {
      type: 'decision.started',
      payload: {kind: 'choice', question: 'Next?'},
      status: 'evaluating',
      extra: {decision_id: 'decision-2', request_id: 'request-2', question_id: 'question-2'},
    },
    {
      type: 'decision.resolved',
      payload: {kind: 'choice', choice: 'continue'},
      status: 'selected',
      extra: {decision_id: 'decision-2', request_id: 'request-2', question_id: 'question-2'},
    },
    {
      type: 'decision.failed',
      payload: {reason: 'timeout'},
      status: 'failed',
      extra: {decision_id: 'decision-2', request_id: 'request-2', question_id: 'question-2'},
    },
  ];
  for (const context of contexts) {
    for (const attemptId of ['attempt-1', 'context-only-attempt']) {
      const events = [
        event(1, 'action.started', {}, {action_id: 'action-1', attempt_id: 'attempt-1'}),
        event(2, context.type, context.payload, {
          action_id: 'action-1',
          attempt_id: attemptId,
          ...context.extra,
        }),
      ];
      checkLiveAndReplay(events, (run, source) => {
        const label = `${context.type} / ${attemptId} / ${source}`;
        assert.equal(run.status, context.status, label);
        assert.deepEqual(Object.keys(run.attempts), [attemptKey], label);
        assert.equal(run.attempts[attemptKey].status, 'executing', label);
        assert.equal(run.attempts[attemptKey].decision_id, undefined, label);
        assert.equal(run.anomalies, 0, label);
        assert.equal(metrics(run).retries, 0, label);
        if (context.type.startsWith('decision.'))
          assert.equal(run.decisions['decision-2'].status, context.status, label);
        if (context.type === 'progress.updated') assert.equal(run.progress?.completed, 2, label);
        if (context.type === 'telemetry.dropped') assert.equal(run.dropped, 3, label);
      });
    }
  }
});

test('context IDs do not cause association anomalies or exhaust the attempt bound', () => {
  const events = [
    event(1, 'action.started', {}, {action_id: 'action-1', attempt_id: 'attempt-1', decision_id: 'decision-1'}),
    event(2, 'heartbeat', {}, {action_id: 'action-1', attempt_id: 'attempt-1', decision_id: 'other-decision'}),
  ];
  for (let cursor = 3; cursor <= 505; cursor++) {
    events.push(event(cursor, 'heartbeat', {}, {action_id: 'action-1', attempt_id: `context-${cursor}`}));
  }
  checkLiveAndReplay(events, (run, source) => {
    assert.equal(run.status, 'executing', source);
    assert.equal(run.anomalies, 0, source);
    assert.equal(run.limited, false, source);
    assert.deepEqual(Object.keys(run.attempts), [attemptKey], source);
    assert.equal(run.attempts[attemptKey].decision_id, 'decision-1', source);
    assert.equal(metrics(run).retries, 0, source);
  });
});

test('actual action and verification events still advance attempts and reject conflicting associations', () => {
  const ids = {action_id: 'action-1', attempt_id: 'attempt-1', decision_id: 'decision-1'};
  const events = [
    event(1, 'action.selected', {action: 'continue', source: 'application'}, ids),
    event(2, 'action.started', {}, ids),
    event(3, 'action.completed', {}, ids),
    event(
      4,
      'verification.completed',
      {result: 'passed', checks: [{name: 'done', observed: 'yes', result: 'passed'}]},
      ids,
    ),
    event(5, 'action.failed', {reason: 'wrong association'}, {...ids, decision_id: 'other-decision'}),
  ];
  checkLiveAndReplay(events, (run, source) => {
    const attempt = run.attempts[attemptKey];
    assert.equal(run.status, 'passed', source);
    assert.equal(attempt.status, 'passed', source);
    assert.equal(attempt.selected?.payload.action, 'continue', source);
    assert.equal(attempt.started?.event_id, 'event-2', source);
    assert.equal(attempt.terminal?.type, 'action.completed', source);
    assert.equal(attempt.verification?.payload.result, 'passed', source);
    assert.equal(attempt.decision_id, 'decision-1', source);
    assert.equal(run.anomalies, 1, source);
    assert.deepEqual(metrics(run), {passed: 1, failed: 0, unknown: 0, unverified: 0, retries: 0}, source);
  });
});

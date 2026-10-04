import assert from 'node:assert/strict';
import test from 'node:test';
import type {Snapshot} from '../src/ipc';
import type {EventType, Payload, StoredEvent} from '../src/protocol';
import {pageReplay, replaySnapshot, ReplayTimeline} from '../src/replay';

function sourceEvents(): StoredEvent[] {
  const events: StoredEvent[] = [];
  const add = (type: EventType, payload: Payload, extra: Partial<StoredEvent> = {}) => {
    const sequence = events.length + 1;
    const time = new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString();
    events.push({
      schema_version: 1,
      event_id: `isolation-${sequence}`,
      run_id: 'run-1',
      producer_id: 'host-1',
      sequence,
      occurred_at: time,
      received_at: time,
      cursor: sequence,
      type,
      payload,
      ...extra,
    });
  };
  const decision = {request_id: 'request-1', question_id: 'question-1', decision_id: '__proto__'};
  const attempt = {...decision, action_id: 'action-1', attempt_id: 'attempt-1'};
  add('run.started', {name: '原始运行', simulated: true});
  add(
    'decision.started',
    {
      question: '原始问题',
      candidates: {A: '候选 A', B: '候选 B'},
      legend: {A: '原始说明'},
      diagnostic: JSON.parse('{"nested":{"items":[{"value":"original"}]},"__proto__":{"safe":true}}'),
    },
    decision,
  );
  add('decision.resolved', {choice: 'A', probabilities: {A: 0.8, B: 0.2}, usage: {input: 10}}, decision);
  add('action.selected', {action: '原始动作'}, attempt);
  add('action.started', {summary: '原始执行'}, attempt);
  add('action.completed', {summary: '执行完成'}, attempt);
  add(
    'verification.completed',
    {result: 'passed', checks: [{name: '原始检查', observed: '原始观测', result: 'passed', evidence: '原始证据'}]},
    attempt,
  );
  add('progress.updated', {phase: '原始阶段', completed: 1, total: 2, usage: {input: 20}});
  add('run.started', {name: '另一个运行'}, {run_id: 'run-2'});
  add('progress.updated', {phase: '另一个阶段', completed: 2, total: 3}, {run_id: 'run-2'});
  for (let index = 0; index < 12; index++) add('heartbeat', {summary: `心跳 ${index}`});
  add('progress.updated', {phase: '后续阶段', completed: 2, total: 2});
  return events;
}

function tamperPayload(payload: Payload) {
  payload.summary = '被修改';
  if (payload.candidates) payload.candidates.A = '被修改';
  if (payload.probabilities) payload.probabilities.A = 0;
  if (payload.legend) payload.legend.A = '被修改';
  if (payload.usage) payload.usage.input = 999;
  if (payload.phase) payload.phase = '被修改';
  if (payload.checks) {
    payload.checks[0].observed = '被修改';
    payload.checks[0].evidence = '被修改';
    payload.checks.push({name: '被插入', observed: '被插入', result: 'failed'});
  }
  if (payload.diagnostic) {
    const diagnostic = payload.diagnostic as {nested: {items: {value: string}[]}; __proto__: {safe: boolean}};
    diagnostic.nested.items[0].value = 'changed';
    diagnostic.__proto__.safe = false;
  }
}

function tamperSnapshot(snapshot: Snapshot) {
  for (const summary of snapshot.runs) {
    summary.name = '被修改';
    if (summary.progress) tamperPayload(summary.progress);
    if (summary.latest) tamperPayload(summary.latest.payload);
  }
  if (snapshot.run) {
    if (snapshot.run.latest) {
      snapshot.run.latest.event_id = 'changed-latest';
      tamperPayload(snapshot.run.latest.payload);
    }
    if (snapshot.run.progress) tamperPayload(snapshot.run.progress);
    for (const decision of Object.values(snapshot.run.decisions)) {
      decision.status = 'changed';
      tamperPayload(decision.payload);
      for (const event of [decision.started, decision.resolved, decision.failed]) {
        if (event) tamperPayload(event.payload);
      }
    }
    for (const attempt of Object.values(snapshot.run.attempts)) {
      attempt.status = 'changed';
      for (const event of [attempt.selected, attempt.started, attempt.terminal, attempt.verification]) {
        if (event) tamperPayload(event.payload);
      }
    }
  }
  for (const event of snapshot.events) {
    event.received_at = 'changed';
    tamperPayload(event.payload);
  }
}

test('from-scratch replay snapshots detach every nested output from the source and other snapshots', () => {
  const events = sourceEvents();
  const source = JSON.stringify(events);
  const baseline = JSON.stringify(replaySnapshot(events, events.length, 'run-1'));
  const first = replaySnapshot(events, events.length, 'run-1');
  const sibling = replaySnapshot(events, events.length, 'run-1');
  tamperSnapshot(first);
  assert.equal(JSON.stringify(events), source);
  assert.equal(JSON.stringify(sibling), baseline);
  assert.equal(JSON.stringify(replaySnapshot(events, events.length, 'run-1')), baseline);
});

test('checkpoint snapshots stay isolated while seeking forward, backward and across saved checkpoints', () => {
  const events = sourceEvents();
  const source = JSON.stringify(events);
  const expected = new Map<number, string>();
  const counts = [8, 7, events.length, 8, 5, 9, events.length, 3, 7, 10];
  for (const count of counts) expected.set(count, JSON.stringify(replaySnapshot(events, count, 'run-1')));
  const timeline = new ReplayTimeline(events, 4);
  for (const count of counts) {
    const first = timeline.snapshot(count, 'run-1');
    const sibling = timeline.snapshot(count, 'run-1');
    assert.equal(JSON.stringify(first), expected.get(count));
    tamperSnapshot(first);
    assert.equal(JSON.stringify(sibling), expected.get(count));
    assert.equal(JSON.stringify(timeline.snapshot(count, 'run-1')), expected.get(count));
    assert.equal(JSON.stringify(events), source);
  }
});

test('isolated snapshots preserve state table prototypes and aliases within their returned graph', () => {
  const events = sourceEvents();
  const timeline = new ReplayTimeline(events, 4);
  for (const snapshot of [replaySnapshot(events, 8, 'run-1'), timeline.snapshot(8, 'run-1')]) {
    const run = snapshot.run;
    assert.ok(run);
    assert.equal(Object.getPrototypeOf(run.decisions), null);
    assert.equal(Object.getPrototypeOf(run.attempts), null);
    assert.equal(Object.hasOwn(run.decisions, '__proto__'), true);
    const started = snapshot.events.find(event => event.type === 'decision.started');
    const resolved = snapshot.events.find(event => event.type === 'decision.resolved');
    const verification = snapshot.events.find(event => event.type === 'verification.completed');
    const progress = snapshot.events.find(event => event.type === 'progress.updated');
    assert.ok(started && resolved && verification && progress);
    assert.equal(run.latest, progress);
    assert.equal(run.progress, progress.payload);
    assert.equal(snapshot.runs[0].latest, run.latest);
    assert.equal(snapshot.runs[0].progress, run.progress);
    assert.equal(run.decisions.__proto__.started, started);
    assert.equal(run.decisions.__proto__.resolved, resolved);
    assert.equal(run.decisions.__proto__.payload.candidates, started.payload.candidates);
    assert.equal(Object.values(run.attempts)[0].verification, verification);
    assert.notEqual(started, events[1]);
    assert.notEqual(started.payload, events[1].payload);
    const diagnostic = started.payload.diagnostic as Record<string, unknown>;
    assert.equal(Object.hasOwn(diagnostic, '__proto__'), true);
    assert.equal(Object.getPrototypeOf(diagnostic), Object.prototype);
    assert.notEqual(diagnostic.__proto__, (events[1].payload.diagnostic as Record<string, unknown>).__proto__);
  }
});

test('replay pages detach nested events and do not corrupt later snapshots or pages', () => {
  const events = sourceEvents();
  const source = JSON.stringify(events);
  const timeline = new ReplayTimeline(events, 4);
  const baseline = JSON.stringify(timeline.snapshot(events.length, 'run-1'));
  const page = pageReplay(events, events.length, {runId: 'run-1', beforeCursor: 9, limit: 7});
  const sibling = pageReplay(events, events.length, {runId: 'run-1', beforeCursor: 9, limit: 7});
  const expected = JSON.stringify(sibling);
  assert.equal(page.length, 7);
  assert.equal(page[0].type, 'decision.started');
  for (const event of page) {
    event.event_id = 'changed-page';
    tamperPayload(event.payload);
  }
  assert.equal(JSON.stringify(events), source);
  assert.equal(JSON.stringify(sibling), expected);
  assert.equal(
    JSON.stringify(pageReplay(events, events.length, {runId: 'run-1', beforeCursor: 9, limit: 7})),
    expected,
  );
  assert.equal(JSON.stringify(timeline.snapshot(events.length, 'run-1')), baseline);
  assert.deepEqual(pageReplay(events, 0), []);
});

test('replay boundaries copy cyclic diagnostic graphs without retaining their source objects', () => {
  const events = sourceEvents().slice(0, 2);
  const diagnostic: {value: string; self?: unknown} = {value: 'original'};
  diagnostic.self = diagnostic;
  events[1].payload.diagnostic = diagnostic;
  for (const snapshot of [replaySnapshot(events, 2), new ReplayTimeline(events, 1).snapshot(2)]) {
    const copied = snapshot.events[1].payload.diagnostic as typeof diagnostic;
    assert.notEqual(copied, diagnostic);
    assert.equal(copied.self, copied);
    copied.value = 'changed';
    assert.equal(diagnostic.value, 'original');
  }
  const copied = pageReplay(events, 2)[1].payload.diagnostic as typeof diagnostic;
  assert.notEqual(copied, diagnostic);
  assert.equal(copied.self, copied);
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {schema, validateEvent, type MonitorEvent} from '../src/protocol';
import {EventStore} from '../src/store';
import {metrics, type RunState} from '../src/state';

const root = path.resolve(__dirname, '..');
const origin = Date.parse('2026-01-01T00:00:00Z');

interface ScenarioExpect {
  run_status: string;
  decisions: Record<string, string>;
  attempts: Record<string, string>;
  metrics: {passed: number; failed: number; unknown: number; unverified: number; retries: number};
}

interface Scenario {
  id: string;
  title: string;
  file: string;
  delay_ms: number;
  pause_after_index: number | null;
  pause_ms: number | null;
  expect: ScenarioExpect;
}

function observed(run: RunState): ScenarioExpect {
  const decisions: Record<string, string> = {};
  for (const [id, decision] of Object.entries(run.decisions)) decisions[id] = decision.status;
  const attempts: Record<string, string> = {};
  for (const attempt of Object.values(run.attempts)) attempts[`${attempt.action_id}/${attempt.id}`] = attempt.status;
  return {run_status: run.status, decisions, attempts, metrics: metrics(run)};
}

function readEvents(file: string): MonitorEvent[] {
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(text.includes('\r'), false, file);
  const events: MonitorEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const value: unknown = JSON.parse(line);
    validateEvent(value);
    events.push(value);
  }
  return events;
}

test('schema file matches src/protocol.ts', () => {
  const text = fs.readFileSync(path.join(root, 'protocol/event.schema.json'), 'utf8');
  assert.equal(text, `${JSON.stringify(schema, null, 2)}\n`);
  assert.deepEqual(JSON.parse(text), schema);
});

test('scenario fixtures validate and match expected state', () => {
  const index = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/scenarios/index.json'), 'utf8')) as {
    scenarios: Scenario[];
  };
  assert.deepEqual(
    index.scenarios.map(scenario => scenario.id),
    ['normal', 'dispersed', 'rule-override', 'retry', 'verify-failed', 'reconnect', 'concurrent'],
  );
  for (const scenario of index.scenarios) {
    assert.equal(scenario.file, `${scenario.id}.jsonl`);
    assert.ok(scenario.title.length > 0);
    assert.equal(Number.isInteger(scenario.delay_ms) && scenario.delay_ms >= 0, true);
    const events = readEvents(path.join(root, 'fixtures/scenarios', scenario.file));
    assert.ok(events.length > 0, scenario.id);
    const producer = events[0].producer_id;
    const runId = events[0].run_id;
    let previous = origin - 1;
    for (const [indexInFile, event] of events.entries()) {
      assert.equal(event.sequence, indexInFile + 1, scenario.id);
      assert.equal(event.producer_id, producer, scenario.id);
      assert.equal(event.run_id, runId, scenario.id);
      const occurred = Date.parse(event.occurred_at);
      if (indexInFile === 0) assert.equal(occurred, origin, scenario.id);
      assert.ok(occurred > previous, scenario.id);
      previous = occurred;
      if (event.type === 'run.started') {
        assert.equal(event.payload.simulated, true, scenario.id);
        assert.equal(event.payload.name?.startsWith('模拟：'), true, scenario.id);
      }
    }
    assert.equal(events.filter(event => event.type === 'run.started').length, 1, scenario.id);
    const store = new EventStore(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-scenario-')));
    for (const event of events) assert.equal(store.ingest(event).accepted, true, scenario.id);
    assert.equal(store.runs.size, 1, scenario.id);
    const run = store.runs.get(runId)!;
    assert.equal(run.simulated, true, scenario.id);
    assert.equal(run.name.startsWith('模拟：'), true, scenario.id);
    assert.deepEqual(observed(run), scenario.expect, scenario.id);
    assertShape(scenario, events, run);
  }
});

function assertShape(scenario: Scenario, events: MonitorEvent[], run: RunState) {
  if (scenario.id === 'normal') {
    const resolved = events.find(event => event.type === 'decision.resolved');
    assert.ok(resolved?.payload.probabilities);
    const values = Object.values(resolved.payload.probabilities);
    assert.equal(Math.max(...values), 0.86);
    assert.equal(events.find(event => event.type === 'verification.completed')?.payload.result, 'passed');
  }
  if (scenario.id === 'dispersed') {
    const resolved = events.filter(event => event.type === 'decision.resolved');
    assert.equal(new Set(resolved.map(event => event.request_id)).size, 1);
    assert.deepEqual(
      resolved.map(event => event.question_id),
      ['next', 'danger', 'goal_reached'],
    );
    const choice = resolved.find(event => event.payload.kind === 'choice');
    assert.deepEqual(
      Object.values(choice?.payload.probabilities ?? {}).sort((a, b) => a - b),
      [0.33, 0.33, 0.34],
    );
    const score = resolved.find(event => event.payload.kind === 'score');
    assert.equal(score?.question_id, 'danger');
    assert.equal(typeof score?.payload.legend, 'object');
    const noul = resolved.find(event => event.payload.kind === 'noul');
    assert.equal(noul?.question_id, 'goal_reached');
    assert.equal(noul?.payload.confidence, undefined);
    assert.equal(noul?.payload.probabilities, undefined);
  }
  if (scenario.id === 'rule-override') {
    const resolved = events.find(event => event.type === 'decision.resolved');
    const selected = events.find(event => event.type === 'action.selected');
    assert.equal(resolved?.payload.choice, 'a');
    assert.equal(selected?.payload.action, 'b');
    assert.equal(selected?.payload.source, 'rule');
    assert.equal(typeof selected?.payload.rule, 'string');
    assert.equal(typeof selected?.payload.rule_source, 'string');
    assert.equal(selected?.decision_id, resolved?.decision_id);
    assert.equal(events.find(event => event.type === 'verification.completed')?.payload.result, 'passed');
  }
  if (scenario.id === 'retry') {
    const failed = events.find(event => event.type === 'action.failed');
    assert.equal(failed?.payload.reason, 'timeout');
    const selected = events.filter(event => event.type === 'action.selected');
    assert.equal(selected.length, 2);
    assert.equal(selected[0].action_id, selected[1].action_id);
    assert.notEqual(selected[0].attempt_id, selected[1].attempt_id);
    assert.equal(selected[1].payload.retry, 1);
    const passed = events.find(event => event.type === 'verification.completed');
    assert.equal(passed?.attempt_id, selected[1].attempt_id);
    assert.equal(passed?.payload.result, 'passed');
  }
  if (scenario.id === 'verify-failed') {
    const completed = events.find(event => event.type === 'action.completed');
    const verification = events.find(event => event.type === 'verification.completed');
    assert.ok(completed && verification && verification.sequence > completed.sequence);
    assert.equal(verification.payload.result, 'failed');
    assert.ok(
      verification.payload.checks?.every(check => check.observed.length > 0 && (check.evidence ?? '').length > 0),
    );
    assert.equal(
      events.some(
        event => event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled',
      ),
      false,
    );
  }
  if (scenario.id === 'reconnect') {
    const index = scenario.pause_after_index;
    assert.equal(typeof index, 'number');
    assert.equal(typeof scenario.pause_ms, 'number');
    assert.ok((scenario.pause_ms ?? 0) > 30000);
    assert.equal(events[index as number].type, 'heartbeat');
    assert.ok(events.slice(1, (index as number) + 1).every(event => event.type === 'heartbeat'));
    assert.equal(events[(index as number) + 1].type, 'telemetry.dropped');
    assert.equal(events[(index as number) + 1].payload.count, 3);
    assert.equal(run.dropped, 3);
  } else {
    assert.equal(scenario.pause_after_index, null);
    assert.equal(scenario.pause_ms, null);
  }
  if (scenario.id === 'concurrent') {
    const started = events.filter(event => event.type === 'decision.started');
    assert.equal(started.length, 2);
    assert.equal(started[0].request_id, started[1].request_id);
    assert.notEqual(started[0].question_id, started[1].question_id);
    const firstResolved = events.findIndex(event => event.type === 'decision.resolved');
    assert.ok(
      firstResolved >
        events.findIndex(event => event.decision_id === started[1].decision_id && event.type === 'decision.started'),
    );
    const rule = events.find(event => event.type === 'action.selected' && event.payload.source === 'rule');
    assert.equal(rule?.decision_id, undefined);
    assert.equal(typeof rule?.payload.rule, 'string');
    assert.equal(typeof rule?.payload.rule_source, 'string');
  }
}

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {eventTypes, validateEvent, type MonitorEvent} from '../src/protocol';
import {EventStore} from '../src/store';
import {
  BODY_LIMIT,
  HEAVY_MIN_BYTES,
  LoadGenerator,
  conflictOf,
  heavyDecisionPair,
  invalidBody,
  malformedBody,
  oversizeBody,
} from '../scripts/loadtest/generator';
import {parseDuration, percentile, summarize} from '../scripts/loadtest/stats';

const clock = () => {
  let t = Date.UTC(2026, 8, 30);
  return () => new Date((t += 50));
};

function generate(count: number, heavyRatio = 0.05) {
  const generator = new LoadGenerator({seed: 7, events: count, runs: 320, heavyRatio, now: clock()});
  return {generator, events: Array.from({length: count}, () => generator.next())};
}

test('every generated load event passes the protocol validator and stays under 64 KiB', () => {
  const {events} = generate(4000);
  const sizes = events.map(event => Buffer.byteLength(JSON.stringify(event)));
  for (const event of events) assert.doesNotThrow(() => validateEvent(structuredClone(event)), event.event_id);
  assert.ok(Math.max(...sizes) <= BODY_LIMIT);
  assert.ok(sizes.filter(size => size >= HEAVY_MIN_BYTES - 500).length >= 10, 'expected near-limit events');
  assert.equal(new Set(events.map(e => e.event_id)).size, events.length);
});

test('the load mix covers every event type, primitive, override, retry and >200 runs', () => {
  const {events, generator} = generate(4000);
  const types = new Set(events.map(e => e.type));
  for (const type of eventTypes) assert.ok(types.has(type), type);
  const kinds = new Set(events.filter(e => e.type === 'decision.resolved').map(e => e.payload.kind));
  assert.deepEqual([...kinds].sort(), ['choice', 'noul', 'score']);
  const sources = new Set(events.filter(e => e.type === 'action.selected').map(e => e.payload.source));
  assert.deepEqual([...sources].sort(), ['application', 'model', 'rule']);
  assert.ok(events.some(e => e.type === 'action.selected' && e.attempt_id === 't2' && e.payload.retry === 1));
  const perRequest = new Map<string, Set<string>>();
  for (const e of events.filter(e => e.type === 'decision.started')) {
    const key = `${e.run_id}/${e.request_id}`;
    perRequest.set(key, (perRequest.get(key) ?? new Set()).add(e.question_id!));
  }
  assert.ok(
    [...perRequest.values()].some(questions => questions.size >= 2),
    'expected multi-question requests',
  );
  const results = new Set(events.filter(e => e.type === 'verification.completed').map(e => e.payload.result));
  assert.deepEqual([...results].sort(), ['failed', 'passed', 'unknown']);
  assert.ok(new Set(events.map(e => e.run_id)).size > 200);
  assert.equal(generator.marathonIds.length, 1);
  // Sequences grow per producer, as a real sender's would.
  const last = new Map<string, number>();
  for (const e of events) {
    assert.ok(e.sequence > (last.get(e.producer_id) ?? 0));
    last.set(e.producer_id, e.sequence);
  }
});

test('rejected bodies are rejected, and the store accepts the generated stream', () => {
  const {events} = generate(1500, 0.02);
  const base = events[0];
  assert.ok(Buffer.byteLength(oversizeBody(base)) > BODY_LIMIT);
  assert.throws(() => JSON.parse(malformedBody(base)));
  for (let variant = 0; variant < 5; variant++) {
    assert.throws(() => validateEvent(JSON.parse(invalidBody(base, variant))), `variant ${variant}`);
  }
  const store = new EventStore(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-loadtest-')));
  for (const event of events) assert.equal(store.ingest(event).accepted, true, event.event_id);
  assert.deepEqual(store.ingest(events[10]), {accepted: false, cursor: events.length});
  const conflict = conflictOf(events[11], 1);
  assert.doesNotThrow(() => validateEvent(structuredClone(conflict)));
  assert.equal((store.ingest(conflict) as {conflict?: boolean}).conflict, true);
  assert.ok(store.runs.size <= 200);
});

test('the worst-case probe pair is valid and near the size limit', () => {
  const [started, resolved]: MonitorEvent[] = heavyDecisionPair(
    'lt-probe-1',
    'lt-probe-host-1',
    3,
    new Date(0).toISOString(),
  );
  validateEvent(structuredClone(started));
  validateEvent(structuredClone(resolved));
  const size = Buffer.byteLength(JSON.stringify(started));
  assert.ok(size >= HEAVY_MIN_BYTES && size <= BODY_LIMIT, String(size));
  assert.equal(started.sequence + 1, resolved.sequence);
});

test('load statistics helpers', () => {
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
  assert.deepEqual(summarize([]), {count: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0});
  assert.equal(parseDuration('30m'), 1_800_000);
  assert.equal(parseDuration('90s'), 90_000);
  assert.equal(parseDuration('250ms'), 250);
  assert.throws(() => parseDuration('soon'));
});

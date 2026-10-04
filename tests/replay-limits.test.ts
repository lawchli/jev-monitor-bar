import assert from 'node:assert/strict';
import test from 'node:test';
import {validateEvent} from '../src/protocol';
import {sanitizeEvent} from '../src/redact';
import {parseReplay, REPLAY_EVENT_LIMIT} from '../src/replay';

const parsers = {validateEvent, sanitizeEvent};
const line = (sequence: number) =>
  JSON.stringify({
    schema_version: 1,
    event_id: `limit-${sequence}`,
    run_id: 'run-1',
    producer_id: 'host-1',
    sequence,
    occurred_at: '2026-10-04T13:00:00.000Z',
    type: 'heartbeat',
    payload: {},
  });

test('replay retention limits stay bounded for nonfinite and oversized values', () => {
  const source = Array.from({length: REPLAY_EVENT_LIMIT + 3}, (_, index) => line(index + 1)).join('\n');
  for (const limit of [Number.NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER, REPLAY_EVENT_LIMIT + 1]) {
    const result = parseReplay(source, parsers, limit);
    assert.equal(result.events.length, REPLAY_EVENT_LIMIT, `limit=${limit}`);
    assert.equal(result.omitted, 3);
    assert.equal(result.truncated, true);
    assert.equal(result.invalidLines, 0);
    assert.equal(result.events[0].event_id, 'limit-4');
    assert.equal(result.events.at(-1)?.event_id, `limit-${REPLAY_EVENT_LIMIT + 3}`);
  }
});

test('replay retention normalizes fractions and nonpositive limits without changing invalid-line counts', () => {
  const source = [line(1), 'not-json', line(2), '{', line(3), line(4), line(5)].join('\n');
  for (const [limit, expected] of [
    [0, 1],
    [-20, 1],
    [0.9, 1],
    [1.9, 1],
    [2.9, 2],
    [5, 5],
  ]) {
    const result = parseReplay(source, parsers, limit);
    assert.equal(result.events.length, expected, `limit=${limit}`);
    assert.equal(result.omitted, 5 - expected);
    assert.equal(result.truncated, expected < 5);
    assert.equal(result.invalidLines, 2);
    assert.deepEqual(
      result.events.map(event => event.event_id),
      Array.from({length: expected}, (_, index) => `limit-${6 - expected + index}`),
    );
  }
});

test('only retained replay events are sanitized after the normalized bound is reached', () => {
  let sanitized = 0;
  const result = parseReplay(
    [line(1), line(2), line(3)].join('\n'),
    {
      validateEvent,
      sanitizeEvent(event, diagnostics) {
        sanitized++;
        return sanitizeEvent(event, diagnostics);
      },
    },
    0,
  );
  assert.equal(sanitized, 1);
  assert.equal(result.events[0].event_id, 'limit-3');
  assert.equal(result.omitted, 2);
});

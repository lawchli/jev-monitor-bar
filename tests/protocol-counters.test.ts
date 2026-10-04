import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {schema, validateEvent, type MonitorEvent} from '../src/protocol';
import {EventStore} from '../src/store';
import {sanitizeEvent} from '../src/redact';
import {parseReplay} from '../src/replay';

const counters = ['completed', 'total', 'count', 'retry'] as const;

function event(payload: Record<string, unknown> = {}): unknown {
  return {
    schema_version: 1,
    event_id: 'event-1',
    run_id: 'run-1',
    producer_id: 'host-1',
    sequence: 1,
    occurred_at: '2026-01-01T00:00:01.000Z',
    type: 'heartbeat',
    payload,
  };
}

test('payload counters accept only nonnegative safe integers in both the runtime and exported schema', () => {
  for (const key of counters) {
    assert.deepEqual(schema.properties.payload.properties[key], {
      type: 'integer',
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    });
    for (const value of [0, 1, 42, Number.MAX_SAFE_INTEGER]) {
      assert.doesNotThrow(() => validateEvent(event({[key]: value})), `${key}=${value}`);
    }
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, 1e308, NaN, Infinity, -Infinity]) {
      assert.throws(() => validateEvent(event({[key]: value})), `${key}=${value}`);
    }
  }
});

test('unsafe payload counters never reach disk or recovered state', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-protocol-counter-'));
  const store = new EventStore(directory);
  try {
    for (const key of counters) {
      for (const value of [Number.MAX_SAFE_INTEGER + 1, 1e308]) {
        assert.throws(() => store.ingest(event({[key]: value})), `${key}=${value}`);
      }
    }
    assert.equal(store.cursor, 0);
    assert.equal(store.events.length, 0);
    assert.equal(store.runs.size, 0);
    assert.equal(store.exportLines().text, '');
    assert.deepEqual(fs.readdirSync(directory), []);
    store.close();
    const recovered = new EventStore(directory);
    try {
      assert.equal(recovered.cursor, 0);
      assert.equal(recovered.events.length, 0);
      assert.equal(recovered.corruptLines, 0);
    } finally {
      recovered.close();
    }
  } finally {
    store.close();
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

test('safe payload counter boundaries survive JSON, storage, export and replay without changing numeric fields', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-protocol-counter-'));
  const store = new EventStore(directory);
  const payload = {
    completed: Number.MAX_SAFE_INTEGER,
    total: Number.MAX_SAFE_INTEGER,
    count: Number.MAX_SAFE_INTEGER,
    retry: Number.MAX_SAFE_INTEGER,
    score: 0.75,
    latency_ms: 1.5,
    usage: {input_tokens: 3.5},
  };
  try {
    const row = event(payload);
    validateEvent(row);
    assert.deepEqual((JSON.parse(JSON.stringify(row)) as MonitorEvent).payload, payload);
    assert.equal(store.ingest(row).accepted, true);
    store.close();
    const recovered = new EventStore(directory);
    try {
      assert.equal(recovered.corruptLines, 0);
      assert.deepEqual(recovered.events[0].payload, payload);
      const exported = recovered.exportLines();
      const replay = parseReplay(exported.text, {validateEvent, sanitizeEvent});
      assert.equal(replay.invalidLines, 0);
      assert.deepEqual(replay.events[0].payload, payload);
      for (const key of counters) {
        const invalid = event({[key]: Number.MAX_SAFE_INTEGER + 1});
        assert.equal(parseReplay(JSON.stringify(invalid), {validateEvent, sanitizeEvent}).invalidLines, 1);
      }
    } finally {
      recovered.close();
    }
  } finally {
    store.close();
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

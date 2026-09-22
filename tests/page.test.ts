import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventStore} from '../src/store';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jev-page-'));

function event(n: number, runId = 'run-1', type = 'heartbeat') {
  return {
    schema_version: 1,
    event_id: `e${runId}-${n}`,
    run_id: runId,
    producer_id: 'host-1',
    sequence: n,
    occurred_at: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
    type,
    payload: type === 'run.started' ? {name: runId, simulated: true} : {},
  };
}

function fill(store: EventStore, count: number, runId = 'run-1', type = 'heartbeat') {
  for (let n = 1; n <= count; n++) assert.equal(store.ingest(event(n, runId, type)).accepted, true);
}

test('page defaults to the newest 100 events in ascending cursor order', () => {
  const store = new EventStore(tempDir());
  fill(store, 120);
  const rows = store.page();
  assert.equal(rows.length, 100);
  assert.deepEqual(
    rows.map(row => row.cursor),
    Array.from({length: 100}, (_value, index) => index + 21),
  );
});

test('page clamps limit to 1..500 and honors beforeCursor and runId', () => {
  const store = new EventStore(tempDir());
  fill(store, 3, 'run-a', 'run.started');
  fill(store, 3, 'run-b', 'heartbeat');
  assert.equal(store.page({limit: 0}).length, 1);
  const wide = new EventStore(tempDir());
  fill(wide, 510);
  assert.equal(wide.page({limit: 501}).length, 500);
  assert.equal(wide.page({limit: 500}).at(-1)?.cursor, 510);
  const limited = store.page({limit: 2});
  assert.deepEqual(
    limited.map(row => row.cursor),
    [5, 6],
  );
  assert.deepEqual(
    store.page({beforeCursor: 4}).map(row => row.cursor),
    [1, 2, 3],
  );
  assert.deepEqual(
    store.page({runId: 'run-a'}).map(row => row.run_id),
    ['run-a', 'run-a', 'run-a'],
  );
  assert.deepEqual(
    store.page({runId: 'run-b', beforeCursor: 6, limit: 10}).map(row => row.cursor),
    [4, 5],
  );
  assert.deepEqual(store.page({beforeCursor: undefined, runId: undefined}).length, 6);
});

test('page reads only the in-memory window', () => {
  const store = new EventStore(tempDir(), 3);
  fill(store, 5);
  assert.deepEqual(
    store.page({limit: 500}).map(row => row.cursor),
    [3, 4, 5],
  );
});

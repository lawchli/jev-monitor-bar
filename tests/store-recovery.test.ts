import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventStore} from '../src/store';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jev-monitor-'));

function writeSegment(dir: string, body: string) {
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'events-00000001.jsonl'), body);
}

test('a damaged tail and a schema-invalid line do not reuse their cursors', () => {
  const dir = tempDir();
  const valid = {
    schema_version: 1,
    event_id: 'e1',
    run_id: 'run-1',
    producer_id: 'host-1',
    sequence: 1,
    occurred_at: '2026-01-01T00:00:00.000Z',
    type: 'heartbeat',
    payload: {},
    received_at: '2026-01-01T00:00:01.000Z',
    cursor: 1,
  };
  const lines = [
    JSON.stringify(valid),
    JSON.stringify({...valid, event_id: 'e-schema', sequence: 2, type: 'not-an-event', cursor: 5}),
    JSON.stringify({...valid, event_id: 'e-torn', sequence: 3, cursor: 4, received_at: 4}),
    JSON.stringify({cursor: '12'}),
    '{"cursor":99',
    '',
  ].join('\n');
  writeSegment(dir, lines);
  const store = new EventStore(dir);
  assert.equal(store.cursor, 5);
  assert.equal(store.corruptLines, 4);
  assert.equal(store.events.length, 1);
  const next = store.ingest({
    schema_version: 1,
    event_id: 'e-next',
    run_id: 'run-1',
    producer_id: 'host-1',
    sequence: 2,
    occurred_at: '2026-01-01T00:00:04.000Z',
    type: 'heartbeat',
    payload: {},
  });
  assert.deepEqual(next, {accepted: true, cursor: 6});
});

function stored(cursor: number, runId: string, type: 'run.started' | 'run.completed', received: string) {
  return JSON.stringify({
    schema_version: 1,
    event_id: `e${cursor}`,
    run_id: runId,
    producer_id: 'host-1',
    sequence: 1,
    occurred_at: received,
    type,
    payload: type === 'run.started' ? {name: runId} : {},
    received_at: received,
    cursor,
  });
}

test('eviction keeps running runs and drops the earliest ended run', () => {
  const dir = tempDir();
  const rows = [
    stored(1, 'run-live-old', 'run.started', '2026-01-01T00:00:00.000Z'),
    stored(2, 'run-ended-late', 'run.completed', '2026-01-01T00:00:10.000Z'),
    stored(3, 'run-ended-early', 'run.completed', '2026-01-01T00:00:01.000Z'),
  ];
  for (let i = 4; i <= 201; i++) rows.push(stored(i, `run-live-${i}`, 'run.started', '2026-01-01T00:00:02.000Z'));
  writeSegment(dir, rows.join('\n') + '\n');
  const store = new EventStore(dir);
  assert.equal(store.runs.size, 200);
  assert.equal(store.runs.has('run-live-old'), true);
  assert.equal(store.runs.has('run-ended-late'), true);
  assert.equal(store.runs.has('run-ended-early'), false);
  assert.equal(store.runs.has('run-live-201'), true);
});

test('eviction drops the earliest run when every run is still running', () => {
  const dir = tempDir();
  const rows = [
    stored(1, 'run-newest', 'run.started', '2026-01-02T00:00:00.000Z'),
    stored(2, 'run-oldest', 'run.started', '2026-01-01T00:00:00.000Z'),
  ];
  for (let i = 3; i <= 201; i++) rows.push(stored(i, `run-mid-${i}`, 'run.started', '2026-01-01T12:00:00.000Z'));
  writeSegment(dir, rows.join('\n') + '\n');
  const store = new EventStore(dir);
  assert.equal(store.runs.size, 200);
  assert.equal(store.runs.has('run-newest'), true);
  assert.equal(store.runs.has('run-oldest'), false);
  assert.equal(store.runs.has('run-mid-201'), true);
});

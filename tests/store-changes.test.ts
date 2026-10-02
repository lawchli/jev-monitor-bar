import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as wait} from 'node:timers/promises';
import test from 'node:test';
import type {Changed} from '../src/ipc';
import {EventStore} from '../src/store';
import {subscribeStoreChanges} from '../src/main/store-changes';

function fakeStore(cursor = 0) {
  return Object.assign(new EventEmitter(), {cursor}) as EventStore;
}

test('recovery without any new accepted event reaches the UI notification path', async () => {
  const store = fakeStore(4194307);
  const changes: Changed[] = [];
  const dispose = subscribeStoreChanges(store, change => changes.push(change), 1);
  try {
    store.emit('recovered', {cursor: 1, runIds: ['restored-run']});
    await wait(20);
    assert.deepEqual(changes, [{cursor: 4194307, runIds: ['restored-run']}]);
  } finally {
    dispose();
  }
});

test('event and metadata recovery share one batch, deduplicate runs, and use the current cursor', async () => {
  const store = fakeStore(10);
  const changes: Changed[] = [];
  const dispose = subscribeStoreChanges(store, change => changes.push(change), 5);
  try {
    store.emit('event', {cursor: 10, run_id: 'new-run'});
    store.emit('recovered', {cursor: 2, runIds: ['old-run', 'new-run']});
    store.cursor = 11;
    store.emit('event', {cursor: 11, run_id: 'new-run'});
    await wait(30);
    assert.deepEqual(changes, [{cursor: 11, runIds: ['new-run', 'old-run']}]);
    store.cursor = 12;
    store.emit('recovered', {cursor: 12, runIds: []});
    await wait(30);
    assert.deepEqual(changes[1], {cursor: 12, runIds: []});
  } finally {
    dispose();
  }
});

test('disposing a store subscription removes both listeners and cancels pending changes', async () => {
  const store = fakeStore(1);
  const changes: Changed[] = [];
  const dispose = subscribeStoreChanges(store, change => changes.push(change), 5);
  store.emit('event', {cursor: 1, run_id: 'run'});
  dispose();
  dispose();
  assert.equal(store.listenerCount('event'), 0);
  assert.equal(store.listenerCount('recovered'), 0);
  store.emit('recovered', {cursor: 1, runIds: ['run']});
  await wait(30);
  assert.deepEqual(changes, []);
});

for (const conflict of [false, true]) {
  test(`an unlocked segment refreshes the UI even when the retry is ${conflict ? 'a sequence conflict' : 'a duplicate'}`, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-store-changes-'));
    const original = {
      schema_version: 1,
      event_id: 'original-event',
      run_id: 'recovered-run',
      producer_id: 'producer',
      sequence: 1,
      occurred_at: '2026-10-03T00:00:00.000Z',
      type: 'heartbeat',
      payload: {},
    };
    const seeded = new EventStore(dir);
    seeded.ingest(original);
    seeded.close();
    let locked = true;
    const read = fs.readFileSync;
    t.mock.method(fs, 'readFileSync', ((file: fs.PathOrFileDescriptor, options?: unknown) => {
      if (locked && file === path.join(dir, 'events-00000001.jsonl'))
        throw Object.assign(new Error('simulated scanner lock'), {code: 'EBUSY'});
      return read(file, options as BufferEncoding);
    }) as typeof fs.readFileSync);
    const store = new EventStore(dir);
    const changes: Changed[] = [];
    const dispose = subscribeStoreChanges(store, change => changes.push(change), 1);
    try {
      assert.deepEqual(store.snapshot().runs, []);
      locked = false;
      const later = Date.now() + 2000;
      t.mock.method(Date, 'now', () => later);
      const result = store.ingest(conflict ? {...original, event_id: 'conflicting-event'} : original);
      assert.equal(result.accepted, false);
      assert.equal(result.conflict, conflict ? true : undefined);
      await wait(20);
      assert.deepEqual(changes, [{cursor: store.cursor, runIds: ['recovered-run']}]);
      assert.equal(store.snapshot().runs[0]?.id, 'recovered-run');
      assert.equal(store.events.length, 1);
      assert.equal(store.exportLines().text.trim().split('\n').length, 1);
    } finally {
      dispose();
      store.close();
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });
}

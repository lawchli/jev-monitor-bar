import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {EventStore} from '../src/store';
import {startServer} from '../src/server';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jev-writes-'));
let n = 0;
function event(runId = 'run-1', type = 'heartbeat') {
  n++;
  return {
    schema_version: 1,
    event_id: `w${n}`,
    run_id: runId,
    producer_id: 'host-1',
    sequence: n,
    occurred_at: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, n)).toISOString(),
    type,
    payload: {},
  };
}

// Captured before any test mocks readdirSync, so the tests' own listings are not counted.
const listDir = fs.readdirSync;
function segments(dir: string) {
  return listDir(dir)
    .filter(f => /^events-\d{8}\.jsonl$/.test(f))
    .sort();
}

function cursorsOnDisk(dir: string) {
  return segments(dir).flatMap(f =>
    fs
      .readFileSync(path.join(dir, f), 'utf8')
      .split('\n')
      .filter(line => line.length > 0)
      .map(line => JSON.parse(line).cursor as number),
  );
}

const busy = (code: string) => Object.assign(new Error(`simulated ${code}`), {code});

test('ingest across rotations writes every line exactly once and opens each segment once', t => {
  const dir = tempDir();
  const open = t.mock.method(fs, 'openSync');
  const close = t.mock.method(fs, 'closeSync');
  const store = new EventStore(dir, undefined, 1024, 100);
  for (let i = 0; i < 30; i++) assert.equal(store.ingest(event()).accepted, true);
  const files = segments(dir);
  assert.ok(files.length >= 5, `expected several segments, got ${files.length}`);
  for (const f of files) assert.ok(fs.statSync(path.join(dir, f)).size <= 1024, f);
  assert.deepEqual(
    cursorsOnDisk(dir),
    Array.from({length: 30}, (_value, index) => index + 1),
  );
  const segmentOpens = open.mock.calls.filter(call =>
    /^events-\d{8}\.jsonl$/.test(path.basename(String(call.arguments[0]))),
  );
  assert.equal(segmentOpens.length, files.length);
  // Reservation temp files close immediately; only the active segment stays open until close().
  const totalOpens = open.mock.callCount();
  assert.equal(close.mock.callCount(), totalOpens - 1);
  store.close();
  assert.equal(close.mock.callCount(), totalOpens);
  store.close();
  assert.equal(close.mock.callCount(), totalOpens);
});

test('restart after rotations recovers every retained event', () => {
  const dir = tempDir();
  const store = new EventStore(dir, undefined, 1024, 3);
  for (let i = 0; i < 40; i++) store.ingest(event());
  store.close();
  const files = segments(dir);
  assert.equal(files.length, 3);
  const onDisk = cursorsOnDisk(dir);
  assert.equal(onDisk.at(-1), 40);
  const restored = new EventStore(dir, undefined, 1024, 3);
  assert.equal(restored.corruptLines, 0);
  assert.equal(restored.cursor, 40);
  assert.deepEqual(
    restored.events.map(e => e.cursor),
    onDisk,
  );
  assert.deepEqual(restored.ingest(event()), {accepted: true, cursor: 41});
  const next = segments(dir).at(-1)!;
  assert.equal(Number(next.slice(7, 15)), Number(files.at(-1)!.slice(7, 15)) + 1);
});

test('a failed write is not acknowledged, closes the segment, and the next ingest reopens it', t => {
  const dir = tempDir();
  const store = new EventStore(dir);
  assert.equal(store.ingest(event()).accepted, true);
  const write = t.mock.method(fs, 'writeSync');
  const close = t.mock.method(fs, 'closeSync');
  write.mock.mockImplementationOnce(() => {
    throw busy('EBUSY');
  });
  const failed = event();
  assert.throws(() => store.ingest(failed), {code: 'EBUSY'});
  assert.equal(store.cursor, 1);
  assert.equal(store.events.length, 1);
  assert.equal(close.mock.callCount(), 1);
  assert.deepEqual(store.ingest(failed), {accepted: true, cursor: 2});
  assert.deepEqual(cursorsOnDisk(dir), [1, 2]);
  assert.equal(segments(dir).length, 1);
});

test('a partly written line is left in its own segment, and restart keeps every acknowledged event', t => {
  const dir = tempDir();
  const store = new EventStore(dir);
  store.ingest(event());
  const real = fs.writeSync;
  const write = t.mock.method(fs, 'writeSync');
  const at = write.mock.callCount();
  // The OS accepts half the line, then the disk fills up.
  const half = (fd: number, data: NodeJS.ArrayBufferView, offset?: number | null, length?: number | null) =>
    real(fd, data, offset, Math.floor((length ?? 0) / 2));
  write.mock.mockImplementationOnce(half as typeof fs.writeSync, at);
  write.mock.mockImplementationOnce(() => {
    throw busy('ENOSPC');
  }, at + 1);
  assert.throws(() => store.ingest(event()), {code: 'ENOSPC'});
  // The failed event's cursor is burned, because part of its line is on disk.
  assert.deepEqual(store.ingest(event()), {accepted: true, cursor: 3});
  const files = segments(dir);
  assert.equal(files.length, 2);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, files[0]), 'utf8'), /\n$/);
  const restored = new EventStore(dir);
  assert.equal(restored.corruptLines, 1);
  assert.deepEqual(
    restored.events.map(e => e.cursor),
    [1, 3],
  );
});

test('a line written except its newline does not share a cursor with the next event after restart', t => {
  const dir = tempDir();
  const store = new EventStore(dir);
  store.ingest(event());
  const real = fs.writeSync;
  const write = t.mock.method(fs, 'writeSync');
  const at = write.mock.callCount();
  // Everything but the trailing newline lands, then the write fails.
  const allButNewline = (fd: number, data: NodeJS.ArrayBufferView, offset?: number | null, length?: number | null) =>
    real(fd, data, offset, (length ?? 1) - 1);
  write.mock.mockImplementationOnce(allButNewline as typeof fs.writeSync, at);
  write.mock.mockImplementationOnce(() => {
    throw busy('EIO');
  }, at + 1);
  const lost = event();
  assert.throws(() => store.ingest(lost), {code: 'EIO'});
  const next = event();
  assert.deepEqual(store.ingest(next), {accepted: true, cursor: 3});
  const restored = new EventStore(dir);
  const cursors = restored.events.map(e => e.cursor);
  assert.equal(new Set(cursors).size, cursors.length);
  assert.deepEqual(
    restored.events.map(e => e.event_id),
    ['w' + (n - 2), lost.event_id, next.event_id],
  );
});

test('the receiver answers a failed write with 503 and accepts the retry', async t => {
  const dir = tempDir();
  const store = new EventStore(path.join(dir, 'events'));
  const srv = await startServer(store, path.join(dir, 'session.json'));
  const post = (body: string) =>
    new Promise<{status: number; body: string}>((resolve, reject) => {
      const req = http.request(
        srv.session.url + '/events',
        {
          method: 'POST',
          headers: {'content-type': 'application/json', authorization: `Bearer ${srv.session.token}`},
        },
        res => {
          const chunks: Buffer[] = [];
          res.on('data', chunk => chunks.push(chunk));
          res.on('end', () => resolve({status: res.statusCode!, body: Buffer.concat(chunks).toString('utf8')}));
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  try {
    const write = t.mock.method(fs, 'writeSync');
    write.mock.mockImplementationOnce(() => {
      throw busy('EBUSY');
    });
    const body = JSON.stringify(event());
    assert.deepEqual(await post(body), {status: 503, body: JSON.stringify({error: 'Storage unavailable'})});
    assert.equal(store.cursor, 0);
    assert.deepEqual(await post(body), {status: 200, body: JSON.stringify({accepted: true, cursor: 1})});
    assert.deepEqual(cursorsOnDisk(path.join(dir, 'events')), [1]);
  } finally {
    await srv.close();
    store.close();
  }
});

test('old segments are listed at startup and on rotation, not for every event', t => {
  const dir = tempDir();
  const readdir = t.mock.method(fs, 'readdirSync');
  const store = new EventStore(dir, undefined, 1024, 2);
  const atStart = readdir.mock.callCount();
  assert.equal(atStart, 2);
  const sizes: number[] = [];
  for (let i = 0; i < 20; i++) {
    store.ingest(event());
    sizes.push(segments(dir).length);
  }
  const listed = readdir.mock.callCount() - atStart;
  // One listing per new segment, including the first one after startup.
  const created = Number(segments(dir).at(-1)!.slice(7, 15));
  assert.equal(listed, created);
  assert.ok(listed < 20 / 2, `listed ${listed} times for 20 events`);
  assert.ok(Math.max(...sizes) <= 2);
});

test('a locked old segment is tried again after a pause, not on every event', t => {
  const dir = tempDir();
  const first = new EventStore(dir, undefined, 1024, 1);
  first.ingest(event());
  first.close();
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const unlink = t.mock.method(fs, 'unlinkSync', () => {
    throw busy('EBUSY');
  });
  const readdir = t.mock.method(fs, 'readdirSync');
  const store = new EventStore(dir, undefined, 4 * 1024 * 1024, 1);
  store.ingest(event());
  const afterFirst = {listed: readdir.mock.callCount(), unlinks: unlink.mock.callCount()};
  assert.ok(afterFirst.unlinks > 0);
  for (let i = 0; i < 50; i++) store.ingest(event());
  assert.equal(readdir.mock.callCount(), afterFirst.listed);
  assert.equal(unlink.mock.callCount(), afterFirst.unlinks);
  now += 1500;
  store.ingest(event());
  assert.equal(readdir.mock.callCount(), afterFirst.listed + 1);
  assert.equal(unlink.mock.callCount(), afterFirst.unlinks + 1);
  unlink.mock.restore();
  now += 1500;
  store.ingest(event());
  assert.deepEqual(segments(dir), [segments(dir).at(-1)]);
  store.ingest(event());
  assert.equal(readdir.mock.callCount(), afterFirst.listed + 2);
});

test('dropped-run marks stay bounded and keep runs that are still listed', () => {
  const store = new EventStore(tempDir(), 3);
  const dropped = (store as unknown as {droppedRuns: Set<string>}).droppedRuns;
  assert.equal(store.ingest(event('run-live', 'run.started')).accepted, true);
  for (let i = 0; i < 600; i++) store.ingest(event(`run-ended-${i}`, 'run.completed'));
  assert.ok(dropped.size <= 200, `droppedRuns has ${dropped.size} entries`);
  assert.equal(store.runs.has('run-live'), true);
  // Its only event left the window at the start and it is still listed, so the timeline says so.
  assert.equal(store.historyTruncated({runId: 'run-live', beforeCursor: 1}), true);
  assert.equal(store.historyTruncated({runId: 'run-ended-590', beforeCursor: 1}), true);
  // A run no longer listed whose events aged out long ago loses its mark first.
  assert.equal(store.runs.has('run-ended-0'), false);
  assert.equal(store.historyTruncated({runId: 'run-ended-0', beforeCursor: 1}), false);
  assert.equal(store.historyTruncated({beforeCursor: 1}), true);
});

test('an unlinked active descriptor is replaced before acknowledging the next event', t => {
  const dir = tempDir();
  const store = new EventStore(dir);
  store.ingest(event());
  const stat = fs.fstatSync;
  let removed = true;
  t.mock.method(fs, 'fstatSync', ((fd: number, options?: fs.StatOptions) => {
    const result = stat(fd, options);
    if (removed) {
      removed = false;
      return {...result, nlink: 0};
    }
    return result;
  }) as typeof fs.fstatSync);
  assert.deepEqual(store.ingest(event()), {accepted: true, cursor: 2});
  assert.equal(segments(dir).length, 2);
  store.close();
  const restored = new EventStore(dir);
  assert.deepEqual(
    restored.events.map(row => row.cursor),
    [1, 2],
  );
  restored.close();
});

test(
  'external deletion of the active segment does not send later acknowledged rows into an invisible file',
  {
    skip:
      process.platform === 'win32' &&
      'Windows normally refuses deleting an open descriptor; nlink handling is mocked above',
  },
  () => {
    const dir = tempDir();
    const store = new EventStore(dir);
    store.ingest(event());
    fs.unlinkSync(path.join(dir, segments(dir)[0]));
    const second = event();
    assert.deepEqual(store.ingest(second), {accepted: true, cursor: 2});
    store.close();
    assert.deepEqual(cursorsOnDisk(dir), [2]);
    const restored = new EventStore(dir);
    assert.equal(restored.events[0].event_id, second.event_id);
    assert.equal(restored.cursor, 2);
    restored.close();
  },
);

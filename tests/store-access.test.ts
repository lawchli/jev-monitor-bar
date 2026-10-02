import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createMonitorHandlers, type RendererContents} from '../src/main/ipc-api';
import {EventStore, type RecoveredChange} from '../src/store';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jev-access-'));
let n = 0;
function event() {
  n++;
  return {
    schema_version: 1,
    event_id: `a${n}`,
    run_id: 'run-1',
    producer_id: 'host-1',
    sequence: n,
    occurred_at: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, n)).toISOString(),
    type: 'heartbeat',
    payload: {},
  };
}

const segment = (number: number) => `events-${String(number).padStart(8, '0')}.jsonl`;

/** One app start: a new segment with `count` events. */
function start(dir: string, count: number) {
  const store = new EventStore(dir);
  for (let i = 0; i < count; i++) assert.equal(store.ingest(event()).accepted, true);
  store.close();
}

/** Reads of one segment fail with `code`, as when a scanner holds it; the first `times` reads only, if given. */
function lock(t: TestContext, name: string, code: string, times = Infinity) {
  const real = fs.readFileSync;
  let left = times;
  return t.mock.method(fs, 'readFileSync', ((file: fs.PathOrFileDescriptor, options?: unknown) => {
    if (typeof file === 'string' && path.basename(file) === name && left-- > 0) {
      throw Object.assign(new Error(`simulated ${code}`), {code});
    }
    return real(file, options as BufferEncoding);
  }) as typeof fs.readFileSync);
}

const cursorsIn = (text: string) =>
  text
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line).cursor as number);

test('a segment that stays locked is skipped at startup and in export, and its cursors are not reused', async t => {
  const dir = tempDir();
  start(dir, 3);
  start(dir, 3);
  const read = lock(t, segment(2), 'EBUSY');
  const store = new EventStore(dir);
  assert.deepEqual(store.unreadableSegments, [segment(2)]);
  // One read and two short retries, then the segment is skipped.
  assert.equal(read.mock.calls.filter(call => String(call.arguments[0]).endsWith(segment(2))).length, 3);
  assert.deepEqual(
    store.events.map(e => e.cursor),
    [1, 2, 3],
  );
  // The skipped segment held cursors 4–6, the highest on disk.
  const next = store.ingest(event());
  assert.equal(next.accepted, true);
  assert.ok(next.cursor > 6, `cursor ${next.cursor} may already be on disk`);

  const exported = store.exportLines();
  assert.equal(exported.unreadable, 1);
  assert.equal(exported.skipped, 0);
  assert.deepEqual(cursorsIn(exported.text), [1, 2, 3, next.cursor]);
  const frame = {url: 'file:///renderer/index.html'};
  const contents: RendererContents = {mainFrame: frame};
  const handlers = createMonitorHandlers({
    store,
    controller: {setMode: mode => mode, setPinned: pinned => pinned},
    getStatus: () => {
      throw new Error('unused');
    },
    rendererUrl: frame.url,
    contents,
  });
  const result = await handlers.exportEvents(
    {sender: contents, senderFrame: frame},
    {
      saveDialog: async () => '/tmp/partial.jsonl',
      openDialog: async () => undefined,
      readBounded: () => ({ok: true, text: ''}),
      write: () => {},
    },
  );
  assert.equal(result.unreadable, 1);
  store.close();

  read.mock.restore();
  const restored = new EventStore(dir);
  assert.deepEqual(restored.unreadableSegments, []);
  assert.deepEqual(
    restored.events.map(e => e.cursor),
    [1, 2, 3, 4, 5, 6, next.cursor],
  );
});

test('a skipped segment followed by a readable one leaves the cursor where the readable one ends', t => {
  const dir = tempDir();
  start(dir, 3);
  start(dir, 3);
  lock(t, segment(1), 'EACCES');
  const store = new EventStore(dir);
  assert.deepEqual(store.unreadableSegments, [segment(1)]);
  // Cursors grow with the segment number, so segment 2 already outranks everything in segment 1.
  assert.equal(store.cursor, 6);
  assert.deepEqual(store.ingest(event()), {accepted: true, cursor: 7});
});

test('a segment locked only for a moment is read after a short wait', t => {
  const dir = tempDir();
  start(dir, 3);
  start(dir, 3);
  lock(t, segment(2), 'EBUSY', 2);
  const store = new EventStore(dir);
  assert.deepEqual(store.unreadableSegments, []);
  assert.equal(store.cursor, 6);
  assert.equal(store.events.length, 6);
  assert.equal(store.exportLines().unreadable, 0);
});

test('a directory named like a segment is skipped instead of failing startup and export', () => {
  const dir = tempDir();
  start(dir, 3);
  fs.mkdirSync(path.join(dir, segment(2)));
  const store = new EventStore(dir);
  assert.deepEqual(store.unreadableSegments, [segment(2)]);
  assert.deepEqual(
    store.events.map(e => e.cursor),
    [1, 2, 3],
  );
  const next = store.ingest(event());
  assert.ok(next.cursor > 3);
  assert.ok(fs.existsSync(path.join(dir, segment(3))));
  const exported = store.exportLines();
  assert.equal(exported.unreadable, 1);
  assert.deepEqual(cursorsIn(exported.text), [1, 2, 3, next.cursor]);
});

const posixOnly = {skip: process.platform === 'win32' && 'Windows ignores POSIX modes; the profile ACLs apply'};

test('a new events directory is created 0700 and its segments 0600', posixOnly, () => {
  const home = path.join(tempDir(), 'home');
  const dir = path.join(home, 'events');
  start(dir, 1);
  assert.equal(fs.statSync(home).mode & 0o777, 0o700);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, segment(1))).mode & 0o777, 0o600);
});

test('an existing events directory and its segments are tightened at startup', posixOnly, () => {
  const dir = tempDir();
  start(dir, 2);
  fs.chmodSync(dir, 0o755);
  fs.chmodSync(path.join(dir, segment(1)), 0o644);
  const store = new EventStore(dir);
  assert.equal(store.events.length, 2);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, segment(1))).mode & 0o777, 0o600);
});

test('successive restarts with different unreadable tails never reuse cursors after a reservation jump', t => {
  const dir = tempDir();
  start(dir, 3);
  start(dir, 3);
  const firstLock = lock(t, segment(2), 'EBUSY');
  const first = new EventStore(dir);
  const jumped = first.ingest(event());
  assert.ok(jumped.cursor > 6);
  first.close();
  firstLock.mock.restore();
  const secondLock = lock(t, segment(3), 'EPERM');
  const second = new EventStore(dir);
  const next = second.ingest(event());
  assert.ok(next.cursor > jumped.cursor, `cursor ${next.cursor} reused the unreadable tail at ${jumped.cursor}`);
  second.close();
  secondLock.mock.restore();
  const restored = new EventStore(dir);
  const cursors = restored.events.map(row => row.cursor);
  assert.equal(new Set(cursors).size, cursors.length);
  assert.ok(cursors.includes(jumped.cursor));
  assert.ok(cursors.includes(next.cursor));
  restored.close();
});

test('unreadable cursor metadata and tail delay writes until a safe high-water mark is readable', t => {
  const dir = tempDir();
  start(dir, 3);
  start(dir, 3);
  const real = fs.readFileSync;
  let reservationLocked = true;
  t.mock.method(fs, 'readFileSync', ((file: fs.PathOrFileDescriptor, options?: unknown) => {
    const name = typeof file === 'string' ? path.basename(file) : '';
    if (name === segment(2) || (name === 'cursor-reservation.json' && reservationLocked))
      throw Object.assign(new Error('locked high-water data'), {code: 'EBUSY'});
    return real(file, options as BufferEncoding);
  }) as typeof fs.readFileSync);
  const store = new EventStore(dir);
  assert.match(store.storageError ?? '', /暂缓写入/);
  const next = event();
  assert.throws(() => store.ingest(next), {code: 'EBUSY'});
  assert.equal(store.events.length, 3);
  assert.equal(fs.existsSync(path.join(dir, segment(3))), false);
  reservationLocked = false;
  const accepted = store.ingest(next);
  assert.equal(accepted.accepted, true);
  assert.ok(accepted.cursor > 6);
  store.close();
});

test('malformed or missing reservations never make an unreadable legacy tail silently lose cursor safety', t => {
  const dir = tempDir();
  start(dir, 3);
  start(dir, 3);
  fs.writeFileSync(path.join(dir, 'cursor-reservation.json'), '{');
  const read = lock(t, segment(2), 'EBUSY');
  const store = new EventStore(dir);
  const next = event();
  assert.throws(() => store.ingest(next), {code: 'EBUSY'});
  read.mock.restore();
  assert.deepEqual(store.ingest(next), {accepted: true, cursor: 7});
  store.close();
  fs.unlinkSync(path.join(dir, 'cursor-reservation.json'));
  const legacyLock = lock(t, segment(3), 'EPERM');
  const legacy = new EventStore(dir);
  assert.throws(() => legacy.ingest(event()), {code: 'EBUSY'});
  legacyLock.mock.restore();
  assert.equal(legacy.ingest(event()).cursor, 8);
  legacy.close();
});

test('cursor reservations are written once per segment before acknowledgements and retry failures safely', t => {
  const dir = tempDir();
  const store = new EventStore(dir, undefined, 2048);
  const real = fs.renameSync;
  let fail = true;
  const rename = t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    if (path.basename(String(to)) === 'cursor-reservation.json' && fail)
      throw Object.assign(new Error('reservation locked'), {code: 'EBUSY'});
    return real(from, to);
  });
  const first = event();
  assert.throws(() => store.ingest(first), {code: 'EBUSY'});
  assert.equal(store.cursor, 0);
  assert.equal(store.events.length, 0);
  assert.equal(fs.existsSync(path.join(dir, segment(1))), false);
  fail = false;
  assert.deepEqual(store.ingest(first), {accepted: true, cursor: 1});
  for (let i = 0; i < 30; i++) store.ingest(event());
  store.close();
  const written = rename.mock.calls.filter(
    call => path.basename(String(call.arguments[1])) === 'cursor-reservation.json',
  );
  assert.equal(written.length - 1, fs.readdirSync(dir).filter(file => /^events-/.test(file)).length);
  assert.equal(fs.readdirSync(dir).filter(file => file.endsWith('.tmp')).length, 0);
});

test('an oversized single row remains below its segment reservation', t => {
  const dir = tempDir();
  const store = new EventStore(dir, undefined, 1, 8);
  const first = store.ingest(event());
  const read = lock(t, segment(2), 'EBUSY');
  store.close();
  const restored = new EventStore(dir, undefined, 1, 8);
  assert.ok(restored.cursor > first.cursor);
  assert.ok(restored.ingest(event()).cursor > first.cursor);
  restored.close();
  read.mock.restore();
  const complete = new EventStore(dir, undefined, 1, 8);
  assert.equal(new Set(complete.events.map(row => row.cursor)).size, complete.events.length);
  complete.close();
});

test('a completely torn newest row uses its existing reservation instead of reusing the acknowledged cursor', () => {
  const dir = tempDir();
  start(dir, 3);
  const file = path.join(dir, segment(1));
  const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
  fs.writeFileSync(file, lines.slice(0, -1).join('\n') + '\n{"cursor":');
  const store = new EventStore(dir);
  assert.equal(store.corruptLines, 1);
  assert.ok(store.cursor > 3);
  const next = store.ingest(event());
  assert.ok(next.cursor > 3);
  store.close();
});

test('a torn newest row and unreadable reservation defer ingestion until the reservation is readable', t => {
  const dir = tempDir();
  start(dir, 3);
  const file = path.join(dir, segment(1));
  const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
  fs.writeFileSync(file, lines.slice(0, -1).join('\n') + '\n{"cursor":');
  const read = lock(t, 'cursor-reservation.json', 'EBUSY');
  const store = new EventStore(dir);
  const next = event();
  assert.throws(() => store.ingest(next), {code: 'EBUSY'});
  assert.throws(() => store.ingest(next), {code: 'EBUSY'});
  assert.deepEqual(store.unreadableSegments, []);
  assert.equal(store.events.length, 2);
  assert.equal(fs.existsSync(path.join(dir, segment(2))), false);
  assert.match(store.storageError ?? '', /尾行损坏/);
  const changes: RecoveredChange[] = [];
  store.on('recovered', (change: RecoveredChange) => changes.push(change));
  const {received_at: _received, cursor: _cursor, ...retry} = store.events[0];
  read.mock.restore();
  assert.equal(store.ingest(retry).accepted, false);
  assert.ok(store.cursor > 3);
  assert.deepEqual(
    changes,
    [{cursor: store.cursor, runIds: []}],
    'a restored high-water mark is visible without a new run',
  );
  assert.ok(store.ingest(next).cursor > 3);
  assert.equal(store.storageError, undefined);
  store.close();
});

test('a retry recovered from an unlocked startup segment is deduplicated before writing', t => {
  const dir = tempDir();
  const original = event();
  const first = new EventStore(dir);
  first.ingest(original);
  first.close();
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const read = lock(t, segment(1), 'EBUSY');
  const store = new EventStore(dir);
  const changes: RecoveredChange[] = [];
  let newEvents = 0;
  store.on('recovered', (change: RecoveredChange) => changes.push(change));
  store.on('event', () => newEvents++);
  assert.equal(store.events.length, 0);
  const highWater = store.cursor;
  read.mock.restore();
  now += 1500;
  assert.deepEqual(store.ingest(original), {accepted: false, cursor: highWater});
  assert.equal(store.events.length, 1);
  assert.deepEqual(changes, [{cursor: highWater, runIds: [original.run_id]}]);
  assert.equal(newEvents, 0, 'recovering an acknowledged row is not a newly accepted event');
  assert.deepEqual(store.ingest(original), {accepted: false, cursor: highWater});
  assert.equal(changes.length, 1, 'retries after successful recovery do not repeat notifications');
  assert.equal(fs.existsSync(path.join(dir, segment(2))), false);
  const rows = store
    .exportLines()
    .text.trim()
    .split('\n')
    .map(line => JSON.parse(line));
  assert.deepEqual(
    rows.map(row => row.event_id),
    [original.event_id],
  );
  store.close();
});

test('a producer sequence recovered from an unlocked segment rejects a new event id as conflict', t => {
  const dir = tempDir();
  const original = event();
  const first = new EventStore(dir);
  first.ingest(original);
  first.close();
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const read = lock(t, segment(1), 'EBUSY');
  const store = new EventStore(dir);
  const changes: RecoveredChange[] = [];
  let newEvents = 0;
  store.on('recovered', (change: RecoveredChange) => changes.push(change));
  store.on('event', () => newEvents++);
  const highWater = store.cursor;
  read.mock.restore();
  now += 1500;
  const retry = {...original, event_id: 'recovered-sequence-conflict'};
  assert.deepEqual(store.ingest(retry), {accepted: false, conflict: true, cursor: store.cursor});
  assert.equal(store.events.length, 1);
  assert.deepEqual(changes, [{cursor: highWater, runIds: [original.run_id]}]);
  assert.equal(newEvents, 0);
  assert.deepEqual(store.ingest(retry), {accepted: false, conflict: true, cursor: highWater});
  assert.equal(changes.length, 1);
  assert.equal(fs.existsSync(path.join(dir, segment(2))), false);
  assert.ok(!store.exportLines().text.includes(retry.event_id));
  store.close();
});

test('a startup-skipped segment is incorporated in cursor order when its lock clears without a restart', t => {
  const dir = tempDir();
  start(dir, 3);
  start(dir, 3);
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const read = lock(t, segment(2), 'EBUSY');
  const store = new EventStore(dir);
  const changes: RecoveredChange[] = [];
  store.on('recovered', (change: RecoveredChange) => changes.push(change));
  const jumped = store.ingest(event());
  const latestReceived = store.runs.get('run-1')?.last_received;
  assert.equal(store.events.length, 4);
  read.mock.restore();
  now += 1500;
  const next = store.ingest(event());
  assert.deepEqual(store.unreadableSegments, []);
  assert.equal(store.storageError, undefined);
  assert.deepEqual(changes, [{cursor: jumped.cursor, runIds: ['run-1']}], 'a batch lists each changed run only once');
  assert.deepEqual(
    store.events.map(row => row.cursor),
    [1, 2, 3, 4, 5, 6, jumped.cursor, next.cursor],
  );
  assert.equal(store.runs.get('run-1')?.event_count, 8);
  assert.ok((store.runs.get('run-1')?.last_received ?? '') >= (latestReceived ?? ''));
  store.close();
});

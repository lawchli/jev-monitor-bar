import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test, type TestContext} from 'node:test';
import {REPLAY_MAX_BYTES} from '../src/replay';
import {readReplayFile} from '../src/main/replay-files';

function fixture(t: TestContext, contents: string | Buffer = ''): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-replay-files-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, contents);
  return file;
}

function trackCloses(t: TestContext): number[] {
  const closed: number[] = [];
  const original = fs.closeSync;
  t.mock.method(fs, 'closeSync', (fd: number) => {
    closed.push(fd);
    original(fd);
  });
  return closed;
}

test('replay file reads empty and exact byte-limit files and rejects the next byte', t => {
  const file = fixture(t);
  assert.deepEqual(readReplayFile(file, 0), {ok: true, text: ''});
  fs.writeFileSync(file, '中文ab');
  assert.deepEqual(readReplayFile(file, 8), {ok: true, text: '中文ab'});
  assert.deepEqual(readReplayFile(file, 7), {ok: false, reason: 'too-large'});
  const closed = trackCloses(t);
  fs.truncateSync(file, REPLAY_MAX_BYTES + 1);
  const before = closed.length;
  t.mock.method(fs, 'readSync', () => {
    assert.fail('an oversized file must be rejected before reading');
  });
  assert.deepEqual(readReplayFile(file), {ok: false, reason: 'too-large'});
  assert.equal(closed.length - before, 1);
});

test('the replay cap still holds when the selected regular file grows after fstat', t => {
  const file = fixture(t, 'small');
  const originalStat = fs.fstatSync;
  t.mock.method(fs, 'fstatSync', (fd: number) => {
    const stat = originalStat(fd);
    fs.appendFileSync(file, 'x'.repeat(100));
    return stat;
  });
  const originalRead = fs.readSync;
  let bytes = 0;
  t.mock.method(
    fs,
    'readSync',
    (fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => {
      const count = originalRead(fd, buffer, offset, Math.min(length, 3), position);
      bytes += count;
      return count;
    },
  );
  const closed = trackCloses(t);
  assert.deepEqual(readReplayFile(file, 16), {ok: false, reason: 'too-large'});
  assert.equal(bytes, 17);
  assert.equal(closed.length, 1);
});

test('path replacement after open does not change the replay descriptor being checked and read', t => {
  const file = fixture(t, 'original');
  const originalOpen = fs.openSync;
  let opened: number | undefined;
  let replaced = false;
  t.mock.method(fs, 'openSync', (selected: fs.PathLike, flags: string | number) => {
    const fd = originalOpen(selected, flags);
    if (selected === file && !replaced) {
      replaced = true;
      opened = fd;
      fs.renameSync(file, `${file}.old`);
      fs.writeFileSync(file, 'replacement exceeds the small cap');
    }
    return fd;
  });
  const inspected: number[] = [];
  const originalStat = fs.fstatSync;
  t.mock.method(fs, 'fstatSync', (fd: number) => {
    inspected.push(fd);
    return originalStat(fd);
  });
  const closed = trackCloses(t);
  assert.deepEqual(readReplayFile(file, 8), {ok: true, text: 'original'});
  assert.deepEqual(inspected, [opened]);
  assert.equal(closed.filter(fd => fd === opened).length, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), 'replacement exceeds the small cap');
});

test('UTF-8 decoding matches readFile across chunk boundaries and partial reads', t => {
  const text = `${'a'.repeat(64 * 1024 - 1)}中文🙂\r\n`;
  const contents = Buffer.concat([Buffer.from(text), Buffer.from([0xe2, 0x82, 0xff, 0xf0, 0x9f])]);
  const file = fixture(t, contents);
  const expected = fs.readFileSync(file, 'utf8');
  assert.deepEqual(readReplayFile(file), {ok: true, text: expected});
  const originalRead = fs.readSync;
  t.mock.method(fs, 'readSync', (fd: number, buffer: Buffer, offset: number, length: number, position: number | null) =>
    originalRead(fd, buffer, offset, Math.min(length, 2), position),
  );
  assert.deepEqual(readReplayFile(file), {ok: true, text: expected});
});

test('missing files and non-files fail without leaking a successfully opened descriptor', t => {
  const file = fixture(t);
  const closed = trackCloses(t);
  const missing = readReplayFile(`${file}.missing`);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.reason, 'read-error');
  assert.equal(closed.length, 0);
  const directory = readReplayFile(path.dirname(file));
  assert.equal(directory.ok, false);
  if (!directory.ok) assert.equal(directory.reason, 'read-error');
  // Windows may reject opening a directory before a descriptor is allocated.
  assert.ok(closed.length <= 1);
});

test('fstat and read errors close the replay descriptor and return the read error', t => {
  const file = fixture(t, 'keep');
  const closed = trackCloses(t);
  const originalStat = fs.fstatSync;
  const statMock = t.mock.method(fs, 'fstatSync', () => {
    throw new Error('stat failed');
  });
  assert.deepEqual(readReplayFile(file), {ok: false, reason: 'read-error', message: 'stat failed'});
  assert.equal(closed.length, 1);
  statMock.mock.restore();
  t.mock.method(fs, 'fstatSync', originalStat);
  t.mock.method(fs, 'readSync', () => {
    throw new Error('read failed');
  });
  assert.deepEqual(readReplayFile(file), {ok: false, reason: 'read-error', message: 'read failed'});
  assert.equal(closed.length, 2);
});

test('replay file truncation during reading returns only bytes actually read', t => {
  const file = fixture(t, 'before truncation');
  const originalRead = fs.readSync;
  let calls = 0;
  t.mock.method(
    fs,
    'readSync',
    (fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => {
      calls += 1;
      if (calls === 1) fs.truncateSync(file, 3);
      return originalRead(fd, buffer, offset, length, position);
    },
  );
  assert.deepEqual(readReplayFile(file), {ok: true, text: 'bef'});
});

test('a failed descriptor close is reported without throwing from replay read', t => {
  const file = fixture(t, 'ok');
  const originalClose = fs.closeSync;
  let closes = 0;
  t.mock.method(fs, 'closeSync', (fd: number) => {
    closes += 1;
    originalClose(fd);
    throw new Error('close failed');
  });
  assert.deepEqual(readReplayFile(file), {ok: false, reason: 'read-error', message: 'close failed'});
  assert.equal(closes, 1);
});

test('invalid replay byte caps are rejected before opening a file', t => {
  const file = fixture(t);
  t.mock.method(fs, 'openSync', () => {
    assert.fail('an invalid limit must not open a file');
  });
  for (const cap of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual(readReplayFile(file, cap), {
      ok: false,
      reason: 'read-error',
      message: 'Invalid replay byte limit',
    });
  }
});

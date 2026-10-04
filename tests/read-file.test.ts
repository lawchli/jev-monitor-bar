import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test, type TestContext} from 'node:test';
import {readBoundedTextFile} from '../src/read-file';

function fixture(t: TestContext, contents: string | Buffer = ''): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-bounded-read-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'input');
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

test('bounded text reads empty and exact-cap files and rejects oversized sparse files before reading', t => {
  const file = fixture(t);
  assert.equal(readBoundedTextFile(file, 0), '');
  fs.writeFileSync(file, '中文ab');
  assert.equal(readBoundedTextFile(file, 8), '中文ab');
  assert.throws(() => readBoundedTextFile(file, 7), /File exceeds byte limit/);
  fs.truncateSync(file, 1024 * 1024 * 1024);
  const closed = trackCloses(t);
  t.mock.method(fs, 'readSync', () => assert.fail('an oversized file must not be read'));
  assert.throws(() => readBoundedTextFile(file, 16 * 1024), /File exceeds byte limit/);
  assert.equal(closed.length, 1);
});

test('bounded text reads at most cap plus one byte when a file grows after descriptor inspection', t => {
  const file = fixture(t, 'small');
  const originalStat = fs.fstatSync;
  let inspected: number | undefined;
  t.mock.method(fs, 'fstatSync', (fd: number) => {
    inspected = fd;
    const stat = originalStat(fd);
    fs.truncateSync(file, 1024 * 1024 * 1024);
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
  assert.throws(() => readBoundedTextFile(file, 16), /File exceeds byte limit/);
  assert.equal(bytes, 17);
  assert.equal(closed.filter(fd => fd === inspected).length, 1);
});

test('bounded text checks and reads the opened file even when its path is replaced', t => {
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
      fs.writeFileSync(file, 'replacement exceeds the cap');
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
  assert.equal(readBoundedTextFile(file, 8), 'original');
  assert.deepEqual(inspected, [opened]);
  assert.equal(closed.filter(fd => fd === opened).length, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), 'replacement exceeds the cap');
});

test('bounded text preserves UTF-8 decoding through chunk boundaries, short reads, and a torn final character', t => {
  const text = `${'a'.repeat(4095)}中文🙂\r\n`;
  const contents = Buffer.concat([Buffer.from(text), Buffer.from([0xe2, 0x82, 0xff, 0xf0, 0x9f])]);
  const file = fixture(t, contents);
  const expected = fs.readFileSync(file, 'utf8');
  assert.equal(readBoundedTextFile(file, contents.length), expected);
  const originalRead = fs.readSync;
  t.mock.method(fs, 'readSync', (fd: number, buffer: Buffer, offset: number, length: number, position: number | null) =>
    originalRead(fd, buffer, offset, Math.min(length, 2), position),
  );
  assert.equal(readBoundedTextFile(file, contents.length), expected);
});

test('bounded text rejects directories and missing files and closes allocated descriptors', t => {
  const file = fixture(t);
  const closed = trackCloses(t);
  assert.throws(() => readBoundedTextFile(`${file}.missing`, 100), {code: 'ENOENT'});
  assert.equal(closed.length, 0);
  assert.throws(() => readBoundedTextFile(path.dirname(file), 100));
  // Windows may reject directory open before allocating a descriptor.
  assert.ok(closed.length <= 1);
});

test('bounded text preserves read and stat errnos while closing descriptors on failure', t => {
  const file = fixture(t, 'read me');
  const closed = trackCloses(t);
  const error = Object.assign(new Error('locked'), {code: 'EPERM'});
  const statMock = t.mock.method(fs, 'fstatSync', () => {
    throw error;
  });
  assert.throws(
    () => readBoundedTextFile(file, 100),
    seen => seen === error,
  );
  assert.equal(closed.length, 1);
  statMock.mock.restore();
  t.mock.method(fs, 'readSync', () => {
    throw error;
  });
  assert.throws(
    () => readBoundedTextFile(file, 100),
    seen => seen === error,
  );
  assert.equal(closed.length, 2);
});

test('bounded text reports close failures and keeps an earlier read error when both fail', t => {
  const file = fixture(t, 'ok');
  const originalClose = fs.closeSync;
  const closeError = new Error('close failed');
  let closes = 0;
  t.mock.method(fs, 'closeSync', (fd: number) => {
    closes++;
    originalClose(fd);
    throw closeError;
  });
  assert.throws(
    () => readBoundedTextFile(file, 2),
    seen => seen === closeError,
  );
  const readError = Object.assign(new Error('read locked'), {code: 'EBUSY'});
  t.mock.method(fs, 'readSync', () => {
    throw readError;
  });
  assert.throws(
    () => readBoundedTextFile(file, 2),
    seen => seen === readError,
  );
  assert.equal(closes, 2);
});

test('bounded text reads only bytes that remain if the file shrinks after inspection', t => {
  const file = fixture(t, 'before truncation');
  const originalRead = fs.readSync;
  let calls = 0;
  t.mock.method(
    fs,
    'readSync',
    (fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => {
      if (++calls === 1) fs.truncateSync(file, 3);
      return originalRead(fd, buffer, offset, length, position);
    },
  );
  assert.equal(readBoundedTextFile(file, 100), 'bef');
});

test('bounded text rejects invalid caps before opening a file', t => {
  const file = fixture(t);
  t.mock.method(fs, 'openSync', () => assert.fail('invalid caps must not open a file'));
  for (const cap of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => readBoundedTextFile(file, cap), /Invalid file byte limit/);
  }
});

test('a real FIFO without a writer is rejected without blocking', {skip: os.platform() === 'win32'}, t => {
  const file = fixture(t);
  fs.unlinkSync(file);
  const created = spawnSync('mkfifo', [file], {encoding: 'utf8'});
  assert.equal(created.status, 0, created.stderr);
  const reader = path.resolve(__dirname, '../src/read-file.ts');
  const script = `const {readBoundedTextFile} = require(${JSON.stringify(reader)}); try { readBoundedTextFile(${JSON.stringify(file)}, 100); process.exitCode = 1; } catch (error) { if (error.message !== 'Expected a regular file') throw error; }`;
  const checked = spawnSync(process.execPath, ['--import', 'tsx', '-e', script], {encoding: 'utf8', timeout: 5000});
  assert.equal(checked.error, undefined);
  assert.equal(checked.status, 0, checked.stderr);
});

import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test, type TestContext} from 'node:test';
import {defaultWindowState, loadWindowState, WINDOW_STATE_MAX_BYTES} from '../src/main/window-state';
import {readSessionFile, removeSessionFileIfOwned, SESSION_MAX_BYTES, writeSessionFile} from '../src/session';

function fixture(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-local-json-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return path.join(dir, 'data.json');
}

function paddedJson(value: unknown, bytes: number): string {
  const text = JSON.stringify(value);
  return text + ' '.repeat(bytes - Buffer.byteLength(text));
}

test('session reads and owned cleanup accept the exact byte cap and leave oversized files untouched', t => {
  const file = fixture(t);
  const session = {url: 'http://127.0.0.1:9', token: 'ours', note: '中文'};
  const exact = paddedJson(session, SESSION_MAX_BYTES);
  fs.writeFileSync(file, exact);
  assert.deepEqual(readSessionFile(file), {url: session.url, token: session.token});
  removeSessionFileIfOwned(file, 'ours');
  assert.equal(fs.existsSync(file), false);

  const oversized = `${exact} `;
  fs.writeFileSync(file, oversized);
  assert.equal(readSessionFile(file), undefined);
  removeSessionFileIfOwned(file, 'ours');
  assert.equal(fs.readFileSync(file, 'utf8'), oversized);
});

test('window-state reads use a byte cap and fall back for oversized or nonregular inputs', t => {
  const file = fixture(t);
  const state = defaultWindowState();
  const exact = paddedJson({...state, note: '中文'}, WINDOW_STATE_MAX_BYTES);
  fs.writeFileSync(file, exact);
  assert.deepEqual(loadWindowState(file), state);
  fs.appendFileSync(file, ' ');
  assert.equal(loadWindowState(file), undefined);
  assert.equal(loadWindowState(path.dirname(file)), undefined);
  fs.truncateSync(file, 1024 * 1024 * 1024);
  assert.equal(loadWindowState(file), undefined);
});

test('session cleanup leaves malformed, incomplete, foreign-owner, and nonregular inputs untouched', t => {
  const file = fixture(t);
  for (const contents of [
    '{',
    'null',
    JSON.stringify({url: 'http://127.0.0.1:9'}),
    JSON.stringify({token: 'theirs'}),
  ]) {
    fs.writeFileSync(file, contents);
    removeSessionFileIfOwned(file, 'ours');
    assert.equal(fs.readFileSync(file, 'utf8'), contents);
  }
  assert.equal(readSessionFile(path.dirname(file)), undefined);
  removeSessionFileIfOwned(path.dirname(file), 'ours');
  assert.equal(fs.statSync(path.dirname(file)).isDirectory(), true);
});

test('owned session cleanup retries descriptor read locks and stops if ownership changes', t => {
  const file = fixture(t);
  writeSessionFile(file, {url: 'http://127.0.0.1:9', token: 'ours'});
  const originalRead = fs.readSync;
  const originalClose = fs.closeSync;
  let reads = 0;
  let closed = 0;
  const readMock = t.mock.method(
    fs,
    'readSync',
    (fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => {
      reads++;
      if (reads <= 2) throw Object.assign(new Error('locked'), {code: reads === 1 ? 'EPERM' : 'EBUSY'});
      return originalRead(fd, buffer, offset, length, position);
    },
  );
  t.mock.method(fs, 'closeSync', (fd: number) => {
    closed++;
    originalClose(fd);
  });
  removeSessionFileIfOwned(file, 'ours');
  assert.equal(fs.existsSync(file), false);
  assert.equal(closed, 3);
  readMock.mock.restore();

  writeSessionFile(file, {url: 'http://127.0.0.1:9', token: 'ours'});
  reads = 0;
  t.mock.method(
    fs,
    'readSync',
    (fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => {
      if (++reads === 1) {
        fs.writeFileSync(file, JSON.stringify({url: 'http://127.0.0.1:9', token: 'theirs'}));
        throw Object.assign(new Error('locked'), {code: 'EACCES'});
      }
      return originalRead(fd, buffer, offset, length, position);
    },
  );
  removeSessionFileIfOwned(file, 'ours');
  assert.equal(readSessionFile(file)?.token, 'theirs');
});

test('session cleanup reports exhausted descriptor lock retries without deleting the file', t => {
  const file = fixture(t);
  writeSessionFile(file, {url: 'http://127.0.0.1:9', token: 'ours'});
  const original = fs.readSync;
  let reads = 0;
  t.mock.method(fs, 'readSync', () => {
    reads++;
    throw Object.assign(new Error('locked'), {code: 'EBUSY'});
  });
  assert.throws(() => removeSessionFileIfOwned(file, 'ours'), {code: 'EBUSY'});
  assert.equal(reads, 6);
  assert.equal(fs.existsSync(file), true);
  t.mock.method(fs, 'readSync', original);
  assert.equal(readSessionFile(file)?.token, 'ours');
});

test(
  'local JSON reads and owned session cleanup reject a FIFO without waiting for a writer',
  {skip: os.platform() === 'win32'},
  t => {
    const file = fixture(t);
    const created = spawnSync('mkfifo', [file], {encoding: 'utf8'});
    assert.equal(created.status, 0, created.stderr);
    const sessionModule = path.resolve(__dirname, '../src/session.ts');
    const windowModule = path.resolve(__dirname, '../src/main/window-state.ts');
    const script = `const assert = require('node:assert/strict'); const fs = require('node:fs'); const session = require(${JSON.stringify(sessionModule)}); const windowState = require(${JSON.stringify(windowModule)}); const file = ${JSON.stringify(file)}; assert.equal(session.readSessionFile(file), undefined); assert.equal(windowState.loadWindowState(file), undefined); session.removeSessionFileIfOwned(file, 'ours'); assert.equal(fs.lstatSync(file).isFIFO(), true);`;
    const checked = spawnSync(process.execPath, ['--import', 'tsx', '-e', script], {encoding: 'utf8', timeout: 5000});
    assert.equal(checked.error, undefined);
    assert.equal(checked.status, 0, checked.stderr);
  },
);

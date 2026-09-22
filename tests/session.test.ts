import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventStore} from '../src/store';
import {startServer} from '../src/server';
import {readSessionFile, removeSessionFileIfOwned, writeSessionFile} from '../src/session';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jev-monitor-'));

test('rewriting a 0644 session file leaves mode 0600 on POSIX', () => {
  const file = path.join(tempDir(), 'session.json');
  fs.writeFileSync(file, JSON.stringify({url: 'http://127.0.0.1:1', token: 'old'}), {mode: 0o644});
  if (os.platform() !== 'win32') {
    fs.chmodSync(file, 0o644);
    assert.equal(fs.statSync(file).mode & 0o777, 0o644);
  }
  writeSessionFile(file, {url: 'http://127.0.0.1:9', token: 'new-token'});
  assert.deepEqual(readSessionFile(file), {url: 'http://127.0.0.1:9', token: 'new-token'});
  if (os.platform() !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('rename succeeds after throwing EPERM twice', t => {
  const dir = tempDir();
  const file = path.join(dir, 'session.json');
  const original = fs.renameSync;
  let calls = 0;
  t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    calls += 1;
    if (calls <= 2) throw Object.assign(new Error('locked'), {code: 'EPERM'});
    return original(from, to);
  });
  writeSessionFile(file, {url: 'http://127.0.0.1:9', token: 'tok'});
  assert.equal(calls, 3);
  assert.deepEqual(readSessionFile(file), {url: 'http://127.0.0.1:9', token: 'tok'});
  assert.deepEqual(
    fs.readdirSync(dir).filter(name => name.endsWith('.tmp')),
    [],
  );
});

test('readSessionFile returns undefined when the file is missing, corrupt, or incomplete', () => {
  const dir = tempDir();
  assert.equal(readSessionFile(path.join(dir, 'missing.json')), undefined);
  const corrupt = path.join(dir, 'corrupt.json');
  fs.writeFileSync(corrupt, '{');
  assert.equal(readSessionFile(corrupt), undefined);
  const incomplete = path.join(dir, 'incomplete.json');
  fs.writeFileSync(incomplete, JSON.stringify({url: 'http://127.0.0.1:1'}));
  assert.equal(readSessionFile(incomplete), undefined);
});

test('closing the server deletes its session file and leaves another owner in place', async () => {
  const dir = tempDir();
  const mine = path.join(dir, 'session.json');
  const other = path.join(dir, 'other.json');
  fs.writeFileSync(other, JSON.stringify({url: 'http://127.0.0.1:1', token: 'someone-else'}));
  const store = new EventStore(path.join(dir, 'events'));
  const srv = await startServer(store, mine);
  assert.equal(readSessionFile(mine)?.token, srv.session.token);
  await srv.close();
  assert.equal(fs.existsSync(mine), false);
  assert.equal(readSessionFile(other)?.token, 'someone-else');

  const replaced = path.join(dir, 'replaced.json');
  const again = await startServer(store, replaced);
  fs.writeFileSync(replaced, JSON.stringify({url: 'http://127.0.0.1:2', token: 'other-owner'}));
  await again.close();
  assert.equal(readSessionFile(replaced)?.token, 'other-owner');
});

test('owned removal retries Windows lock errors and then deletes', t => {
  const file = path.join(tempDir(), 'session.json');
  writeSessionFile(file, {url: 'http://127.0.0.1:9', token: 'ours'});
  const original = fs.unlinkSync;
  const codes = ['EPERM', 'EBUSY', 'EACCES'];
  let calls = 0;
  t.mock.method(fs, 'unlinkSync', (target: fs.PathLike) => {
    calls += 1;
    if (calls <= codes.length) throw Object.assign(new Error('locked'), {code: codes[calls - 1]});
    return original(target);
  });
  removeSessionFileIfOwned(file, 'ours');
  assert.equal(calls, 4);
  assert.equal(fs.existsSync(file), false);
});

test('owned removal ignores ENOENT after the token check', t => {
  const file = path.join(tempDir(), 'session.json');
  writeSessionFile(file, {url: 'http://127.0.0.1:9', token: 'ours'});
  t.mock.method(fs, 'unlinkSync', () => {
    throw Object.assign(new Error('gone'), {code: 'ENOENT'});
  });
  assert.doesNotThrow(() => removeSessionFileIfOwned(file, 'ours'));
  assert.equal(readSessionFile(file)?.token, 'ours');
});

test('owned removal stops when the token changes during a lock retry', t => {
  const file = path.join(tempDir(), 'session.json');
  writeSessionFile(file, {url: 'http://127.0.0.1:9', token: 'ours'});
  let calls = 0;
  t.mock.method(fs, 'unlinkSync', () => {
    calls += 1;
    fs.writeFileSync(file, JSON.stringify({url: 'http://127.0.0.1:1', token: 'theirs'}));
    throw Object.assign(new Error('locked'), {code: 'EPERM'});
  });
  removeSessionFileIfOwned(file, 'ours');
  assert.equal(calls, 1);
  assert.equal(readSessionFile(file)?.token, 'theirs');
});

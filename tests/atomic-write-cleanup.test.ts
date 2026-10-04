import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {defaultWindowState, saveWindowState} from '../src/main/window-state';
import {writeSessionFile} from '../src/session';

const writers = [
  {name: 'session', write: (file: string) => writeSessionFile(file, {url: 'http://127.0.0.1:9', token: 'new-token'})},
  {name: 'window state', write: (file: string) => saveWindowState(file, defaultWindowState())},
];

for (const {name, write} of writers) {
  test(`${name} removes a partially written temporary file and keeps the old target`, t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-atomic-cleanup-'));
    const file = path.join(directory, 'state.json');
    const previous = 'previous contents';
    fs.writeFileSync(file, previous);
    const originalWrite = fs.writeFileSync;
    const error = Object.assign(new Error('partial write failed'), {code: 'ENOSPC'});
    let temporary: string | undefined;
    t.mock.method(
      fs,
      'writeFileSync',
      (target: fs.PathOrFileDescriptor, data: string, options: fs.WriteFileOptions) => {
        assert.equal(typeof target, 'string');
        temporary = target as string;
        assert.notEqual(temporary, file);
        assert.equal(path.dirname(temporary), directory);
        assert.ok(temporary.endsWith('.tmp'));
        originalWrite(target, data.slice(0, 4), options);
        throw error;
      },
    );
    try {
      assert.throws(
        () => write(file),
        caught => caught === error,
      );
      assert.ok(temporary, 'the simulated error occurs after creating a partial temporary file');
      assert.equal(fs.existsSync(temporary), false);
      assert.equal(fs.readFileSync(file, 'utf8'), previous);
      assert.deepEqual(fs.readdirSync(directory), ['state.json']);
    } finally {
      t.mock.restoreAll();
      fs.rmSync(directory, {recursive: true, force: true});
    }
  });

  test(`${name} preserves the write error when temporary cleanup also fails`, t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-atomic-cleanup-'));
    const file = path.join(directory, 'state.json');
    const previous = 'previous contents';
    fs.writeFileSync(file, previous);
    const originalWrite = fs.writeFileSync;
    const writeError = Object.assign(new Error('partial write failed'), {code: 'ENOSPC'});
    const cleanupError = Object.assign(new Error('temporary file locked'), {code: 'EPERM'});
    let temporary: string | undefined;
    let cleanups = 0;
    t.mock.method(
      fs,
      'writeFileSync',
      (target: fs.PathOrFileDescriptor, data: string, options: fs.WriteFileOptions) => {
        temporary = target as string;
        originalWrite(target, data.slice(0, 4), options);
        throw writeError;
      },
    );
    t.mock.method(fs, 'unlinkSync', (target: fs.PathLike) => {
      cleanups++;
      assert.equal(target, temporary);
      throw cleanupError;
    });
    try {
      assert.throws(
        () => write(file),
        caught => caught === writeError,
      );
      assert.equal(cleanups, 1);
      assert.equal(fs.readFileSync(file, 'utf8'), previous);
      assert.ok(temporary);
      assert.equal(fs.existsSync(temporary), true, 'a locked temporary file cannot be removed by this attempt');
    } finally {
      t.mock.restoreAll();
      fs.rmSync(directory, {recursive: true, force: true});
    }
  });
}

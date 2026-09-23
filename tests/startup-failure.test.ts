import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type {ReceiverStatus, Snapshot} from '../src/ipc';
import {armQuit} from '../src/main/lifecycle';
import {createMonitorHandlers, type IpcSender, type RendererContents} from '../src/main/ipc-api';
import {projectSnapshot} from '../src/renderer/useMonitor';
import {startServer} from '../src/server';
import {EventStore} from '../src/store';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jev-monitor-'));

const platform: ReceiverStatus['platform'] = {
  os: 'linux-x11',
  arch: 'x64',
  tier: 2,
  alwaysOnTopSupported: true,
  notes: [],
};

function status(storageError?: string): ReceiverStatus {
  return {
    listening: false,
    dataDir: '/tmp/jev',
    corruptLines: 0,
    storageError,
    platform,
    mode: 'compact',
    pinned: true,
    startedAt: '2026-09-22T00:00:00.000Z',
  };
}

function boundHandlers(storageError?: string) {
  const frame = {url: 'file:///renderer/index.html'};
  const contents: RendererContents = {mainFrame: frame};
  const handlers = createMonitorHandlers({
    controller: {
      setMode: mode => mode,
      setPinned: pinned => pinned,
    },
    getStatus: () => status(storageError),
    rendererUrl: frame.url,
    contents,
  });
  const event: IpcSender = {sender: contents, senderFrame: frame};
  return {handlers, event, contents, frame};
}

test('storage initialization failure still serves an empty snapshot and storageError', () => {
  const dir = tempDir();
  const events = path.join(dir, 'events');
  fs.writeFileSync(events, 'not a directory');
  const failure = (() => {
    try {
      new EventStore(events);
      return undefined;
    } catch (error) {
      return error;
    }
  })();
  assert.ok(failure instanceof Error);
  const code = (failure as NodeJS.ErrnoException).code;
  assert.ok(code === 'EEXIST' || code === 'ENOTDIR', code);
  const {handlers, event} = boundHandlers(failure.message);
  assert.deepEqual(handlers.snapshot(event), {cursor: 0, runs: [], events: [], corruptLines: 0});
  assert.deepEqual(handlers.page(event, {}), {events: [], truncated: false});
  assert.equal(handlers.status(event).storageError, failure.message);
  assert.equal(handlers.status(event).url, undefined);
  assert.throws(() => handlers.snapshot(event, 1), /Invalid runId/);
  assert.throws(() => handlers.page(event, {limit: -1}), /Invalid limit/);
});

test('IPC handlers reject a sender, frame, or URL that is not the monitor window', () => {
  const {handlers, event, contents, frame} = boundHandlers();
  assert.deepEqual(handlers.snapshot(event).events, []);
  const stranger: RendererContents = {mainFrame: frame};
  assert.throws(() => handlers.snapshot({sender: stranger, senderFrame: frame}), /Rejected IPC sender/);
  const otherFrame = {url: frame.url};
  assert.throws(() => handlers.status({sender: contents, senderFrame: otherFrame}), /Rejected IPC sender/);
  const wrongUrl = {url: 'file:///other.html'};
  const wrongContents: RendererContents = {mainFrame: wrongUrl};
  assert.throws(() => handlers.setPinned({sender: wrongContents, senderFrame: wrongUrl}, true), /Rejected IPC sender/);
  assert.throws(() => handlers.setMode({sender: contents, senderFrame: null}, 'compact'), /Rejected IPC sender/);
});

test('armQuit waits for server close and does not block a quit with no server', async () => {
  let prevented = 0;
  let quit = 0;
  let release = () => {};
  const closing = {current: false};
  const event = {
    preventDefault: () => {
      prevented += 1;
    },
  };
  armQuit(
    event,
    closing,
    () =>
      new Promise<void>(resolve => {
        release = resolve;
      }),
    () => {
      quit += 1;
    },
  );
  assert.equal(prevented, 1);
  assert.equal(quit, 0);
  assert.equal(closing.current, true);
  armQuit(
    event,
    closing,
    () => Promise.resolve(),
    () => {
      quit += 1;
    },
  );
  assert.equal(prevented, 1);
  release();
  await Promise.resolve();
  assert.equal(quit, 1);

  let blocked = 0;
  armQuit(
    {
      preventDefault: () => {
        blocked += 1;
      },
    },
    {current: false},
    undefined,
    () => {},
  );
  assert.equal(blocked, 0);
});

test('session publication failure closes the listener', async () => {
  const dir = tempDir();
  const store = new EventStore(path.join(dir, 'events'));
  const parent = path.join(dir, 'blocked');
  fs.writeFileSync(parent, 'x');
  const seen: http.Server[] = [];
  const original = http.Server.prototype.listen;
  function wrapped(this: http.Server, ...args: unknown[]) {
    seen.push(this);
    return original.apply(this, args as never);
  }
  http.Server.prototype.listen = wrapped as typeof original;
  try {
    await assert.rejects(startServer(store, path.join(parent, 'session.json')));
  } finally {
    http.Server.prototype.listen = original;
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0].listening, false);
});

test('a later server error is not swallowed by the startup listener', async () => {
  const dir = tempDir();
  const store = new EventStore(path.join(dir, 'events'));
  const started = await startServer(store, path.join(dir, 'session.json'));
  try {
    assert.throws(() => started.server.emit('error', new Error('later')));
  } finally {
    await started.close();
  }
});

test('projectSnapshot hides run details until the selected run is loaded', () => {
  const snapshot = {
    cursor: 4,
    runs: [{id: 'a'}],
    run: {id: 'a'},
    events: [{cursor: 2}],
    corruptLines: 1,
  } as unknown as Snapshot;
  assert.equal(projectSnapshot(undefined, 'a', 'a'), undefined);
  assert.equal(projectSnapshot(snapshot, undefined, undefined), snapshot);
  assert.equal(projectSnapshot(snapshot, 'a', 'a'), snapshot);
  const hidden = projectSnapshot(snapshot, 'a', 'b');
  assert.equal(hidden?.cursor, 4);
  assert.equal(hidden?.corruptLines, 1);
  assert.deepEqual(hidden?.runs, snapshot.runs);
  assert.equal(hidden?.run, undefined);
  assert.deepEqual(hidden?.events, []);
});

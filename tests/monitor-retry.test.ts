import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {act, createElement, type ReactElement} from 'react';
import {createRoot} from 'react-dom/client';
import type {Changed, MonitorBridge, ReceiverStatus, Snapshot} from '../src/ipc';
import {useMonitor, type MonitorState} from '../src/renderer/useMonitor';
import {EventStore} from '../src/store';

require.extensions['.css'] = () => {};
const {App} = require('../src/renderer/App') as typeof import('../src/renderer/App');

type ActGlobal = typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?: boolean};

function receiver(listening = true): ReceiverStatus {
  return {
    listening,
    dataDir: '/tmp/jev',
    corruptLines: 0,
    platform: {os: 'linux-x11', arch: 'x64', tier: 2, alwaysOnTopSupported: true, notes: []},
    mode: 'expanded',
    pinned: true,
    startedAt: '2026-01-01T00:00:00.000Z',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return {promise, resolve};
}

async function withDom(
  run: (page: {
    document: Document;
    render(node: ReactElement): Promise<void>;
    click(selector: string): Promise<void>;
  }) => Promise<void>,
) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  const globals = globalThis as ActGlobal;
  const previous = {
    window: globals.window,
    document: globals.document,
    HTMLElement: globals.HTMLElement,
    Node: globals.Node,
    IS_REACT_ACT_ENVIRONMENT: globals.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globals, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(dom.window.document.getElementById('root')!);
  try {
    await run({
      document: dom.window.document,
      render: async node => {
        await act(async () => {
          root.render(node);
        });
      },
      click: async selector => {
        const button = dom.window.document.querySelector(selector);
        assert.ok(button, selector);
        await act(async () => {
          button.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
        });
      },
    });
  } finally {
    await act(async () => {
      root.unmount();
    });
    dom.window.close();
    Object.assign(globals, previous);
  }
}

function recording() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-retry-'));
  const store = new EventStore(dir);
  let sequence = 0;
  const emit = (runId: string, name?: string) => {
    sequence += 1;
    assert.equal(
      store.ingest({
        schema_version: 1,
        event_id: `event-${sequence}`,
        producer_id: 'host',
        run_id: runId,
        sequence,
        occurred_at: new Date(Date.UTC(2026, 0, 1) + sequence * 1000).toISOString(),
        type: name ? 'run.started' : 'heartbeat',
        payload: name ? {name} : {},
      }).accepted,
      true,
    );
  };
  return {
    store,
    emit,
    cleanup: () => {
      store.close();
      fs.rmSync(dir, {recursive: true, force: true});
    },
  };
}

function bridgeFor(store: EventStore) {
  let changed: (change: Changed) => void = () => {};
  const calls = {status: 0, snapshot: [] as Array<string | undefined>, commands: 0};
  const state = {fail: false, listening: true};
  let pending: ReturnType<typeof deferred<Snapshot>> | undefined;
  const bridge: MonitorBridge = {
    status: async () => {
      calls.status += 1;
      if (state.fail) throw new Error('private status failure');
      return receiver(state.listening);
    },
    snapshot: async runId => {
      calls.snapshot.push(runId);
      if (state.fail) throw new Error('private snapshot failure');
      return pending ? pending.promise : structuredClone(store.snapshot(runId));
    },
    page: async query => ({events: structuredClone(store.page(query)), truncated: false}),
    onChanged: listener => {
      changed = listener;
      return () => {
        changed = () => {};
      };
    },
    setMode: async mode => {
      calls.commands += 1;
      return mode;
    },
    setPinned: async pinned => {
      calls.commands += 1;
      return pinned;
    },
    exportEvents: async () => {
      calls.commands += 1;
      return {saved: false};
    },
    openReplay: async () => {
      calls.commands += 1;
      return null;
    },
  };
  return {
    bridge,
    calls,
    state,
    change: () => changed({cursor: store.cursor, runIds: ['a']}),
    deferSnapshot: () => {
      pending = deferred<Snapshot>();
      return pending;
    },
  };
}

test('read retries preserve the selected run, paused history and detail, and coalesce repeated clicks', async () => {
  const rec = recording();
  rec.emit('b', '另外的运行');
  rec.emit('a', '正在阅读的运行');
  for (let i = 0; i < 600; i++) rec.emit('a');
  const {bridge, calls, state, change, deferSnapshot} = bridgeFor(rec.store);
  try {
    await withDom(async ({document, render, click}) => {
      await render(createElement(App, {bridge}));
      const picker = document.querySelector('select');
      assert.ok(picker);
      // Make the run an explicit selection, so automatic default selection cannot mask a reset.
      await act(async () => {
        picker.value = 'a';
        picker.dispatchEvent(new window.Event('change', {bubbles: true}));
      });
      await click('[data-testid="tab-timeline"]');
      await click('[data-testid="timeline-load-older"]');
      const rows = () =>
        Array.from(document.querySelectorAll('.timeline-item'), node => node.getAttribute('data-cursor'));
      const before = rows();
      assert.ok(before.length > 0);
      await click('.timeline-item');
      const detail = () => document.querySelector('.timeline-json')?.textContent;
      const selected = detail();
      const cursor = document.querySelector('#app-root')?.getAttribute('data-cursor');
      await act(async () => {
        state.fail = true;
        change();
        await new Promise(resolve => setTimeout(resolve, 120));
      });
      assert.match(document.querySelector('[role="status"]')?.textContent ?? '', /已有记录仍保留/);
      assert.doesNotMatch(document.body.textContent ?? '', /private .* failure/);
      assert.deepEqual(rows(), before);
      await click('[data-testid="receiver-notice"] button');
      assert.deepEqual(rows(), before);
      assert.equal(detail(), selected);
      assert.equal(document.querySelector('select')?.value, 'a');
      assert.equal(document.querySelector('#app-root')?.getAttribute('data-cursor'), cursor);

      state.fail = false;
      const pending = deferSnapshot();
      for (let i = 0; i < 5; i++) rec.emit('a');
      const count = calls.snapshot.length;
      await act(async () => {
        const button = document.querySelector('[data-testid="receiver-notice"] button')!;
        button.dispatchEvent(new window.MouseEvent('click', {bubbles: true}));
        button.dispatchEvent(new window.MouseEvent('click', {bubbles: true}));
      });
      assert.equal(calls.snapshot.length, count + 1);
      assert.equal(calls.snapshot.at(-1), 'a');
      assert.equal(
        (document.querySelector('[data-testid="receiver-notice"] button') as HTMLButtonElement).disabled,
        true,
      );
      assert.deepEqual(rows(), before);
      await act(async () => {
        pending.resolve(structuredClone(rec.store.snapshot('a')));
        await pending.promise;
      });
      assert.equal(document.querySelector('[data-testid="receiver-notice"]'), null);
      assert.deepEqual(rows(), before);
      assert.equal(detail(), selected);
      assert.match(document.body.textContent ?? '', /5 条新事件/);
      assert.equal(document.querySelector('#app-root')?.getAttribute('data-cursor'), String(rec.store.cursor));
      assert.equal(document.querySelector('select')?.value, 'a');
      assert.equal(calls.commands, 0);
    });
  } finally {
    rec.cleanup();
  }
});

test('receiver-down remains visible after a successful read; an old event stream alone is not receiver-down', async () => {
  const rec = recording();
  rec.emit('a', '安静的运行');
  const {bridge, state} = bridgeFor(rec.store);
  try {
    await withDom(async ({document, render}) => {
      await render(createElement(App, {bridge}));
      assert.equal(document.querySelector('[data-testid="receiver-notice"]'), null);
    });
    state.listening = false;
    await withDom(async ({document, render, click}) => {
      await render(createElement(App, {bridge}));
      assert.match(document.querySelector('[role="status"]')?.textContent ?? '', /接收端暂未监听/);
      await click('[data-testid="receiver-notice"] button');
      assert.match(document.querySelector('[role="status"]')?.textContent ?? '', /接收端暂未监听/);
      assert.match(document.body.textContent ?? '', /安静的运行/);
      state.listening = true;
      await click('[data-testid="receiver-notice"] button');
      assert.equal(document.querySelector('[data-testid="receiver-notice"]'), null);
    });
  } finally {
    rec.cleanup();
  }
});

test('failed first reads can recover without a change notification', async () => {
  const rec = recording();
  const {bridge, state} = bridgeFor(rec.store);
  state.fail = true;
  try {
    await withDom(async ({document, render, click}) => {
      await render(createElement(App, {bridge}));
      assert.match(document.body.textContent ?? '', /正在读取本地记录/);
      assert.equal(document.querySelector('#app-root')?.getAttribute('data-cursor'), '0');
      state.fail = false;
      await click('[data-testid="receiver-notice"] button');
      assert.equal(document.querySelector('[data-testid="receiver-notice"]'), null);
      assert.match(document.body.textContent ?? '', /还没有运行记录/);
    });
  } finally {
    rec.cleanup();
  }
});

test('switching runs during a retry ignores the old response', async () => {
  const a = deferred<Snapshot>();
  const b = deferred<Snapshot>();
  let state!: MonitorState;
  const bridge = {
    status: async () => receiver(),
    snapshot: (id: string) => (id === 'a' ? a.promise : b.promise),
    onChanged: () => () => {},
  } as unknown as MonitorBridge;
  function Probe({id}: {id: string}) {
    state = useMonitor(id, bridge);
    return null;
  }
  await withDom(async ({render}) => {
    await render(createElement(Probe, {id: 'a'}));
    await act(async () => {
      state.retry();
    });
    assert.equal(state.retrying, true);
    await render(createElement(Probe, {id: 'b'}));
    assert.equal(state.retrying, false);
    await act(async () => {
      state.retry();
    });
    assert.equal(state.retrying, true);
    await act(async () => {
      b.resolve({cursor: 2, runs: [], events: [], corruptLines: 0});
      await b.promise;
    });
    await act(async () => {
      a.resolve({cursor: 1, runs: [], events: [], corruptLines: 0});
      await a.promise;
    });
    assert.equal(state.snapshot?.cursor, 2);
    assert.equal(state.retrying, false);
  });
});

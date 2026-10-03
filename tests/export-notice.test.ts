import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import type {ExportResult, MonitorBridge} from '../src/ipc';

// App imports view styles; the Node test runner has no stylesheet loader.
require.extensions['.css'] = () => {};
const {App} = require('../src/renderer/App') as typeof import('../src/renderer/App');

type ActGlobal = typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?: boolean};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return {promise, resolve, reject};
}

async function withApp(
  exportEvents: MonitorBridge['exportEvents'],
  check: (document: Document, click: (selector: string) => Promise<void>) => Promise<void>,
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
  globals.window = dom.window as unknown as ActGlobal['window'];
  globals.document = dom.window.document;
  globals.HTMLElement = dom.window.HTMLElement;
  globals.Node = dom.window.Node;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const bridge: MonitorBridge = {
    snapshot: async () => ({cursor: 0, runs: [], events: [], corruptLines: 0}),
    page: async () => ({events: [], truncated: false}),
    status: async () => ({
      listening: true,
      dataDir: 'monitor-data',
      corruptLines: 0,
      platform: {os: 'linux-x11', arch: 'x64', tier: 2, alwaysOnTopSupported: true, notes: []},
      mode: 'expanded',
      pinned: true,
      startedAt: '2026-10-04T00:00:00Z',
    }),
    onChanged: () => () => {},
    setMode: async mode => mode,
    setPinned: async pinned => pinned,
    exportEvents,
    openReplay: async () => null,
  };
  globals.window.monitor = bridge;
  const rootElement = dom.window.document.getElementById('root');
  assert.ok(rootElement);
  const root = createRoot(rootElement);
  const click = async (selector: string) => {
    const button = dom.window.document.querySelector(selector);
    assert.ok(button, selector);
    await act(async () => {
      button.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
    });
  };
  try {
    await act(async () => {
      root.render(createElement(App, {bridge}));
    });
    await check(dom.window.document, click);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    globals.window = previous.window;
    globals.document = previous.document;
    globals.HTMLElement = previous.HTMLElement;
    globals.Node = previous.Node;
    globals.IS_REACT_ACT_ENVIRONMENT = previous.IS_REACT_ACT_ENVIRONMENT;
  }
}

const exportButton = '[data-testid="export-events"]';
const dismissButton = 'button[aria-label="清除导出提示"]';

test('a saved export politely announces its basename, bytes and skipped lines and can be cleared', async () => {
  let exports = 0;
  await withApp(
    async () => {
      exports += 1;
      return {saved: true, path: '/private/logs/events.jsonl', bytes: 240, skipped: 2};
    },
    async (document, click) => {
      const status = document.querySelector('[role="status"]');
      assert.ok(status);
      assert.equal(status.textContent?.trim(), '');
      assert.equal(status.getAttribute('aria-live'), 'polite');
      assert.equal(status.getAttribute('aria-atomic'), 'true');
      assert.equal(document.querySelector(dismissButton), null);

      await click(exportButton);
      assert.equal(status.textContent?.trim(), '已导出 events.jsonl（240 字节，跳过 2 行）');
      assert.equal(status.textContent?.includes('/private/logs'), false);
      const dismiss = document.querySelector<HTMLButtonElement>(dismissButton);
      assert.ok(dismiss);
      assert.equal(dismiss.type, 'button');
      assert.equal(dismiss.tabIndex, 0);
      dismiss.focus();
      assert.equal(document.activeElement, dismiss);
      await click(dismissButton);
      assert.equal(status.textContent?.trim(), '');
      assert.equal(document.querySelector(dismissButton), null);
      assert.equal(exports, 1, 'clearing a notice must not export again');
      assert.ok(document.querySelector('[data-testid="expanded-root"]'));
    },
  );
});

test('a cancelled export has a clearable cancellation notice without claiming a saved file', async () => {
  await withApp(
    async () => ({saved: false}),
    async (document, click) => {
      await click(exportButton);
      assert.equal(document.querySelector('[role="status"]')?.textContent?.trim(), '已取消导出');
      assert.equal(document.body.textContent?.includes('已导出'), false);
      await click(dismissButton);
      assert.equal(document.querySelector('[role="status"]')?.textContent?.trim(), '');
    },
  );
});

test('starting another export clears the previous success while pending and keeps it cleared after failure', async () => {
  const pending = deferred<ExportResult>();
  let exports = 0;
  await withApp(
    () => {
      exports += 1;
      return exports === 1 ? Promise.resolve({saved: true, path: 'first.jsonl', bytes: 42}) : pending.promise;
    },
    async (document, click) => {
      await click(exportButton);
      const status = document.querySelector('[role="status"]');
      assert.ok(status);
      assert.equal(status.textContent?.trim(), '已导出 first.jsonl（42 字节）');

      await click(exportButton);
      assert.equal(status.textContent?.trim(), '');
      assert.equal(document.querySelector(dismissButton), null);
      await act(async () => {
        pending.reject(new Error('保存失败：目录不可写'));
        await pending.promise.catch(() => {});
      });
      assert.equal(document.querySelector('.tone-danger')?.textContent, '保存失败：目录不可写');
      assert.equal(status.textContent?.trim(), '');
      assert.equal(document.body.textContent?.includes('first.jsonl'), false);
    },
  );
});

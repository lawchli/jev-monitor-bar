import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';

type ActGlobal = typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?: boolean};
import {act, createElement, type ReactElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import type {MonitorBridge} from '../src/ipc';
import type {EventType, StoredEvent} from '../src/protocol';
import {TimelineTab} from '../src/renderer/expanded/TimelineTab';

function stored(cursor: number, runId: string, type: EventType = 'heartbeat'): StoredEvent {
  const occurred = new Date(Date.UTC(2026, 0, 1, 0, 0, cursor)).toISOString();
  return {
    schema_version: 1,
    event_id: `${runId}-${type}-${cursor}`,
    run_id: runId,
    producer_id: 'host',
    sequence: cursor,
    occurred_at: occurred,
    type,
    payload: type === 'telemetry.dropped' ? {count: 1} : {},
    received_at: occurred,
    cursor,
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return {promise, resolve};
}

test('a stale page response does not mix another run into the timeline', async () => {
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

  const pages: ReturnType<typeof deferred<StoredEvent[]>>[] = [];
  const bridge = {
    page: () => {
      const pending = deferred<StoredEvent[]>();
      pages.push(pending);
      return pending.promise;
    },
  } as Pick<MonitorBridge, 'page'> as MonitorBridge;

  const rootElement = dom.window.document.getElementById('root');
  assert.ok(rootElement);
  let root: Root | undefined;
  const render = (node: ReactElement) => {
    root ??= createRoot(rootElement);
    root.render(node);
  };

  try {
    await act(async () => {
      render(
        createElement(TimelineTab, {
          events: [stored(5, 'run-a')],
          runId: 'run-a',
          bridge,
          retryKeys: new Set<string>(),
        }),
      );
    });
    const button = () => dom.window.document.querySelector('[data-testid="timeline-load-older"]');
    await act(async () => {
      button()?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
    });
    assert.equal(pages.length, 1);

    await act(async () => {
      render(
        createElement(TimelineTab, {
          events: [stored(8, 'run-b')],
          runId: 'run-b',
          bridge,
          retryKeys: new Set<string>(),
        }),
      );
    });
    await act(async () => {
      pages[0].resolve([stored(1, 'run-a', 'run.failed')]);
      await pages[0].promise;
    });
    assert.equal(dom.window.document.body.textContent?.includes('任务失败'), false);

    await act(async () => {
      render(
        createElement(TimelineTab, {
          events: [stored(5, 'run-a')],
          runId: 'run-a',
          bridge,
          retryKeys: new Set<string>(),
        }),
      );
    });
    assert.equal(dom.window.document.body.textContent?.includes('任务失败'), false);

    await act(async () => {
      button()?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
    });
    assert.equal(pages.length, 2);
    await act(async () => {
      pages[1].resolve([stored(2, 'run-a', 'decision.failed'), stored(3, 'run-b', 'telemetry.dropped')]);
      await pages[1].promise;
    });
    const text = dom.window.document.body.textContent ?? '';
    assert.equal(text.includes('决策失败'), true);
    assert.equal(text.includes('发送端丢弃'), false);
  } finally {
    await act(async () => {
      root?.unmount();
    });
    dom.window.close();
    globals.window = previous.window;
    globals.document = previous.document;
    globals.HTMLElement = previous.HTMLElement;
    globals.Node = previous.Node;
    globals.IS_REACT_ACT_ENVIRONMENT = previous.IS_REACT_ACT_ENVIRONMENT;
  }
});

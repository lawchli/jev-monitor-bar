import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';

type ActGlobal = typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?: boolean};
import {act, createElement, type ReactElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import type {MonitorBridge} from '../src/ipc';
import type {EventType, StoredEvent} from '../src/protocol';
import {TimelineTab} from '../src/renderer/expanded/TimelineTab';
import {shiftTimelineWindow, visibleTimelineItems, type TimelineAnchor} from '../src/renderer/expanded/timeline-window';

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

test('timeline window can walk back to cursor 1 and stays pinned while new events arrive', () => {
  const items = Array.from({length: 1200}, (_value, index) => ({cursor: index + 1}));
  let anchor: TimelineAnchor = {following: true};
  let visible = visibleTimelineItems(items, anchor);
  assert.deepEqual([visible[0]?.cursor, visible.at(-1)?.cursor, visible.length], [701, 1200, 500]);

  let steps = 0;
  while (visible[0]?.cursor !== 1) {
    const next = shiftTimelineWindow(items, anchor);
    assert.equal(next.moved, true);
    assert.ok(next.startCursor < (visible[0]?.cursor ?? 0));
    anchor = {following: false, startCursor: next.startCursor, endCursor: next.endCursor};
    const moved = visibleTimelineItems(items, anchor);
    assert.equal(moved.length, 500);
    visible = moved;
    steps += 1;
    assert.ok(steps < 20);
  }
  assert.equal(steps, 7);
  assert.equal(visible[0]?.cursor, 1);
  assert.equal(visible.at(-1)?.cursor, 500);

  const selected = visible[4]?.cursor;
  const pinned = visible.map(item => item.cursor);
  const extended = items.concat(Array.from({length: 600}, (_value, index) => ({cursor: 1201 + index})));
  const still = visibleTimelineItems(extended, anchor);
  assert.deepEqual(
    still.map(item => item.cursor),
    pinned,
  );
  assert.equal(
    still.some(item => item.cursor === selected),
    true,
  );

  const latest = visibleTimelineItems(extended, {following: true});
  assert.equal(latest.length, 500);
  assert.equal(latest.at(-1)?.cursor, 1800);
  assert.equal(
    latest.some(item => item.cursor === 1800),
    true,
  );
});

test('loading earlier reaches the first event, and a paused selection stays in view', async () => {
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

  const calls: number[] = [];
  const bridge = {
    page: (query: {beforeCursor?: number}) => {
      calls.push(query.beforeCursor ?? 0);
      return Promise.resolve([]);
    },
  } as Pick<MonitorBridge, 'page'> as MonitorBridge;

  const rootElement = dom.window.document.getElementById('root');
  assert.ok(rootElement);
  let root: Root | undefined;
  const render = (node: ReactElement) => {
    root ??= createRoot(rootElement);
    root.render(node);
  };
  const items = () => Array.from(dom.window.document.querySelectorAll('[data-testid="timeline-item"]'));
  const itemText = () =>
    items()
      .map(node => node.textContent ?? '')
      .join('\n');
  const older = () => dom.window.document.querySelector('[data-testid="timeline-load-older"]');
  const first = Array.from({length: 1200}, (_value, index) =>
    stored(index + 1, 'run-a', index === 0 ? 'run.started' : 'heartbeat'),
  );
  const extra = Array.from({length: 600}, (_value, index) =>
    stored(1201 + index, 'run-a', index === 599 ? 'run.failed' : 'heartbeat'),
  );

  try {
    await act(async () => {
      render(createElement(TimelineTab, {events: first, runId: 'run-a', bridge, retryKeys: new Set<string>()}));
    });
    assert.equal(items().length, 500);
    assert.equal(itemText().includes('任务开始'), false);
    assert.equal(older()?.textContent, '加载更早');

    let steps = 0;
    while (!itemText().includes('任务开始')) {
      assert.equal(older()?.textContent, '加载更早');
      await act(async () => {
        older()?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
      });
      steps += 1;
      assert.ok(steps <= 12);
    }
    assert.equal(steps, 7);
    assert.equal(calls.length, 0);
    assert.equal(items().length, 500);
    assert.equal(
      dom.window.document.querySelector('[data-testid="timeline-resume"]')?.textContent?.includes('已暂停跟随'),
      true,
    );

    await act(async () => {
      older()?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0], 1);
    assert.equal(older()?.textContent, '没有更早的事件');
    assert.equal(itemText().includes('任务开始'), true);

    const row = items().find(node => node.textContent?.includes('任务开始'));
    assert.ok(row);
    await act(async () => {
      row.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
    });
    assert.equal(
      dom.window.document.querySelector('.timeline-item.is-selected')?.textContent?.includes('任务开始'),
      true,
    );

    await act(async () => {
      render(
        createElement(TimelineTab, {
          events: [...first, ...extra],
          runId: 'run-a',
          bridge,
          retryKeys: new Set<string>(),
        }),
      );
    });
    assert.equal(items().length, 500);
    assert.equal(itemText().includes('任务开始'), true);
    assert.equal(itemText().includes('任务失败'), false);
    assert.equal(
      dom.window.document.querySelector('.timeline-item.is-selected')?.textContent?.includes('任务开始'),
      true,
    );
    assert.equal(
      dom.window.document.querySelector('[data-testid="timeline-resume"]')?.textContent,
      '已暂停跟随 · 600 条新事件 · 回到最新',
    );

    await act(async () => {
      dom.window.document
        .querySelector('[data-testid="timeline-resume"]')
        ?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
    });
    assert.equal(dom.window.document.querySelector('.follow-note')?.textContent, '跟随最新');
    assert.equal(items().length, 500);
    assert.equal(itemText().includes('任务失败'), true);
    assert.equal(itemText().includes('任务开始'), false);
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

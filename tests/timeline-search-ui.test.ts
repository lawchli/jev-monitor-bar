import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {act, createElement, useState} from 'react';
import type {Root} from 'react-dom/client';
import type {MonitorBridge, PageQuery} from '../src/ipc';
import type {EventType, StoredEvent} from '../src/protocol';
import {TimelineTab} from '../src/renderer/expanded/TimelineTab';
import {ViewTabs, type ViewTab} from '../src/renderer/expanded/ViewTabs';

type ActGlobal = typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?: boolean};

function stored(cursor: number, type: EventType = 'heartbeat', reason?: string, runId = 'run-a'): StoredEvent {
  const at = new Date(Date.UTC(2026, 9, 3, 0, 0, cursor)).toISOString();
  return {
    schema_version: 1,
    event_id: `${runId}-${cursor}`,
    run_id: runId,
    producer_id: 'host',
    sequence: cursor,
    occurred_at: at,
    type,
    payload: reason ? {reason} : {},
    received_at: at,
    cursor,
  };
}

async function withDom(run: (dom: JSDOM, root: Root) => Promise<void>) {
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
  // Set up the DOM before React's event support detection, as a browser does.
  const {createRoot} = await import('react-dom/client');
  const container = dom.window.document.getElementById('root');
  assert.ok(container);
  const root = createRoot(container);
  try {
    await run(dom, root);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.assign(globals, previous);
  }
}

function click(dom: JSDOM, selector: string) {
  const node = dom.window.document.querySelector(selector);
  assert.ok(node, selector);
  node.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
}

function search(dom: JSDOM): HTMLInputElement {
  const node = dom.window.document.querySelector<HTMLInputElement>('[data-testid="timeline-search"]');
  assert.ok(node);
  return node;
}

function enterQuery(dom: JSDOM, query: string) {
  const input = search(dom);
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set;
  assert.ok(setter);
  setter.call(input, query);
  input.dispatchEvent(new dom.window.Event('input', {bubbles: true}));
}

function pressKey(dom: JSDOM, target: EventTarget, key: string, extra: KeyboardEventInit = {}) {
  const KeyboardEvent = (dom.window as unknown as {KeyboardEvent: typeof globalThis.KeyboardEvent}).KeyboardEvent;
  const event = new KeyboardEvent('keydown', {key, bubbles: true, cancelable: true, ...extra});
  target.dispatchEvent(event);
  return event;
}

function cursors(dom: JSDOM): number[] {
  return Array.from(dom.window.document.querySelectorAll('[data-testid="timeline-item"]'), item =>
    Number(item.getAttribute('data-cursor')),
  );
}

async function settleSearch(dom: JSDOM) {
  for (let attempts = 0; attempts < 300; attempts++) {
    if (!dom.window.document.querySelector('[data-testid="timeline-search-pending"]')) return;
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
    });
  }
  assert.fail('search did not settle');
}

const bridge = {page: async () => ({events: [], truncated: false})} as Pick<MonitorBridge, 'page'> as MonitorBridge;

test('local timeline search composes with error filtering and Ctrl/Cmd+F and Escape', async () => {
  await withDom(async (dom, root) => {
    const events = [
      stored(1, 'heartbeat', 'report'),
      stored(2, 'run.failed', 'REPORT disk full'),
      stored(3, 'run.failed', 'timeout'),
    ];
    await act(async () => root.render(createElement(TimelineTab, {events, runId: 'run-a', bridge})));
    await act(async () => enterQuery(dom, 'report'));
    await settleSearch(dom);
    assert.deepEqual(cursors(dom), [1, 2]);
    assert.ok(dom.window.document.body.textContent?.includes('匹配 2 / 3 条'));
    await act(async () => click(dom, '.timeline-tools button:nth-child(2)'));
    await settleSearch(dom);
    assert.deepEqual(cursors(dom), [2]);
    assert.ok(dom.window.document.body.textContent?.includes('匹配 1 / 2 条'));
    for (const modifier of [{ctrlKey: true}, {metaKey: true}]) {
      let event: KeyboardEvent | undefined;
      await act(async () => {
        event = pressKey(dom, dom.window.document, 'f', modifier);
      });
      assert.equal(dom.window.document.activeElement, search(dom));
      assert.equal(event?.defaultPrevented, true);
    }
    await act(async () => {
      pressKey(dom, search(dom), 'Escape');
    });
    assert.equal(search(dom).value, '');
    assert.deepEqual(cursors(dom), [2, 3]);
  });
});

test('search with zero matches can fetch older history and does not mix another run', async () => {
  await withDom(async (dom, root) => {
    const calls: PageQuery[] = [];
    const paging = {
      page: async (query: PageQuery) => {
        calls.push(query);
        return {
          events:
            calls.length === 1
              ? [stored(1, 'run.failed', 'report'), stored(2, 'run.failed', 'report', 'other-run')]
              : [],
          truncated: false,
        };
      },
    } as Pick<MonitorBridge, 'page'> as MonitorBridge;
    await act(async () =>
      root.render(createElement(TimelineTab, {events: [stored(10)], runId: 'run-a', bridge: paging})),
    );
    await act(async () => enterQuery(dom, 'report'));
    await settleSearch(dom);
    assert.deepEqual(cursors(dom), []);
    assert.ok(dom.window.document.body.textContent?.includes('没有匹配项'));
    await act(async () => click(dom, '[data-testid="timeline-load-older"]'));
    await settleSearch(dom);
    assert.deepEqual(cursors(dom), [1]);
    assert.equal(calls[0].beforeCursor, 10);
    assert.equal(search(dom).value, 'report');
    await act(async () => click(dom, '[data-testid="timeline-load-older"]'));
    const older = dom.window.document.querySelector<HTMLButtonElement>('[data-testid="timeline-load-older"]');
    assert.equal(older?.disabled, true);
    assert.equal(older?.textContent, '没有更早的事件');
  });
});

test('a failed older-page request gives a retryable notice instead of silently failing', async () => {
  await withDom(async (dom, root) => {
    let calls = 0;
    const paging = {
      page: async () => {
        if (++calls === 1) throw new Error('temporary lock');
        return {events: [stored(1)], truncated: false};
      },
    } as Pick<MonitorBridge, 'page'> as MonitorBridge;
    await act(async () =>
      root.render(createElement(TimelineTab, {events: [stored(10)], runId: 'run-a', bridge: paging})),
    );
    await act(async () => click(dom, '[data-testid="timeline-load-older"]'));
    assert.ok(dom.window.document.querySelector('[role="alert"]')?.textContent?.includes('加载失败'));
    await act(async () => click(dom, '[data-testid="timeline-load-older"]'));
    assert.equal(dom.window.document.querySelector('[role="alert"]'), null);
    assert.deepEqual(cursors(dom), [1, 10]);
  });
});

test('search remains local, capped at 500 rendered rows, and resets when changing runs', async () => {
  await withDom(async (dom, root) => {
    let calls = 0;
    const paging = {
      page: async () => {
        calls++;
        return {events: [], truncated: false};
      },
    } as Pick<MonitorBridge, 'page'> as MonitorBridge;
    const events = Array.from({length: 1200}, (_, index) => stored(index + 1, 'heartbeat', 'report'));
    await act(async () => root.render(createElement(TimelineTab, {events, runId: 'run-a', bridge: paging})));
    await act(async () => enterQuery(dom, 'report'));
    await settleSearch(dom);
    assert.equal(cursors(dom).length, 500);
    assert.ok(dom.window.document.body.textContent?.includes('匹配 1200 / 1200 条'));
    assert.equal(calls, 0);
    await act(async () => click(dom, '[data-cursor="900"]'));
    assert.ok(dom.window.document.querySelector('.timeline-json'));
    await act(async () => enterQuery(dom, 'not found'));
    await settleSearch(dom);
    assert.equal(dom.window.document.querySelector('.timeline-json'), null);
    await act(async () =>
      root.render(
        createElement(TimelineTab, {
          events: [stored(2000, 'heartbeat', undefined, 'run-b')],
          runId: 'run-b',
          bridge: paging,
        }),
      ),
    );
    assert.equal(search(dom).value, '');
    assert.deepEqual(cursors(dom), [2000]);
    assert.equal(calls, 0);
  });
});

test('rapid queries, new snapshots, Escape and run changes cannot publish a stale async search', async () => {
  await withDom(async (dom, root) => {
    const events = Array.from({length: 6000}, (_, index) =>
      stored(index + 1, 'run.failed', `${index % 2 ? 'old-only' : 'new-only'} ${'x'.repeat(800)}`),
    );
    await act(async () => root.render(createElement(TimelineTab, {events, runId: 'run-a', bridge})));
    await act(async () => enterQuery(dom, 'old-only'));
    if (dom.window.document.querySelector('[data-testid="timeline-search-pending"]')) {
      assert.equal(dom.window.document.body.textContent?.includes('匹配 '), false);
      assert.equal(dom.window.document.body.textContent?.includes('没有匹配项'), false);
    }
    await act(async () => enterQuery(dom, 'new-only'));
    const increment = stored(6001, 'run.failed', 'new-only fresh-event');
    await act(async () =>
      root.render(createElement(TimelineTab, {events: [...events, increment], runId: 'run-a', bridge})),
    );
    await settleSearch(dom);
    assert.equal(cursors(dom).at(-1), 6001);
    assert.ok(dom.window.document.body.textContent?.includes('匹配 3001 / 6001 条'));
    await act(async () => enterQuery(dom, 'old-only'));
    await act(async () => {
      pressKey(dom, search(dom), 'Escape');
    });
    assert.equal(search(dom).value, '');
    assert.equal(cursors(dom).length, 500);
    assert.equal(cursors(dom).at(-1), 6001);
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 15));
    });
    assert.equal(search(dom).value, '');
    assert.equal(cursors(dom).at(-1), 6001);
    await act(async () => enterQuery(dom, 'old-only'));
    await act(async () =>
      root.render(
        createElement(TimelineTab, {events: [stored(7000, 'heartbeat', undefined, 'run-b')], runId: 'run-b', bridge}),
      ),
    );
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 15));
    });
    assert.equal(search(dom).value, '');
    assert.deepEqual(cursors(dom), [7000]);
  });
});

test('loading a prior first attempt uncovers a retry even when bounded run hints are empty', async () => {
  await withDom(async (dom, root) => {
    const first = {...stored(1, 'action.started'), action_id: 'old-action', attempt_id: 'first'};
    const retry = {...stored(500, 'action.started', 'historical-retry'), action_id: 'old-action', attempt_id: 'retry'};
    const paging = {page: async () => ({events: [first], truncated: false})} as Pick<
      MonitorBridge,
      'page'
    > as MonitorBridge;
    await act(async () =>
      root.render(
        createElement(TimelineTab, {events: [retry], runId: 'run-a', bridge: paging, retryKeys: new Set<string>()}),
      ),
    );
    await act(async () => click(dom, '.timeline-tools button:nth-child(2)'));
    assert.deepEqual(cursors(dom), []);
    await act(async () => click(dom, '[data-testid="timeline-load-older"]'));
    assert.deepEqual(cursors(dom), [500]);
    await act(async () => enterQuery(dom, 'historical-retry'));
    await settleSearch(dom);
    assert.deepEqual(cursors(dom), [500]);
  });
});

test('search shortcuts are scoped to the mounted timeline and only input Escape clears', async () => {
  await withDom(async (dom, root) => {
    await act(async () => root.render(createElement(TimelineTab, {events: [stored(1)], runId: 'run-a', bridge})));
    await act(async () => enterQuery(dom, 'missing'));
    await settleSearch(dom);
    await act(async () => {
      pressKey(dom, dom.window.document, 'Escape');
    });
    assert.equal(search(dom).value, 'missing');
    assert.equal(pressKey(dom, dom.window.document, 'f', {ctrlKey: true, altKey: true}).defaultPrevented, false);
    await act(async () => root.render(createElement('p', null, 'another tab')));
    assert.equal(pressKey(dom, dom.window.document, 'f', {ctrlKey: true}).defaultPrevented, false);
  });
});

function TabsHarness() {
  const [selected, setSelected] = useState<ViewTab>('decisions');
  return createElement(ViewTabs, {selected, onSelect: setSelected});
}

test('detail tabs use roving focus and keyboard navigation, including wraparound', async () => {
  await withDom(async (dom, root) => {
    await act(async () => root.render(createElement(TabsHarness)));
    const tabs = Array.from(dom.window.document.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    assert.deepEqual(
      tabs.map(tab => tab.tabIndex),
      [0, -1, -1],
    );
    await act(async () => {
      pressKey(dom, tabs[0], 'ArrowLeft');
    });
    assert.equal(dom.window.document.activeElement, tabs[2]);
    assert.equal(tabs[2].getAttribute('aria-selected'), 'true');
    await act(async () => {
      pressKey(dom, tabs[2], 'Home');
    });
    assert.equal(dom.window.document.activeElement, tabs[0]);
    await act(async () => {
      pressKey(dom, tabs[0], 'ArrowRight');
    });
    assert.equal(dom.window.document.activeElement, tabs[1]);
    await act(async () => {
      pressKey(dom, tabs[1], 'End');
    });
    assert.equal(dom.window.document.activeElement, tabs[2]);
    assert.deepEqual(
      tabs.map(tab => tab.tabIndex),
      [-1, -1, 0],
    );
  });
});

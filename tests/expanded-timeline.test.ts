import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';

type ActGlobal = typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?: boolean};
import {act, createElement, type ReactElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import type {EventPage, MonitorBridge, PageQuery} from '../src/ipc';
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
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return {promise, resolve, reject};
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

  const pages: ReturnType<typeof deferred<EventPage>>[] = [];
  const bridge = {
    page: () => {
      const pending = deferred<EventPage>();
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
      pages[0].resolve({events: [stored(1, 'run-a', 'run.failed')], truncated: false});
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
      pages[1].resolve({
        events: [stored(2, 'run-a', 'decision.failed'), stored(3, 'run-b', 'telemetry.dropped')],
        truncated: false,
      });
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

function range(start: number, end: number, runId = 'run-a'): StoredEvent[] {
  const rows: StoredEvent[] = [];
  for (let cursor = start; cursor <= end; cursor++) rows.push(stored(cursor, runId));
  return rows;
}

function renderedCursors(document: Document): number[] {
  return Array.from(document.querySelectorAll('[data-cursor]'), node => Number(node.getAttribute('data-cursor')));
}

async function renderTimeline(
  run: (tools: {
    dom: JSDOM;
    render: (events: StoredEvent[], runId?: string) => void;
    bridge: MonitorBridge;
  }) => Promise<void>,
  bridge: MonitorBridge,
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
  const rootElement = dom.window.document.getElementById('root');
  assert.ok(rootElement);
  let root: Root | undefined;
  const render = (events: StoredEvent[], runId = 'run-a') => {
    root ??= createRoot(rootElement);
    root.render(createElement(TimelineTab, {events, runId, bridge, retryKeys: new Set<string>()}));
  };
  try {
    await run({dom, render, bridge});
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
}

function click(dom: JSDOM, selector: string) {
  const node = dom.window.document.querySelector(selector);
  assert.ok(node, selector);
  node.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
}

test('a 500-row window can move back to event 1 and a paused view survives new events', async () => {
  const calls: PageQuery[] = [];
  const bridge = {
    page: async (query: PageQuery) => {
      calls.push(query);
      return {events: [], truncated: false};
    },
  } as Pick<MonitorBridge, 'page'> as MonitorBridge;
  const loaded = range(1, 1200);

  await renderTimeline(async ({dom, render}) => {
    await act(async () => {
      render(loaded);
    });
    const cursors = () => renderedCursors(dom.window.document);
    assert.deepEqual([cursors()[0], cursors().at(-1), cursors().length], [701, 1200, 500]);
    assert.equal(dom.window.document.body.textContent?.includes('仅显示最近 500 条'), true);

    await act(async () => {
      click(dom, '[data-testid="timeline-load-older"]');
    });
    assert.equal(calls.length, 0);
    assert.deepEqual([cursors()[0], cursors().at(-1)], [202, 701]);
    assert.equal(dom.window.document.body.textContent?.includes('正在查看较早事件'), true);

    await act(async () => {
      click(dom, '[data-testid="timeline-load-older"]');
    });
    assert.equal(calls.length, 0);
    assert.equal(cursors()[0], 1);
    assert.ok(cursors().length <= 500);

    await act(async () => {
      click(dom, '[data-testid="timeline-load-older"]');
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].beforeCursor, 1);
    assert.equal(dom.window.document.body.textContent?.includes('没有更早的事件'), true);
    assert.equal(cursors()[0], 1);
  }, bridge);

  const tail = range(801, 1200);
  let pages = 0;
  const paging = {
    page: async (query: PageQuery) => {
      pages += 1;
      const before = query.beforeCursor ?? 0;
      const events = loaded.filter(event => event.cursor < before).slice(-(query.limit ?? 100));
      return {events, truncated: false};
    },
  } as Pick<MonitorBridge, 'page'> as MonitorBridge;
  await renderTimeline(async ({dom, render}) => {
    await act(async () => {
      render(tail);
    });
    const cursors = () => renderedCursors(dom.window.document);
    assert.equal(cursors()[0], 801);
    for (let step = 0; step < 24 && !cursors().includes(1); step++) {
      await act(async () => {
        click(dom, '[data-testid="timeline-load-older"]');
      });
      assert.ok(cursors().length <= 500);
    }
    assert.equal(cursors().includes(1), true);
    assert.ok(pages > 0);
    assert.ok(pages < 24);
  }, paging);
});

test('pausing keeps the visible rows and selection when later snapshots arrive', async () => {
  const bridge = {
    page: async () => ({events: [], truncated: false}),
  } as Pick<MonitorBridge, 'page'> as MonitorBridge;

  await renderTimeline(async ({dom, render}) => {
    await act(async () => {
      render(range(1, 600));
    });
    const list = dom.window.document.querySelector('.timeline-list');
    assert.ok(list);
    const metrics = {scrollHeight: 4000, clientHeight: 240, scrollTop: 80};
    Object.defineProperty(list, 'scrollHeight', {configurable: true, get: () => metrics.scrollHeight});
    Object.defineProperty(list, 'clientHeight', {configurable: true, get: () => metrics.clientHeight});
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => metrics.scrollTop,
      set: (value: number) => {
        metrics.scrollTop = value;
      },
    });
    await act(async () => {
      const ScrollEvent = (dom.window as unknown as {Event: typeof Event}).Event;
      list.dispatchEvent(new ScrollEvent('scroll'));
    });
    const cursors = () => renderedCursors(dom.window.document);
    const paused = cursors();
    assert.deepEqual([paused[0], paused.at(-1)], [101, 600]);
    await act(async () => {
      click(dom, '[data-cursor="150"]');
    });
    const detail = () => dom.window.document.querySelector('.timeline-json')?.textContent ?? '';
    assert.equal(detail().includes('run-a-heartbeat-150'), true);

    await act(async () => {
      render(range(601, 1200));
    });
    assert.deepEqual(cursors(), paused);
    assert.equal(detail().includes('run-a-heartbeat-150'), true);
    assert.equal(dom.window.document.body.textContent?.includes('已暂停跟随 · 600 条新事件'), true);

    await act(async () => {
      click(dom, '[data-testid="timeline-resume"]');
    });
    const followed = cursors();
    assert.equal(dom.window.document.body.textContent?.includes('跟随最新'), true);
    assert.equal(followed.at(-1), 1200);
    assert.equal(followed[0], 701);
    assert.equal(followed.includes(150), false);
  }, bridge);
});

test('an empty older page says when events were dropped from the retained window', async () => {
  const bridge = {
    page: async () => ({events: [], truncated: true}),
  } as Pick<MonitorBridge, 'page'> as MonitorBridge;
  await renderTimeline(async ({dom, render}) => {
    await act(async () => {
      render(range(11, 20));
    });
    await act(async () => {
      click(dom, '[data-testid="timeline-load-older"]');
    });
    const text = dom.window.document.body.textContent ?? '';
    assert.equal(text.includes('更早的事件已超出保留窗口'), true);
    assert.equal(text.includes('没有更早的事件'), false);
    assert.deepEqual(
      renderedCursors(dom.window.document),
      range(11, 20).map(event => event.cursor),
    );
  }, bridge);
});

test('failed history loading preserves rows, selection and scroll position and can retry the same page', async () => {
  const calls: PageQuery[] = [];
  const pages: ReturnType<typeof deferred<EventPage>>[] = [];
  const bridge = {
    page: (query: PageQuery) => {
      calls.push(query);
      const pending = deferred<EventPage>();
      pages.push(pending);
      return pending.promise;
    },
  } as Pick<MonitorBridge, 'page'> as MonitorBridge;

  await renderTimeline(async ({dom, render}) => {
    await act(async () => render(range(31, 40)));
    await act(async () => click(dom, '[data-testid="timeline-load-older"]'));
    await act(async () => pages[0].resolve({events: range(21, 30), truncated: false}));
    await act(async () => click(dom, '[data-cursor="25"]'));
    const list = dom.window.document.querySelector('.timeline-list');
    assert.ok(list);
    let scrollTop = 80;
    let scrollWrites = 0;
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
        scrollWrites += 1;
      },
    });
    const cursors = renderedCursors(dom.window.document);
    const selected = dom.window.document.querySelector('.timeline-json')?.textContent;
    const button = () => dom.window.document.querySelector<HTMLButtonElement>('[data-testid="timeline-load-older"]');
    const message = () => dom.window.document.querySelector('[role="status"]');

    await act(async () => click(dom, '[data-testid="timeline-load-older"]'));
    assert.equal(button()?.disabled, true);
    await act(async () => pages[1].reject(new Error('private backend path /secrets/session.json')));
    assert.equal(message()?.textContent?.trim(), '暂时未能加载更早的事件，请重试。');
    assert.equal(dom.window.document.body.textContent?.includes('/secrets/session.json'), false);
    assert.equal(button()?.textContent?.trim(), '重试加载更早');
    assert.equal(button()?.disabled, false);
    assert.deepEqual(renderedCursors(dom.window.document), cursors);
    assert.equal(dom.window.document.querySelector('.timeline-json')?.textContent, selected);
    assert.equal(scrollTop, 80);
    assert.equal(scrollWrites, 0);

    await act(async () => render(range(41, 50)));
    assert.deepEqual(renderedCursors(dom.window.document), cursors);
    assert.equal(scrollWrites, 0);
    await act(async () => click(dom, '[data-testid="timeline-load-older"]'));
    assert.deepEqual(calls[2], calls[1]);
    assert.equal(button()?.disabled, true);
    assert.ok(message());
    await act(async () => pages[2].resolve({events: range(11, 20), truncated: false}));
    assert.equal(message(), null);
    assert.equal(button()?.textContent?.trim(), '加载更早');
    assert.equal(renderedCursors(dom.window.document)[0], 11);
  }, bridge);
});

test('successful empty retry clears the error and keeps the retained-window explanation', async () => {
  let requests = 0;
  const bridge = {
    page: async () => {
      if (++requests === 1) throw new Error('unavailable');
      return {events: [], truncated: true};
    },
  } as Pick<MonitorBridge, 'page'> as MonitorBridge;
  await renderTimeline(async ({dom, render}) => {
    await act(async () => render(range(11, 20)));
    await act(async () => click(dom, '[data-testid="timeline-load-older"]'));
    assert.ok(dom.window.document.querySelector('[role="status"]'));
    await act(async () => click(dom, '[data-testid="timeline-load-older"]'));
    assert.equal(dom.window.document.querySelector('[role="status"]'), null);
    const button = dom.window.document.querySelector<HTMLButtonElement>('[data-testid="timeline-load-older"]');
    assert.equal(button?.textContent?.trim(), '更早的事件已超出保留窗口');
    assert.equal(button?.disabled, true);
    assert.deepEqual(
      renderedCursors(dom.window.document),
      range(11, 20).map(event => event.cursor),
    );
  }, bridge);
});

test('history errors clear on run switch and return to latest', async () => {
  const bridge = {
    page: async () => {
      throw new Error('unavailable');
    },
  } as Pick<MonitorBridge, 'page'> as MonitorBridge;
  await renderTimeline(async ({dom, render}) => {
    await act(async () => render(range(11, 20)));
    await act(async () => click(dom, '[data-testid="timeline-load-older"]'));
    assert.ok(dom.window.document.querySelector('[role="status"]'));
    await act(async () => render(range(31, 40, 'run-b'), 'run-b'));
    assert.equal(dom.window.document.querySelector('[role="status"]'), null);
    assert.equal(
      dom.window.document.querySelector('[data-testid="timeline-load-older"]')?.textContent?.trim(),
      '加载更早',
    );
    const list = dom.window.document.querySelector('.timeline-list');
    assert.ok(list);
    Object.defineProperty(list, 'scrollHeight', {configurable: true, value: 1000});
    Object.defineProperty(list, 'clientHeight', {configurable: true, value: 240});
    await act(async () => {
      list.scrollTop = 80;
      list.dispatchEvent(new dom.window.Event('scroll'));
    });
    await act(async () => click(dom, '[data-testid="timeline-load-older"]'));
    assert.ok(dom.window.document.querySelector('[role="status"]'));
    await act(async () => click(dom, '[data-testid="timeline-resume"]'));
    assert.equal(dom.window.document.querySelector('[role="status"]'), null);
    assert.equal(
      dom.window.document.querySelector('[data-testid="timeline-load-older"]')?.textContent?.trim(),
      '加载更早',
    );
  }, bridge);
});

test('stale history failures cannot show an error or finish a newer request after switching runs or resuming', async () => {
  const pages: ReturnType<typeof deferred<EventPage>>[] = [];
  const bridge = {
    page: () => {
      const pending = deferred<EventPage>();
      pages.push(pending);
      return pending.promise;
    },
  } as Pick<MonitorBridge, 'page'> as MonitorBridge;
  await renderTimeline(async ({dom, render}) => {
    await act(async () => render(range(11, 20)));
    await act(async () => click(dom, '[data-testid="timeline-load-older"]'));
    await act(async () => render(range(31, 40, 'run-b'), 'run-b'));
    await act(async () => click(dom, '[data-testid="timeline-load-older"]'));
    await act(async () => pages[0].reject(new Error('old run failed')));
    const button = () => dom.window.document.querySelector<HTMLButtonElement>('[data-testid="timeline-load-older"]');
    assert.equal(dom.window.document.querySelector('[role="status"]'), null);
    assert.equal(button()?.disabled, true);
    assert.equal(button()?.textContent?.trim(), '正在加载…');
    await act(async () => pages[1].resolve({events: range(21, 30, 'run-b'), truncated: false}));
    await act(async () => click(dom, '[data-testid="timeline-load-older"]'));
    await act(async () => click(dom, '[data-testid="timeline-resume"]'));
    await act(async () => click(dom, '[data-testid="timeline-load-older"]'));
    await act(async () => pages[2].reject(new Error('old history view failed')));
    assert.equal(dom.window.document.querySelector('[role="status"]'), null);
    assert.equal(button()?.disabled, true);
    assert.equal(button()?.textContent?.trim(), '正在加载…');
    await act(async () => pages[3].resolve({events: [], truncated: false}));
    assert.equal(button()?.textContent?.trim(), '没有更早的事件');
    assert.deepEqual(
      renderedCursors(dom.window.document),
      range(31, 40, 'run-b').map(event => event.cursor),
    );
  }, bridge);
});

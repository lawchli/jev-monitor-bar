import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {JSDOM} from 'jsdom';
import {act, createElement, type ReactElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import type {ReplayData} from '../src/ipc';
import {createMonitorHandlers, type IpcSender, type RendererContents, type ReplayFileIO} from '../src/main/ipc-api';
import {validateEvent, type StoredEvent} from '../src/protocol';
import {sanitizeEvent} from '../src/redact';
import {REPLAY_EVENT_LIMIT, exportFileName, pageReplay, parseReplay, replaySnapshot} from '../src/replay';
import {ReplayView} from '../src/renderer/replay/ReplayView';
import {EventStore} from '../src/store';

const parsers = {validateEvent, sanitizeEvent};
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jev-replay-'));

function monitorLine(sequence: number, extra: Record<string, unknown> = {}, payload: Record<string, unknown> = {}) {
  return JSON.stringify({
    schema_version: 1,
    event_id: `e${sequence}`,
    run_id: 'run-1',
    producer_id: 'host-1',
    sequence,
    occurred_at: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString(),
    type: 'heartbeat',
    payload,
    ...extra,
  });
}

test('parseReplay accepts CRLF, stored rows, and plain events', () => {
  const plain = monitorLine(1, {}, {summary: 'password=hunter2', diagnostic: {token: 'secret'}});
  const stored = JSON.stringify({
    ...JSON.parse(monitorLine(2)),
    received_at: '2026-01-01T00:00:02.000Z',
    cursor: 40,
  });
  const text = `${plain}\r\n\r\nnot-json\r\n${stored}\r\n`;
  const parsed = parseReplay(text, parsers);
  assert.equal(parsed.invalidLines, 1);
  assert.equal(parsed.truncated, false);
  assert.equal(parsed.events.length, 2);
  assert.equal(parsed.events[0].cursor, 1);
  assert.equal(parsed.events[0].received_at, parsed.events[0].occurred_at);
  assert.equal(parsed.events[0].payload.summary, 'password=[REDACTED]');
  assert.equal('diagnostic' in parsed.events[0].payload, false);
  assert.equal(parsed.events[1].cursor, 40);
  assert.equal(parsed.events[1].received_at, '2026-01-01T00:00:02.000Z');
});

test('parseReplay rejects a present invalid cursor or received_at', () => {
  const text = [
    monitorLine(1, {cursor: 1.5}),
    monitorLine(2, {received_at: 12345}),
    monitorLine(3, {received_at: ''}),
    monitorLine(4, {cursor: -3}),
    monitorLine(5),
  ].join('\n');
  const parsed = parseReplay(text, parsers);
  assert.equal(parsed.invalidLines, 2);
  assert.equal(parsed.events.length, 3);
  assert.equal(parsed.events[0].cursor, 3);
  assert.equal(parsed.events[0].received_at, '');
  assert.equal(parsed.events[1].cursor, -3);
  assert.equal(parsed.events[1].received_at, parsed.events[1].occurred_at);
  assert.equal(parsed.events[2].cursor, 5);
  assert.equal(parsed.events[2].received_at, parsed.events[2].occurred_at);

  const colliding = parseReplay(`${monitorLine(1)}\n${monitorLine(2, {cursor: 1})}`, parsers);
  assert.equal(colliding.invalidLines, 0);
  assert.deepEqual(
    colliding.events.map(event => event.cursor),
    [1, 1],
  );
});

test('parseReplay keeps the newest 20000 events', () => {
  const lines = Array.from({length: REPLAY_EVENT_LIMIT + 1}, (_item, index) => monitorLine(index + 1));
  lines.splice(3, 0, '{');
  const parsed = parseReplay(lines.join('\n'), parsers);
  assert.equal(parsed.events.length, REPLAY_EVENT_LIMIT);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.omitted, 1);
  assert.equal(parsed.invalidLines, 1);
  assert.equal(parsed.events[0].event_id, 'e2');
  assert.equal(parsed.events.at(-1)?.event_id, `e${REPLAY_EVENT_LIMIT + 1}`);
});

test('replaying the first N events matches an EventStore loaded with those rows', () => {
  const dir = tempDir();
  const store = new EventStore(path.join(dir, 'events'));
  const started = {
    schema_version: 1,
    event_id: 'start',
    run_id: 'run-1',
    producer_id: 'host-1',
    sequence: 1,
    occurred_at: '2026-01-01T00:00:01.000Z',
    type: 'run.started',
    payload: {name: '演示任务', simulated: true},
  };
  const beat = JSON.parse(monitorLine(2)) as StoredEvent;
  const done = {
    schema_version: 1,
    event_id: 'done',
    run_id: 'run-1',
    producer_id: 'host-1',
    sequence: 3,
    occurred_at: '2026-01-01T00:00:03.000Z',
    type: 'run.completed',
    payload: {},
  };
  assert.equal(store.ingest(started).accepted, true);
  assert.equal(store.ingest(beat).accepted, true);
  assert.equal(store.ingest(done).accepted, true);
  const parsed = parseReplay(store.exportLines().text, parsers);
  assert.deepEqual(replaySnapshot(parsed.events, parsed.events.length, 'run-1').run, store.snapshot('run-1').run);

  const partialDir = tempDir();
  const partialEvents = path.join(partialDir, 'events');
  fs.mkdirSync(partialEvents);
  fs.writeFileSync(
    path.join(partialEvents, 'events-00000001.jsonl'),
    parsed.events
      .slice(0, 2)
      .map(event => JSON.stringify(event))
      .join('\n') + '\n',
  );
  const partial = new EventStore(partialEvents);
  assert.deepEqual(replaySnapshot(parsed.events, 2, 'run-1').run, partial.snapshot('run-1').run);
  assert.equal(replaySnapshot(parsed.events, 2, 'run-1').run?.status, 'waiting');
  assert.equal(store.snapshot('run-1').run?.status, 'completed');
});

function storedRun(index: number): StoredEvent {
  const n = index + 1;
  const occurred = '2026-01-01T00:00:01.000Z';
  return {
    schema_version: 1,
    event_id: `e${n}`,
    run_id: `run-${String(n).padStart(3, '0')}`,
    producer_id: 'host-1',
    sequence: 1,
    occurred_at: occurred,
    type: 'run.started',
    payload: {name: `任务${n}`},
    received_at: occurred,
    cursor: n,
  };
}

test('a replay longer than 200 runs keeps focus on a surviving run', () => {
  const events = Array.from({length: 201}, (_item, index) => storedRun(index));
  const opened = replaySnapshot(events, events.length);
  assert.equal(opened.runs.length, 200);
  assert.ok(opened.run);
  assert.equal(
    opened.runs.some(run => run.id === opened.run?.id),
    true,
  );
  assert.equal(opened.run?.id, 'run-201');
  assert.equal(
    opened.runs.some(run => run.id === 'run-001'),
    false,
  );

  const evicted = replaySnapshot(events, events.length, 'run-001');
  assert.ok(evicted.run);
  assert.equal(evicted.run?.id, 'run-201');
  assert.equal(
    evicted.runs.some(run => run.id === evicted.run?.id),
    true,
  );
  assert.equal(evicted.runs.length, 200);
  assert.equal(
    evicted.runs.some(run => run.id === 'run-001'),
    false,
  );
  assert.equal(
    evicted.events.every(event => event.run_id === evicted.run?.id),
    true,
  );
  assert.equal(evicted.events.length, 1);
});

test('replay drops an older ended run before an earlier unfinished run', () => {
  const at = (second: number) => `2026-01-01T00:00:${String(second).padStart(2, '0')}.000Z`;
  const row = (
    cursor: number,
    runId: string,
    type: 'run.started' | 'run.completed',
    received: string,
  ): StoredEvent => ({
    schema_version: 1,
    event_id: `e${cursor}`,
    run_id: runId,
    producer_id: 'host-1',
    sequence: 1,
    occurred_at: received,
    type,
    payload: type === 'run.started' ? {name: runId} : {},
    received_at: received,
    cursor,
  });
  const events = [
    row(1, 'run-live-old', 'run.started', at(0)),
    row(2, 'run-ended-old', 'run.completed', at(1)),
    ...Array.from({length: 199}, (_item, index) => row(index + 3, `run-live-${index + 3}`, 'run.started', at(2))),
  ];
  const snapshot = replaySnapshot(events, events.length);
  assert.equal(snapshot.runs.length, 200);
  assert.equal(
    snapshot.runs.some(run => run.id === 'run-live-old'),
    true,
  );
  assert.equal(
    snapshot.runs.some(run => run.id === 'run-ended-old'),
    false,
  );
  assert.ok(snapshot.run);
  assert.equal(
    snapshot.runs.some(run => run.id === snapshot.run?.id),
    true,
  );
  assert.equal(
    snapshot.events.every(event => event.run_id === snapshot.run?.id),
    true,
  );
});

function heartbeat(cursor: number, runId = 'run-1'): StoredEvent {
  const occurred = new Date(Date.UTC(2026, 0, 1, 0, 0, cursor % 60)).toISOString();
  return {
    schema_version: 1,
    event_id: `${runId}-${cursor}`,
    run_id: runId,
    producer_id: 'host-1',
    sequence: cursor,
    occurred_at: occurred,
    type: 'heartbeat',
    payload: {},
    received_at: occurred,
    cursor,
  };
}

test('pageReplay reads earlier rows from the replay prefix', () => {
  const events = Array.from({length: 450}, (_item, index) => heartbeat(index + 1));
  const tailStart = events.slice(-400)[0]?.cursor;
  assert.equal(tailStart, 51);
  assert.deepEqual(
    pageReplay(events, events.length, {runId: 'run-1', beforeCursor: tailStart, limit: 100}).map(event => event.cursor),
    Array.from({length: 50}, (_item, index) => index + 1),
  );
  assert.deepEqual(
    pageReplay(events, 40, {runId: 'run-1', beforeCursor: 30, limit: 100}).map(event => event.cursor),
    Array.from({length: 29}, (_item, index) => index + 1),
  );
  assert.deepEqual(
    pageReplay(events, events.length, {runId: 'run-2', beforeCursor: 100}).map(event => event.cursor),
    [],
  );
  assert.deepEqual(pageReplay(events, events.length, {runId: 'run-1', beforeCursor: 1}), []);
  const wide = Array.from({length: 600}, (_item, index) => heartbeat(index + 1));
  assert.equal(pageReplay(wide, wide.length, {limit: 0}).length, 1);
  assert.equal(pageReplay(wide, wide.length, {limit: 900}).length, 500);
});

function storedLine(sequence: number, payload: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    ...JSON.parse(monitorLine(sequence, {}, payload)),
    received_at: '2026-01-01T00:00:00.000Z',
    cursor: sequence,
    ...extra,
  });
}

test('export redacts secrets and keeps one validated event per line', async () => {
  const dir = tempDir();
  const events = path.join(dir, 'events');
  fs.mkdirSync(events);
  const secret = storedLine(1, {
    summary: 'password=hunter2 Bearer abc.def.ghi',
    diagnostic: {token: 'secret-token'},
  });
  const second = storedLine(2, {summary: '第二条'});
  const third = storedLine(3, {summary: '第三条'});
  const badCursor = storedLine(4, {summary: '小数游标'}, {cursor: 1.5});
  const file1 = path.join(events, 'events-00000001.jsonl');
  const empty = path.join(events, 'events-00000002.jsonl');
  const file2 = path.join(events, 'events-00000003.jsonl');
  const file3 = path.join(events, 'events-00000004.jsonl');
  fs.writeFileSync(file1, `${secret}\r\n{"torn"`);
  fs.writeFileSync(empty, '');
  fs.writeFileSync(file2, second);
  fs.writeFileSync(file3, `not-json\n${badCursor}\n${third}\n`);
  const glued = parseReplay(`${fs.readFileSync(file1, 'utf8')}${fs.readFileSync(file2, 'utf8')}`, parsers);
  assert.equal(
    glued.events.some(event => event.event_id === 'e2'),
    false,
  );

  const store = new EventStore(events);
  const exported = store.exportLines();
  assert.equal(exported.skipped, 3);
  assert.equal(exported.text.endsWith('\n'), true);
  assert.doesNotMatch(exported.text, /hunter2|abc\.def\.ghi|secret-token/);
  assert.match(fs.readFileSync(file1, 'utf8'), /hunter2/);
  const lines = exported.text.split('\n').filter(line => line.length > 0);
  assert.deepEqual(
    lines.map(line => JSON.parse(line).event_id),
    ['e1', 'e2', 'e3'],
  );
  assert.equal(JSON.parse(lines[0]).payload.summary, 'password=[REDACTED] Bearer [REDACTED]');
  assert.equal('diagnostic' in JSON.parse(lines[0]).payload, false);
  assert.equal(
    lines.every(line => !line.includes('\n') && JSON.parse(line).event_id),
    true,
  );

  const parsed = parseReplay(exported.text, parsers);
  assert.equal(parsed.invalidLines, 0);
  assert.deepEqual(
    parsed.events.map(event => event.event_id),
    ['e1', 'e2', 'e3'],
  );
  assert.equal(parsed.events[0].payload.summary, 'password=[REDACTED] Bearer [REDACTED]');

  const frame = {url: 'file:///renderer/index.html'};
  const contents: RendererContents = {mainFrame: frame};
  const handlers = createMonitorHandlers({
    store,
    controller: {setMode: mode => mode, setPinned: pinned => pinned},
    getStatus: () => {
      throw new Error('unused');
    },
    rendererUrl: frame.url,
    contents,
  });
  let saved = '';
  const result = await handlers.exportEvents(
    {sender: contents, senderFrame: frame},
    {
      saveDialog: async () => '/tmp/redacted.jsonl',
      openDialog: async () => undefined,
      readBounded: () => ({ok: true, text: saved}),
      write: (_file, contents) => {
        saved = contents;
      },
    },
  );
  assert.equal(result.saved, true);
  assert.equal(result.skipped, 3);
  assert.equal(saved, exported.text);
  assert.equal(result.bytes, Buffer.byteLength(exported.text));
});

test('partial export reports unreadable segments through IPC while preserving readable events', async () => {
  const dir = tempDir();
  const events = path.join(dir, 'events');
  const store = new EventStore(events);
  try {
    store.ingest(JSON.parse(monitorLine(1)));
    // A directory with a segment filename is unreadable as JSONL on every supported platform.
    fs.mkdirSync(path.join(events, 'events-00000099.jsonl'));
    const frame = {url: 'app://renderer/index.html'};
    const contents: RendererContents = {mainFrame: frame};
    const handlers = createMonitorHandlers({
      store,
      controller: {setMode: mode => mode, setPinned: pinned => pinned},
      getStatus: () => {
        throw new Error('unused');
      },
      rendererUrl: frame.url,
      contents,
    });
    let saved = '';
    const result = await handlers.exportEvents(
      {sender: contents, senderFrame: frame},
      {
        saveDialog: async () => '/tmp/partial-export.jsonl',
        openDialog: async () => undefined,
        readBounded: () => ({ok: true, text: saved}),
        write: (_file, text) => {
          saved = text;
        },
      },
    );
    assert.equal(result.saved, true);
    assert.equal(result.unreadable, 1);
    assert.equal(result.skipped, 0);
    const parsed = parseReplay(saved, parsers);
    assert.equal(parsed.invalidLines, 0);
    assert.deepEqual(
      parsed.events.map(event => event.event_id),
      ['e1'],
    );
  } finally {
    store.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('export and open replay stay inside the monitor window', async () => {
  const dir = tempDir();
  const store = new EventStore(path.join(dir, 'events'));
  store.ingest(JSON.parse(monitorLine(1)));
  const frame = {url: 'file:///renderer/index.html'};
  const contents: RendererContents = {mainFrame: frame};
  const handlers = createMonitorHandlers({
    store,
    controller: {setMode: mode => mode, setPinned: pinned => pinned},
    getStatus: () => {
      throw new Error('unused');
    },
    rendererUrl: frame.url,
    contents,
  });
  const event: IpcSender = {sender: contents, senderFrame: frame};
  let saved = '';
  let dialogs = 0;
  const files = (overrides: Partial<ReplayFileIO> = {}): ReplayFileIO => ({
    saveDialog: async defaultPath => {
      dialogs += 1;
      assert.match(defaultPath, /^jev-monitor-export-\d{8}-\d{6}\.jsonl$/);
      return '/tmp/export.jsonl';
    },
    openDialog: async () => '/tmp/export.jsonl',
    readBounded: () => ({ok: true, text: saved || store.exportLines().text}),
    write: (_file, contents) => {
      saved = contents;
    },
    ...overrides,
  });

  const exported = await handlers.exportEvents(event, files());
  assert.equal(exported.saved, true);
  assert.equal(exported.path, '/tmp/export.jsonl');
  assert.equal(saved, store.exportLines().text);
  assert.equal(exported.skipped, 0);
  assert.equal(exported.bytes, Buffer.byteLength(saved));

  const opened = await handlers.openReplay(event, files());
  assert.equal(opened?.file, '/tmp/export.jsonl');
  assert.equal(opened?.events.length, 1);
  assert.equal(opened?.invalidLines, 0);

  const canceled = await handlers.exportEvents(
    event,
    files({
      saveDialog: async () => undefined,
    }),
  );
  assert.deepEqual(canceled, {saved: false});

  const closed = await handlers.openReplay(
    event,
    files({
      openDialog: async () => undefined,
      readBounded: () => {
        throw new Error('should not read');
      },
    }),
  );
  assert.equal(closed, null);

  await assert.rejects(
    () =>
      handlers.openReplay(
        event,
        files({
          readBounded: () => ({ok: false, reason: 'too-large'}),
        }),
      ),
    /50 MiB/,
  );

  await assert.rejects(() => handlers.exportEvents({sender: {}, senderFrame: frame}, files()), /Rejected IPC sender/);
  assert.equal(dialogs, 1);
  assert.match(exportFileName(new Date(2026, 8, 23, 3, 4, 5)), /^jev-monitor-export-\d{8}-\d{6}\.jsonl$/);
});

test('replay controls step through events without calling the live bridge', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  type ActGlobal = typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?: boolean};
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
  const render = (node: ReactElement) => {
    root ??= createRoot(rootElement);
    root.render(node);
  };
  const occurred = '2026-01-01T00:00:01.000Z';
  const replay: ReplayData = {
    file: '/tmp/jev-monitor-export-20260923-030405.jsonl',
    invalidLines: 2,
    truncated: false,
    events: [1, 2].map(cursor => ({
      schema_version: 1 as const,
      event_id: `e${cursor}`,
      run_id: 'run-1',
      producer_id: 'host-1',
      sequence: cursor,
      occurred_at: occurred,
      type: 'run.started' as const,
      payload: {name: '演示任务', simulated: true},
      received_at: occurred,
      cursor,
    })),
  };
  try {
    await act(async () => {
      render(createElement(ReplayView, {replay, now: Date.parse(occurred), onExit: () => {}}));
    });
    const text = () => dom.window.document.body.textContent ?? '';
    assert.equal(text().includes('回放：jev-monitor-export-20260923-030405.jsonl（不影响实时接收）'), true);
    assert.equal(text().includes('无效行 2'), true);
    assert.equal(text().includes('第 2 / 2 条'), true);
    const previousButton = Array.from(dom.window.document.querySelectorAll('button')).find(
      node => node.textContent === '上一条',
    );
    await act(async () => {
      previousButton?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
    });
    assert.equal(text().includes('第 1 / 2 条'), true);
    assert.equal(text().includes('演示任务'), true);
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

async function renderReplay(replay: ReplayData, check: (dom: JSDOM) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  type ActGlobal = typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?: boolean};
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
  const render = (node: ReactElement) => {
    root ??= createRoot(rootElement);
    root.render(node);
  };
  try {
    await act(async () => {
      render(createElement(ReplayView, {replay, now: Date.parse('2026-01-01T00:00:01.000Z'), onExit: () => {}}));
    });
    await check(dom);
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

test('opening more than 200 runs still shows the run picker', async () => {
  const events = Array.from({length: 201}, (_item, index) => storedRun(index));
  const replay: ReplayData = {
    file: '/tmp/many-runs.jsonl',
    invalidLines: 0,
    truncated: false,
    events,
  };
  await renderReplay(replay, async dom => {
    const picker = () =>
      dom.window.document.querySelector('[data-testid="replay-run-picker"]') as HTMLSelectElement | null;
    const text = () => dom.window.document.body.textContent ?? '';
    assert.ok(picker());
    assert.equal(picker()?.options.length, 200);
    assert.equal(picker()?.value, 'run-201');
    assert.equal(text().includes('任务201'), true);
    assert.equal(text().includes('尚未回放到事件'), false);
    await act(async () => {
      const select = picker();
      assert.ok(select);
      const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value')?.set;
      setValue?.call(select, 'run-200');
      select.dispatchEvent(new dom.window.Event('change', {bubbles: true}));
    });
    assert.equal(picker()?.value, 'run-200');
    assert.equal(text().includes('任务200'), true);
    assert.equal(text().includes('尚未回放到事件'), false);
  });
});

test('a truncated replay says how many earlier events were left out', async () => {
  const replay: ReplayData = {
    file: '/tmp/long-export.jsonl',
    invalidLines: 1,
    truncated: true,
    omitted: 3243,
    events: [storedRun(0), storedRun(1)],
  };
  await renderReplay(replay, async dom => {
    const banner = dom.window.document.querySelector('[data-testid="replay-banner"]')?.textContent ?? '';
    assert.equal(
      banner,
      '回放：long-export.jsonl（不影响实时接收） · 无效行 1 · 只保留最近 2 条，已略过更早的 3243 条',
    );
  });
});

test('the run picker stays when the selected run is outside the prefix', async () => {
  const replay: ReplayData = {
    file: '/tmp/two-runs.jsonl',
    invalidLines: 0,
    truncated: false,
    events: [storedRun(0), storedRun(1), storedRun(2)],
  };
  await renderReplay(replay, async dom => {
    const picker = () =>
      dom.window.document.querySelector('[data-testid="replay-run-picker"]') as HTMLSelectElement | null;
    const text = () => dom.window.document.body.textContent ?? '';
    const heading = () => dom.window.document.querySelector('.run-name')?.textContent ?? '';
    assert.equal(picker()?.value, 'run-003');
    assert.equal(heading().includes('任务3'), true);
    const choose = async (id: string) => {
      await act(async () => {
        const select = picker();
        assert.ok(select);
        const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value')?.set;
        setValue?.call(select, id);
        select.dispatchEvent(new dom.window.Event('change', {bubbles: true}));
      });
    };
    const previous = () =>
      Array.from(dom.window.document.querySelectorAll('button')).find(node => node.textContent === '上一条');
    const stepBack = async () => {
      await act(async () => {
        previous()?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
      });
    };
    await choose('run-003');
    await stepBack();
    assert.equal(text().includes('第 2 / 3 条'), true);
    assert.equal(text().includes('尚未回放到事件'), false);
    assert.equal(picker()?.options.length, 2);
    assert.equal(picker()?.value, 'run-002');
    assert.equal(heading().includes('任务2'), true);
    await choose('run-001');
    assert.equal(heading().includes('任务1'), true);
    assert.equal(text().includes('尚未回放到事件'), false);
    await choose('run-002');
    assert.equal(heading().includes('任务2'), true);
    await stepBack();
    assert.equal(text().includes('第 1 / 3 条'), true);
    assert.ok(picker());
    assert.equal(picker()?.value, 'run-001');
    assert.equal(heading().includes('任务1'), true);
    assert.equal(text().includes('尚未回放到事件'), false);
    await stepBack();
    assert.equal(text().includes('第 0 / 3 条'), true);
    assert.equal(picker(), null);
    assert.equal(text().includes('尚未回放到事件'), true);
  });
});

test('loading earlier replay events reads the prefix instead of stopping', async () => {
  const events = Array.from({length: 450}, (_item, index) => heartbeat(index + 1));
  const replay: ReplayData = {
    file: '/tmp/long-run.jsonl',
    invalidLines: 0,
    truncated: false,
    events,
  };
  await renderReplay(replay, async dom => {
    const button = (label: string) =>
      Array.from(dom.window.document.querySelectorAll('button')).find(node => node.textContent === label);
    await act(async () => {
      button('时间线')?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
    });
    const items = () => dom.window.document.querySelectorAll('[data-testid="timeline-item"]');
    const older = () => dom.window.document.querySelector('[data-testid="timeline-load-older"]');
    const cursors = () => Array.from(items(), node => Number((node as Element).getAttribute('data-cursor')));
    assert.equal(items().length, 400);
    assert.equal(older()?.textContent, '加载更早');
    await act(async () => {
      older()?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
    });
    assert.equal(cursors()[0], 1);
    assert.ok(cursors().length <= 500);
    assert.equal(older()?.textContent, '加载更早');
    assert.equal(dom.window.document.body.textContent?.includes('没有更早的事件'), false);
    assert.equal(dom.window.document.body.textContent?.includes('超出保留窗口'), false);
    await act(async () => {
      older()?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
    });
    assert.equal(older()?.textContent, '没有更早的事件');
    assert.equal(cursors()[0], 1);
  });
});

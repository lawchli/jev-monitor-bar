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
import {REPLAY_EVENT_LIMIT, exportFileName, parseReplay, replaySnapshot} from '../src/replay';
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

test('parseReplay keeps at most 20000 events', () => {
  const lines = Array.from({length: REPLAY_EVENT_LIMIT + 1}, (_item, index) => monitorLine(index + 1));
  lines.splice(3, 0, '{');
  const parsed = parseReplay(lines.join('\n'), parsers);
  assert.equal(parsed.events.length, REPLAY_EVENT_LIMIT);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.invalidLines, 1);
  assert.equal(parsed.events[0].event_id, 'e1');
  assert.equal(parsed.events.at(-1)?.event_id, `e${REPLAY_EVENT_LIMIT}`);
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
  const parsed = parseReplay(store.exportLines(), parsers);
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
    readBounded: () => ({ok: true, text: saved || store.exportLines()}),
    write: (_file, contents) => {
      saved = contents;
    },
    ...overrides,
  });

  const exported = await handlers.exportEvents(event, files());
  assert.equal(exported.saved, true);
  assert.equal(exported.path, '/tmp/export.jsonl');
  assert.equal(saved, store.exportLines());
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

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {JSDOM} from 'jsdom';
import {act, createElement, type ReactElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import type {MonitorBridge, ReplayData, Snapshot} from '../src/ipc';
import {createMonitorHandlers, type IpcSender, type RendererContents} from '../src/main/ipc-api';
import type {EventType, Payload, StoredEvent} from '../src/protocol';
import {compactModel} from '../src/renderer/compact/model';
import {decisionCards, decisionChain, runSummary} from '../src/renderer/expanded/model';
import {ReplayView} from '../src/renderer/replay/ReplayView';
import {EventStore} from '../src/store';

// Acceptance for AGENT_DIRECTION_AUDIT.md A1, A4 and A7, written against the literal 验收 lines.

// ExpandedView imports its stylesheet. The test runner has no CSS loader, so a stylesheet loads as an empty module.
require.extensions['.css'] = () => {};
const {ExpandedView} =
  require('../src/renderer/expanded/ExpandedView') as typeof import('../src/renderer/expanded/ExpandedView');

type ActGlobal = typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?: boolean};

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jev-acceptance-'));
const at = (second: number) => new Date(Date.UTC(2026, 0, 1) + second * 1000).toISOString();
const executedOrSuccess = /已执行|实际执行|执行中|成功/;

function source(runId: string) {
  let sequence = 0;
  return (type: EventType, payload: Payload = {}, ids: Partial<StoredEvent> = {}) => {
    sequence += 1;
    return {
      schema_version: 1 as const,
      event_id: `${runId}-${sequence}`,
      run_id: runId,
      producer_id: 'host-1',
      sequence,
      occurred_at: at(sequence),
      type,
      payload,
      ...ids,
    };
  };
}

function ingest(store: EventStore, rows: unknown[]) {
  for (const row of rows) assert.equal(store.ingest(row).accepted, true);
}

/** IPC structured-clones snapshots, so the renderer never shares the store's live RunState. */
function snap(store: EventStore, runId: string): Snapshot {
  return structuredClone(store.snapshot(runId));
}

function liveBridge(store: EventStore): MonitorBridge {
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
  const sender: IpcSender = {sender: contents, senderFrame: frame};
  return {
    snapshot: async runId => structuredClone(handlers.snapshot(sender, runId)),
    page: async query => structuredClone(handlers.page(sender, query)),
    status: async () => {
      throw new Error('unused');
    },
    onChanged: () => () => {},
    setMode: async mode => mode,
    setPinned: async pinned => pinned,
    exportEvents: async () => ({saved: false}),
    openReplay: async () => null,
  };
}

function expanded(snapshot: Snapshot, bridge: MonitorBridge): ReactElement {
  return createElement(ExpandedView, {
    snapshot,
    now: Date.parse(at(0)),
    selectedRunId: snapshot.run?.id,
    onSelectRun: () => {},
    mode: 'expanded',
    onSetMode: () => {},
    pinned: true,
    onTogglePinned: () => {},
    bridge,
    onExport: () => {},
    onOpenReplay: () => {},
  });
}

interface Page {
  dom: JSDOM;
  render(node: ReactElement): Promise<void>;
  click(selector: string): Promise<void>;
  text(selector?: string): string;
  all(selector: string): string[];
}

async function withDom(run: (page: Page) => Promise<void>) {
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
  const document = dom.window.document;
  const page: Page = {
    dom,
    render: async node => {
      await act(async () => {
        root ??= createRoot(rootElement);
        root.render(node);
      });
    },
    click: async selector => {
      const node = document.querySelector(selector);
      assert.ok(node, selector);
      await act(async () => {
        node.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
      });
    },
    text: selector =>
      selector ? (document.querySelector(selector)?.textContent ?? '') : (document.body.textContent ?? ''),
    all: selector => Array.from(document.querySelectorAll(selector), node => node.textContent ?? ''),
  };
  try {
    await run(page);
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

// ---------- A1：选择不能展示成已经执行 ----------

const decisionIds = {decision_id: 'd1', request_id: 'req-1', question_id: 'q-1'};
const attemptIds = {decision_id: 'd1', action_id: 'act-1', attempt_id: 't1'};

function choiceRun(...tail: ((next: ReturnType<typeof source>) => unknown)[]) {
  const store = new EventStore(tempDir());
  const next = source('run-1');
  ingest(store, [
    next('run.started', {name: '选择验收', simulated: true}),
    next('decision.started', {kind: 'choice', question: '走哪边', candidates: {A: '左', B: '右'}}, decisionIds),
    next('decision.resolved', {kind: 'choice', choice: 'A', probabilities: {A: 0.7, B: 0.3}}, decisionIds),
    ...tail.map(make => make(next)),
  ]);
  return store;
}

async function expandedTexts(store: EventStore) {
  const snapshot = snap(store, 'run-1');
  const out = {
    chain: [] as string[],
    cardStatus: [] as string[],
    badges: [] as string[],
    rows: [] as string[],
    summary: '',
  };
  await withDom(async page => {
    await page.render(expanded(snapshot, liveBridge(store)));
    out.chain = page.all('[data-testid="decision-chain"]');
    out.cardStatus = page.all('.decision-head [class^="tone-"]');
    out.badges = page.all('.decision-head .badge');
    out.summary = page.text('.summary-bar');
    await page.click('[data-testid="tab-execution"]');
    out.rows = page.all('[data-testid="attempt-row"]');
  });
  return out;
}

test('A1 acceptance: only action.selected reads as an application choice pending execution, never executed or successful', async () => {
  const store = choiceRun(next => next('action.selected', {action: 'A', source: 'model'}, attemptIds));
  const snapshot = snap(store, 'run-1');
  assert.ok(snapshot.run);
  const chain = 'JEV 选择 A → 应用选择/待执行 A';
  assert.equal(decisionChain(snapshot.run, 'd1'), chain);
  assert.equal(executedOrSuccess.test(chain), false);

  const view = await expandedTexts(store);
  assert.deepEqual(view.chain, [chain]);
  assert.deepEqual(view.cardStatus, ['已选择']);
  assert.equal(view.summary.includes('状态 已选择'), true);
  assert.equal(view.summary.includes('验证成功 0 / 已验证 0'), true);
  assert.equal(view.rows.length, 1);
  assert.equal(view.rows[0].includes('已选择'), true);
  assert.equal(executedOrSuccess.test(view.rows[0]), false);

  const compact = compactModel(snapshot, undefined, Date.parse(at(10)), 'run-1');
  assert.equal(compact.execStatus, '已选择');
  assert.equal(executedOrSuccess.test(`${compact.actionText} ${compact.execStatus} ${compact.runStatus}`), false);
});

test('A1 acceptance: started, completed-unverified and failed verification each say only what their events prove', async () => {
  const selected = (next: ReturnType<typeof source>) =>
    next('action.selected', {action: 'A', source: 'model'}, attemptIds);
  const started = (next: ReturnType<typeof source>) => next('action.started', {}, attemptIds);
  const completed = (next: ReturnType<typeof source>) => next('action.completed', {}, attemptIds);

  const running = await expandedTexts(choiceRun(selected, started));
  assert.deepEqual(running.chain, ['JEV 选择 A → 执行中 A']);
  assert.equal(/已执行|实际执行|成功|验证：/.test(running.chain[0]), false);
  assert.equal(running.rows[0].includes('执行中'), true);
  assert.equal(/已执行|成功/.test(running.rows[0]), false);

  const unverified = await expandedTexts(choiceRun(selected, started, completed));
  assert.deepEqual(unverified.chain, ['JEV 选择 A → 已执行待验证 A']);
  assert.equal(/成功|验证：|实际执行/.test(unverified.chain[0]), false);
  assert.equal(unverified.rows[0].includes('已执行待验证'), true);
  assert.equal(unverified.rows[0].includes('成功'), false);
  assert.equal(unverified.summary.includes('验证成功 0 / 已验证 0；验证失败 0；未知 0；未验证 1'), true);

  const failed = await expandedTexts(
    choiceRun(selected, started, completed, next =>
      next(
        'verification.completed',
        {result: 'failed', checks: [{name: '到达', observed: '未到达', result: 'failed'}]},
        attemptIds,
      ),
    ),
  );
  // PROTOCOL.md: 已执行待验证 means completed with no verification yet, so it cannot sit next to a verification result.
  assert.deepEqual(failed.chain, ['JEV 选择 A → 已执行 A → 验证：失败']);
  assert.equal(/成功|待验证|实际执行/.test(failed.chain[0]), false);
  assert.equal(failed.rows[0].includes('验证失败'), true);
  assert.equal(failed.rows[0].includes('成功'), false);
  assert.equal(failed.summary.includes('验证成功 0 / 已验证 1；验证失败 1'), true);
});

test('A1 acceptance: a rule-direct decision that has not started is marked as a rule and not as executed', async () => {
  const store = new EventStore(tempDir());
  const next = source('run-1');
  ingest(store, [
    next('run.started', {name: '规则验收'}),
    next(
      'action.selected',
      {action: '停下', source: 'rule', rule: '安全', rule_source: '策略', reason: '前方有人'},
      {action_id: 'rule-act', attempt_id: 't9'},
    ),
  ]);
  const snapshot = snap(store, 'run-1');
  assert.ok(snapshot.run);
  const [card] = decisionCards(snapshot.run);
  assert.equal(card.kind, 'rule');
  assert.equal(card.badge, '规则决策');
  assert.equal(card.statusText, '已选择');
  assert.equal(card.chain, '规则决策（规则 安全 · 来源 策略） → 应用选择/待执行 停下');
  assert.equal(card.chain.includes('JEV'), false);
  assert.equal(executedOrSuccess.test(card.chain), false);

  const view = await expandedTexts(store);
  assert.deepEqual(view.badges, ['规则决策']);
  assert.deepEqual(view.chain, [card.chain]);
  assert.deepEqual(view.cardStatus, ['已选择']);
  assert.equal(executedOrSuccess.test(view.rows[0]), false);
});

test('A1 acceptance: an application override is shown as the application, without inventing a rule source', async () => {
  const store = choiceRun(next => next('action.selected', {action: 'B', source: 'application'}, attemptIds));
  const snapshot = snap(store, 'run-1');
  assert.ok(snapshot.run);
  const chain = 'JEV 选择 A → 应用覆盖为 B → 应用选择/待执行 B';
  assert.equal(decisionChain(snapshot.run, 'd1'), chain);
  assert.equal(/规则|来源|未提供/.test(chain), false);
  assert.equal(executedOrSuccess.test(chain), false);
  const view = await expandedTexts(store);
  assert.deepEqual(view.chain, [chain]);
  const compact = compactModel(snapshot, undefined, Date.parse(at(10)), 'run-1');
  assert.equal(compact.actionText, 'B · 应用 · 已覆盖');
  assert.equal(compact.execStatus, '已选择');
  assert.equal(runSummary(snapshot.run, Date.parse(at(10))).statusText, '已选择');
});

// ---------- A4：历史可达，读历史时视口不跳 ----------

function longRun(store: EventStore, count: number) {
  const next = source('run-a');
  ingest(store, [next('run.started', {name: '长任务', simulated: true})]);
  const more = (n: number) =>
    ingest(
      store,
      Array.from({length: n}, () => next('heartbeat')),
    );
  more(count - 1);
  return more;
}

function cursors(page: Page): number[] {
  return Array.from(page.dom.window.document.querySelectorAll('[data-testid="timeline-item"]'), node =>
    Number(node.getAttribute('data-cursor')),
  );
}

function contiguous(values: number[]): boolean {
  return values.every((value, index) => index === 0 || value === values[index - 1] + 1);
}

/** Counts every write to the list's scrollTop, which is what moves the viewport. */
function watchScroll(page: Page, metrics = {scrollHeight: 4000, clientHeight: 240, scrollTop: 80}) {
  const list = page.dom.window.document.querySelector('.timeline-list');
  assert.ok(list);
  const writes: number[] = [];
  Object.defineProperty(list, 'scrollHeight', {configurable: true, get: () => metrics.scrollHeight});
  Object.defineProperty(list, 'clientHeight', {configurable: true, get: () => metrics.clientHeight});
  Object.defineProperty(list, 'scrollTop', {
    configurable: true,
    get: () => metrics.scrollTop,
    set: (value: number) => {
      writes.push(value);
      metrics.scrollTop = value;
    },
  });
  return {list, writes};
}

async function loadToFirst(page: Page) {
  let clicks = 0;
  while (!cursors(page).includes(1)) {
    await page.click('[data-testid="timeline-load-older"]');
    clicks += 1;
    assert.ok(cursors(page).length <= 500, `click ${clicks} rendered ${cursors(page).length} rows`);
    assert.ok(clicks <= 20, 'load earlier never reached event 1');
  }
  return clicks;
}

test('A4 acceptance: with 1,200 events, repeated load-earlier reaches event 1 while rendering at most 500 rows', async () => {
  const store = new EventStore(tempDir());
  longRun(store, 1200);
  const snapshot = snap(store, 'run-a');
  assert.equal(snapshot.events.length, 400);
  await withDom(async page => {
    await page.render(expanded(snapshot, liveBridge(store)));
    await page.click('[data-testid="tab-timeline"]');
    assert.deepEqual([cursors(page)[0], cursors(page).at(-1)], [801, 1200]);
    const clicks = await loadToFirst(page);
    assert.ok(clicks >= 8, 'the first 800 events can only come from paging');
    assert.equal(cursors(page)[0], 1);
    assert.equal(contiguous(cursors(page)), true);
    assert.equal(page.all('[data-testid="timeline-item"]')[0].includes('任务开始'), true);
    assert.equal(page.text('[data-testid="timeline-load-older"]'), '加载更早');
    await page.click('[data-testid="timeline-load-older"]');
    assert.equal(page.text('[data-testid="timeline-load-older"]'), '没有更早的事件');
    assert.equal(page.text().includes('超出保留窗口'), false);
    assert.equal(cursors(page)[0], 1);
  });
});

test('A4 acceptance: 600 events arriving while reading history keep the viewport and detail, count every arrival, and back-to-latest follows a gap-free tail', async () => {
  const store = new EventStore(tempDir());
  const more = longRun(store, 1200);
  const bridge = liveBridge(store);
  await withDom(async page => {
    const show = () => page.render(expanded(snap(store, 'run-a'), bridge));
    await show();
    await page.click('[data-testid="tab-timeline"]');
    await loadToFirst(page);
    await page.click('[data-cursor="1"]');
    const detail = () => page.text('.timeline-json');
    assert.equal(detail().includes('"event_id": "run-a-1"'), true);
    const pinned = cursors(page);
    const {writes} = watchScroll(page);

    // Snapshots arrive in batches as they would at the renderer's refresh rate.
    for (let batch = 1; batch <= 12; batch++) {
      more(50);
      await show();
      assert.deepEqual(cursors(page), pinned, `batch ${batch} moved the rows`);
      assert.equal(detail().includes('"event_id": "run-a-1"'), true);
      assert.equal(page.text('[data-testid="timeline-resume"]'), `已暂停跟随 · ${batch * 50} 条新事件 · 回到最新`);
    }
    assert.deepEqual(writes, [], 'reading history must not scroll the list');
    assert.equal(store.cursor, 1800);
    assert.equal(snap(store, 'run-a').run?.event_count, 1800);

    await page.click('[data-testid="timeline-resume"]');
    assert.equal(page.text('.follow-note'), '跟随最新');
    const tail = cursors(page);
    assert.equal(tail.at(-1), 1800);
    assert.ok(tail.length <= 500);
    assert.equal(contiguous(tail), true, `tail has a hole: ${tail[0]}…${tail.at(-1)}`);

    more(5);
    await show();
    assert.equal(cursors(page).at(-1), 1805);
    assert.equal(contiguous(cursors(page)), true);

    // History is still reachable after following again; the earlier "no earlier events" no longer applies.
    assert.equal(page.text('[data-testid="timeline-load-older"]'), '加载更早');
    const start = cursors(page)[0];
    await page.click('[data-testid="timeline-load-older"]');
    assert.ok(cursors(page)[0] < start);
    assert.ok(cursors(page).length <= 500);
    assert.equal(contiguous(cursors(page)), true);
  });
});

test('A4 acceptance: pausing by scrolling at the tail keeps those rows when 600 events land in one snapshot', async () => {
  const store = new EventStore(tempDir());
  const more = longRun(store, 1200);
  const bridge = liveBridge(store);
  await withDom(async page => {
    const show = () => page.render(expanded(snap(store, 'run-a'), bridge));
    await show();
    await page.click('[data-testid="tab-timeline"]');
    const {list, writes} = watchScroll(page);
    await act(async () => {
      list.dispatchEvent(new page.dom.window.Event('scroll'));
    });
    assert.equal(page.text('[data-testid="timeline-resume"]'), '已暂停跟随 · 0 条新事件 · 回到最新');
    const pinned = cursors(page);
    assert.deepEqual([pinned[0], pinned.at(-1)], [801, 1200]);
    await page.click('[data-cursor="900"]');
    writes.length = 0;
    // Refreshes coalesce while one is in flight, so a busy host can land all 600 in one snapshot of 400 rows.
    more(600);
    await show();
    assert.deepEqual(cursors(page), pinned);
    assert.equal(page.text('.timeline-json').includes('"event_id": "run-a-900"'), true);
    assert.deepEqual(writes, []);
    assert.equal(page.text('[data-testid="timeline-resume"]'), '已暂停跟随 · 600 条新事件 · 回到最新');
    await page.click('[data-testid="timeline-resume"]');
    const tail = cursors(page);
    assert.equal(tail.at(-1), 1800);
    assert.equal(contiguous(tail), true, `tail has a hole: ${tail[0]}…${tail.at(-1)}`);
  });
});

test('A4 acceptance: events dropped from the retention window are not reported as no earlier events', async () => {
  const store = new EventStore(tempDir(), 1000);
  longRun(store, 1200);
  assert.equal(store.events[0].cursor, 201);
  await withDom(async page => {
    await page.render(expanded(snap(store, 'run-a'), liveBridge(store)));
    await page.click('[data-testid="tab-timeline"]');
    for (let clicks = 0; clicks < 20 && !cursors(page).includes(201); clicks++) {
      await page.click('[data-testid="timeline-load-older"]');
      assert.ok(cursors(page).length <= 500);
    }
    assert.equal(cursors(page)[0], 201);
    await page.click('[data-testid="timeline-load-older"]');
    assert.equal(page.text('[data-testid="timeline-load-older"]'), '更早的事件已超出保留窗口');
    assert.equal(page.text().includes('没有更早的事件'), false);
    assert.equal(cursors(page)[0], 201);
  });
});

// ---------- A7：回放超过 200 个 run 仍有有效焦点 ----------

function replayRuns(count: number): StoredEvent[] {
  return Array.from({length: count}, (_item, index) => {
    const n = index + 1;
    return {
      schema_version: 1,
      event_id: `start-${n}`,
      run_id: `run-${String(n).padStart(3, '0')}`,
      producer_id: 'host-1',
      sequence: 1,
      occurred_at: at(n),
      type: 'run.started',
      payload: {name: `任务${n}`},
      received_at: at(n),
      cursor: n,
    };
  });
}

test('A7 acceptance: a 201-run replay keeps a valid focus, survives eviction of the chosen run, and recovers it after stepping back', async () => {
  const total = 201;
  const replay: ReplayData = {
    file: '/tmp/many-runs.jsonl',
    invalidLines: 0,
    truncated: false,
    events: replayRuns(total),
  };
  await withDom(async page => {
    const document = page.dom.window.document;
    const picker = () => document.querySelector('[data-testid="replay-run-picker"]') as HTMLSelectElement | null;
    const options = () => Array.from(picker()?.options ?? [], option => option.value);
    const heading = () => page.text('.run-name');
    const position = () => Number(/第 (\d+) \//.exec(page.text('[data-testid="replay-position"]'))?.[1]);
    const choose = async (id: string) => {
      const select = picker();
      assert.ok(select);
      await act(async () => {
        Object.getOwnPropertyDescriptor(page.dom.window.HTMLSelectElement.prototype, 'value')?.set?.call(select, id);
        select.dispatchEvent(new page.dom.window.Event('change', {bubbles: true}));
      });
    };
    // The step buttons move the playhead one event at a time, the same way a user seeks back.
    const stepTo = async (target: number) => {
      while (position() !== target) {
        const label = position() > target ? '上一条' : '下一条';
        const button = Array.from(document.querySelectorAll('.replay-controls button')).find(
          node => node.textContent === label,
        );
        assert.ok(button);
        await act(async () => {
          button.dispatchEvent(new page.dom.window.MouseEvent('click', {bubbles: true}));
        });
      }
      assert.equal(page.text('[data-testid="replay-position"]'), `第 ${target} / ${total} 条`);
    };
    const focusValid = () => {
      assert.equal(page.text().includes('尚未回放到事件'), false);
      const value = picker()?.value ?? '';
      assert.equal(options().includes(value), true);
      assert.equal(heading(), `任务${Number(value.slice(4))}`);
    };

    await page.render(createElement(ReplayView, {replay, now: Date.parse(at(300)), onExit: () => {}}));
    assert.equal(options().length, 200);
    assert.equal(options().includes('run-001'), false);
    focusValid();

    await stepTo(200);
    await choose('run-001');
    assert.equal(heading(), '任务1');

    // The 201st run evicts run-001, the chosen run. The picker must still offer the other runs.
    await stepTo(201);
    assert.equal(options().includes('run-001'), false);
    focusValid();
    await choose('run-150');
    assert.equal(heading(), '任务150');

    // Before run-150 started, the view falls back to a run in the prefix; stepping forward restores the choice.
    await stepTo(149);
    focusValid();
    assert.equal(options().includes('run-150'), false);
    await stepTo(150);
    assert.equal(picker()?.value, 'run-150');
    assert.equal(heading(), '任务150');
    await stepTo(total);
    assert.equal(picker()?.value, 'run-150');
    assert.equal(heading(), '任务150');
    assert.equal(options().length, 200);
  });
});

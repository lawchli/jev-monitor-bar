import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {act, createElement, type ReactElement} from 'react';
import {createRoot} from 'react-dom/client';
import type {MonitorBridge, Snapshot} from '../src/ipc';
import {validateEvent, type MonitorEvent, type Payload, type StoredEvent} from '../src/protocol';
import {applyEvent, emptyRun, type RunState} from '../src/state';
import {ExecutionTab} from '../src/renderer/expanded/ExecutionTab';
import {attemptGroups} from '../src/renderer/expanded/model';
import {ReplayView} from '../src/renderer/replay/ReplayView';

require.extensions['.css'] = () => {};
const {ExpandedView} =
  require('../src/renderer/expanded/ExpandedView') as typeof import('../src/renderer/expanded/ExpandedView');

type ActGlobal = typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?: boolean};

function fixture(runId: string, actions: {id: string; count: number}[], checkCount = 1) {
  const run = emptyRun(runId);
  const events: StoredEvent[] = [];
  const append = (type: MonitorEvent['type'], payload: Payload, ids: Partial<MonitorEvent> = {}) => {
    const sequence = events.length + 1;
    const wire = {
      schema_version: 1,
      event_id: `${runId}-event-${sequence}`,
      run_id: runId,
      producer_id: `${runId}-producer`,
      sequence,
      occurred_at: new Date(Date.UTC(2026, 0, 1) + sequence * 1000).toISOString(),
      type,
      payload,
      ...ids,
    };
    validateEvent(wire);
    const event: StoredEvent = {...wire, received_at: wire.occurred_at, cursor: sequence};
    events.push(event);
    applyEvent(run, event);
  };
  append('run.started', {name: runId});
  for (const action of actions) {
    for (let attempt = 1; attempt <= action.count; attempt++) {
      const ids = {action_id: action.id, attempt_id: `attempt-${attempt}`};
      append('action.selected', {action: action.id, source: 'application'}, ids);
      append(
        'verification.completed',
        {
          result: 'passed',
          checks: Array.from({length: checkCount}, (_, index) => ({
            name: `check-${index}`,
            observed: `${action.id} attempt-${attempt} check-${index}`,
            result: 'passed' as const,
          })),
        },
        ids,
      );
    }
  }
  return {run, events, append};
}

function snapshot(run: RunState): Snapshot {
  return {cursor: run.event_count, run, runs: [run], events: [], corruptLines: 0};
}

function liveView(run: RunState): ReactElement {
  return createElement(ExpandedView, {
    snapshot: snapshot(run),
    now: Date.UTC(2026, 0, 1),
    selectedRunId: run.id,
    onSelectRun: () => {},
    mode: 'expanded',
    onSetMode: () => {},
    pinned: true,
    onTogglePinned: () => {},
    bridge: {} as MonitorBridge,
    onExport: () => {},
    onOpenReplay: () => {},
  });
}

async function withDom(
  check: (page: {
    document: Document;
    render(node: ReactElement): Promise<void>;
    click(selector: string): Promise<void>;
    execution(): Promise<void>;
    text(selector: string): string;
    all(selector: string): Element[];
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
  globals.window = dom.window as unknown as ActGlobal['window'];
  globals.document = dom.window.document;
  globals.HTMLElement = dom.window.HTMLElement;
  globals.Node = dom.window.Node;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const container = dom.window.document.getElementById('root');
  assert.ok(container);
  const root = createRoot(container);
  const document = dom.window.document;
  const warnings: string[] = [];
  const previousError = console.error;
  console.error = (...values: unknown[]) => warnings.push(values.map(String).join(' '));
  const clickNode = async (node: Element | null | undefined) => {
    assert.ok(node);
    await act(async () => node.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true})));
  };
  try {
    await check({
      document,
      render: async node => {
        await act(async () => root.render(node));
      },
      click: async selector => clickNode(document.querySelector(selector)),
      execution: async () => {
        const tab = Array.from(document.querySelectorAll('[role="tab"]')).find(node => node.textContent === '执行');
        await clickNode(tab);
      },
      text: selector => document.querySelector(selector)?.textContent ?? '',
      all: selector => Array.from(document.querySelectorAll(selector)),
    });
    assert.deepEqual(warnings, [], 'paging and repeated check names must not produce React warnings');
  } finally {
    await act(async () => root.unmount());
    console.error = previousError;
    Object.assign(globals, previous);
    dom.window.close();
  }
}

const rows = '[data-testid="attempt-row"]';
const next = '[data-testid="execution-next-page"]';
const previous = '[data-testid="execution-previous-page"]';
const position = '[data-testid="execution-page"]';
const numbers = (items: Element[]) =>
  items.map(row => Number(row.querySelector('p span')?.textContent?.match(/\d+/)?.[0]));

test('all 500 retained attempts are reachable while execution pages render at most 20 attempts and 1000 checks', async () => {
  const {run} = fixture('large-run', [{id: 'same-action', count: 500}], 50);
  const before = JSON.stringify(run);
  await withDom(async page => {
    await page.render(liveView(run));
    await page.execution();
    const summary = page.text('.summary-bar');
    assert.match(summary, /验证成功 500 \/ 已验证 500/);
    const visited: number[] = [];
    for (let index = 0; index < 25; index++) {
      assert.match(page.text(position), new RegExp(`第 ${index + 1} / 25 页`));
      const visible = page.all(rows);
      assert.equal(visible.length, 20);
      assert.equal(page.all('.check-table tbody tr').length, 1000);
      visited.push(...numbers(visible));
      assert.equal(page.text('.summary-bar'), summary);
      if (index < 24) await page.click(next);
    }
    assert.deepEqual(
      visited,
      Array.from({length: 500}, (_, index) => index + 1),
    );
    assert.equal((page.document.querySelector(next) as HTMLButtonElement).disabled, true);
    await page.click(previous);
    assert.deepEqual(
      numbers(page.all(rows)),
      Array.from({length: 20}, (_, index) => index + 461),
    );
  });
  assert.equal(JSON.stringify(run), before, 'paging must not trim the aggregate used by the summary');
});

test('paging spans action groups in their existing order and preserves retry numbers across page boundaries', async () => {
  const {run} = fixture('grouped-run', [
    {id: 'older-action', count: 21},
    {id: 'newer-action', count: 23},
  ]);
  const groups = attemptGroups(run);
  const expected = groups.flatMap(group => group.rows.map(row => `${group.actionId}:${row.attemptNumber}`));
  await withDom(async page => {
    await page.render(createElement(ExecutionTab, {groups}));
    const visited: string[] = [];
    for (let index = 0; index < 3; index++) {
      for (const group of page.all('.attempt-group')) {
        const action = group.querySelector('h3 .muted')?.textContent;
        for (const number of numbers(Array.from(group.querySelectorAll(rows)))) visited.push(`${action}:${number}`);
      }
      assert.equal(page.all(rows).length, index < 2 ? 20 : 4);
      if (index < 2) await page.click(next);
    }
    assert.deepEqual(visited, expected);
    await page.click(previous);
    assert.deepEqual(numbers(page.all(rows)), [21, 22, 23, ...Array.from({length: 17}, (_, index) => index + 1)]);
  });
});

test('live run switches reset execution paging and shrinking retention clamps the current page', async () => {
  const first = fixture('first-run', [{id: 'shared-action', count: 61}]).run;
  const second = fixture('second-run', [{id: 'shared-action', count: 41}]).run;
  await withDom(async page => {
    await page.render(liveView(first));
    await page.execution();
    for (let index = 0; index < 3; index++) await page.click(next);
    assert.deepEqual(numbers(page.all(rows)), [61]);
    await page.render(liveView(second));
    assert.match(page.text(position), /第 1 \/ 3 页/);
    assert.deepEqual(
      numbers(page.all(rows)),
      Array.from({length: 20}, (_, index) => index + 1),
    );
    await page.click(next);
    await page.click(next);
    const smaller = fixture('second-run', [{id: 'shared-action', count: 9}]).run;
    await page.render(liveView(smaller));
    assert.match(page.text(position), /第 1 \/ 1 页/);
    assert.equal(page.all(rows).length, 9);
    assert.equal((page.document.querySelector(next) as HTMLButtonElement).disabled, true);
    assert.equal((page.document.querySelector(previous) as HTMLButtonElement).disabled, true);
    await page.render(liveView(second));
    assert.match(page.text(position), /第 1 \/ 3 页/);
    await page.render(liveView(emptyRun('second-run')));
    assert.match(page.text('.expanded-panel'), /尚无执行/);
    await page.render(liveView(second));
    assert.match(page.text(position), /第 1 \/ 3 页/);
  });
});

test('replay run switches reset execution paging for reused action IDs', async () => {
  const first = fixture('replay-one', [{id: 'shared-action', count: 41}]);
  const second = fixture('replay-two', [{id: 'shared-action', count: 41}]);
  const events = [
    ...first.events,
    ...second.events.map((event, index) => ({...event, cursor: first.events.length + index + 1})),
  ];
  await withDom(async page => {
    await page.render(
      createElement(ReplayView, {
        replay: {file: 'record.jsonl', events, invalidLines: 0, truncated: false},
        now: Date.UTC(2026, 0, 1),
        onExit: () => {},
      }),
    );
    await page.execution();
    await page.click(next);
    await page.click(next);
    assert.match(page.text(position), /第 3 \/ 3 页/);
    const picker = page.document.querySelector('[data-testid="replay-run-picker"]') as HTMLSelectElement;
    const other = picker.value === first.run.id ? second.run.id : first.run.id;
    await act(async () => {
      picker.value = other;
      picker.dispatchEvent(new page.document.defaultView!.Event('change', {bubbles: true}));
    });
    assert.match(page.text(position), /第 1 \/ 3 页/);
    assert.deepEqual(
      numbers(page.all(rows)),
      Array.from({length: 20}, (_, index) => index + 1),
    );
  });
});

test('repeated verification check names stay distinct when observations are updated or removed', async () => {
  const data = fixture('duplicate-checks', [{id: 'action', count: 1}]);
  const ids = {action_id: 'action', attempt_id: 'attempt-1'};
  data.append(
    'verification.completed',
    {
      result: 'failed',
      checks: [
        {name: 'same-name', observed: 'first observation', result: 'passed'},
        {name: 'same-name', observed: 'second observation', result: 'failed'},
      ],
    },
    ids,
  );
  await withDom(async page => {
    await page.render(liveView(data.run));
    await page.execution();
    assert.deepEqual(
      page.all('.check-table tbody tr').map(row => row.textContent),
      ['same-namefirst observation通过未提供', 'same-namesecond observation失败未提供'],
    );
    data.append(
      'verification.completed',
      {
        result: 'passed',
        checks: [
          {name: 'same-name', observed: 'second updated', result: 'passed'},
          {name: 'same-name', observed: 'first updated', result: 'passed'},
        ],
      },
      ids,
    );
    await page.render(liveView(data.run));
    assert.deepEqual(
      page.all('.check-table tbody tr').map(row => row.textContent),
      ['same-namesecond updated通过未提供', 'same-namefirst updated通过未提供'],
    );
    data.append(
      'verification.completed',
      {result: 'unknown', checks: [{name: 'same-name', observed: 'remaining', result: 'unknown'}]},
      ids,
    );
    await page.render(liveView(data.run));
    assert.deepEqual(
      page.all('.check-table tbody tr').map(row => row.textContent),
      ['same-nameremaining未知未提供'],
    );
  });
});

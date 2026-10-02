import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {validateEvent} from '../src/protocol';
import {sanitizeEvent} from '../src/redact';
import {applyEvent, emptyRun, labels, metrics} from '../src/state';
import {RENDERER_URL} from '../src/main/renderer-protocol';
import type {StoredEvent} from '../src/protocol';

const root = path.resolve(__dirname, '..');

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Sample {
  marker: string;
  postStart: number;
  postEnd?: number;
  receivedAt?: number;
  domAt?: number;
  visibleAt?: number;
}
interface Summary {
  n: number;
  min?: number;
  p50?: number;
  p95?: number;
  max?: number;
  mean?: number;
}
interface CgWindow {
  owner: string;
  pid: number;
  layer: number;
  bounds: Rect;
}
type EventFactory = (type: string, payload?: Record<string, unknown>, ids?: Record<string, string>) => unknown;
interface Expectation {
  id: string;
  name: string;
  label: string;
}
interface SmokeLib {
  LATENCY_THRESHOLD_MS: number;
  RENDERER_URL: string;
  statusLabels: Record<string, string>;
  executedWords: string[];
  successWords: string[];
  markerSource: string;
  SECRET: string;
  FUSE_SENTINEL: string;
  parseArgs(argv: string[]): Record<string, unknown>;
  percentile(values: number[], p: number): number | undefined;
  summarize(values: number[]): Summary;
  latencyMarker(index: number): string;
  latencyStats(
    samples: Sample[],
    thresholdMs?: number,
  ): {n: number; seen: number; missing: number; pass: boolean; postToVisible: Summary; receivedToVisible: Summary};
  rectInside(rect: Rect, area: Rect, tolerance?: number): boolean;
  insideSomeWorkArea(rect: Rect, displays: {workArea: Rect}[], tolerance?: number): boolean;
  overlapArea(a: Rect, b: Rect): number;
  forbiddenHits(text: string, words: string[]): string[];
  assertion(name: string, ok: boolean, details?: unknown): {name: string; status: string; details?: unknown};
  analyzeWindowStack(
    windows: CgWindow[],
    pid: number,
    expected?: Rect,
  ): {found: boolean; layer?: number; index?: number; aboveOverlapping?: boolean | null};
  createRun(runId: string, producerId: string): EventFactory;
  selectOnlyEvents(event: EventFactory): unknown[];
  completedUnverifiedEvents(event: EventFactory, padding?: number): unknown[];
  parseFuseWire(bytes: Buffer): {version: number; fuses: Record<string, unknown>} | undefined;
  pausedNewCount(text: string): number | undefined;
  fixtureExpectations(catalog: unknown, readFirstLine: (file: string) => string): Expectation[];
  optionMatches(optionText: string, expectation: Expectation): boolean;
  overallStatus(
    assertions: {name: string; status: string}[],
    latency?: {pass: boolean},
  ): {ok: boolean; failed: string[]};
}

async function load(): Promise<SmokeLib> {
  return (await import(pathToFileURL(path.join(root, 'scripts/smoke-lib.mjs')).href)) as SmokeLib;
}

function aggregate(events: unknown[]) {
  const run = emptyRun('r');
  events.forEach((event, index) => {
    validateEvent(event);
    const stored = {...(event as object), received_at: new Date().toISOString(), cursor: index + 1} as StoredEvent;
    applyEvent(run, stored);
  });
  return run;
}

test('smoke args: defaults, flags and bad values', async () => {
  const lib = await load();
  const defaults = lib.parseArgs([]);
  assert.equal(defaults.build, true);
  assert.equal(defaults.driver, 'auto');
  assert.equal(defaults.latencyCount, 200);
  assert.equal(defaults.latencyIntervalMs, 100);
  assert.equal(defaults.native, false);
  assert.equal(defaults.timeoutMs, 600_000);
  const packaged = lib.parseArgs(['--app', 'release/JEV.exe', '--latency-count', '50', '--native', '--driver', 'cdp']);
  assert.equal(packaged.app, 'release/JEV.exe');
  assert.equal(packaged.build, false, '--app never rebuilds the repo');
  assert.equal(packaged.latencyCount, 50);
  assert.equal(packaged.native, true);
  assert.equal(packaged.driver, 'cdp');
  assert.equal(lib.parseArgs(['--no-build']).build, false);
  assert.equal(lib.parseArgs(['--', '--native']).native, true, 'a bare -- from pnpm is ignored');
  assert.throws(() => lib.parseArgs(['--latency-count', '0']));
  assert.throws(() => lib.parseArgs(['--latency-count', '1.5']));
  assert.throws(() => lib.parseArgs(['--latency-count']));
  assert.throws(() => lib.parseArgs(['--app', '--native']));
  assert.throws(() => lib.parseArgs(['--driver', 'webdriver']));
  assert.throws(() => lib.parseArgs(['--timeout', '5']));
  assert.equal(lib.parseArgs(['--timeout', '60000']).timeoutMs, 60_000);
  assert.throws(() => lib.parseArgs(['--fast']));
});

test('nearest-rank percentile and summary', async () => {
  const lib = await load();
  const values = Array.from({length: 100}, (_, index) => 100 - index);
  assert.equal(lib.percentile(values, 50), 50);
  assert.equal(lib.percentile(values, 95), 95);
  assert.equal(lib.percentile(values, 100), 100);
  assert.equal(lib.percentile([7], 95), 7);
  assert.equal(lib.percentile([3, 1, 2], 50), 2);
  assert.equal(lib.percentile([], 95), undefined);
  assert.throws(() => lib.percentile([1], 0));
  assert.deepEqual(lib.summarize([10, 20, 30, 40]), {n: 4, min: 10, p50: 20, p95: 40, max: 40, mean: 25});
  assert.deepEqual(lib.summarize([Number.NaN]), {n: 0});
});

test('latency stats: p95 against the threshold, and a missing marker fails', async () => {
  const lib = await load();
  const samples: Sample[] = Array.from({length: 20}, (_, index) => ({
    marker: lib.latencyMarker(index + 1),
    postStart: 1000 * index,
    postEnd: 1000 * index + 3,
    receivedAt: 1000 * index + 2,
    domAt: 1000 * index + 60,
    visibleAt: 1000 * index + (index === 19 ? 900 : 80),
  }));
  const stats = lib.latencyStats(samples);
  assert.equal(stats.n, 20);
  assert.equal(stats.seen, 20);
  assert.equal(stats.postToVisible.p95, 80, 'one slow sample in 20 stays above p95');
  assert.equal(stats.postToVisible.max, 900);
  assert.equal(stats.receivedToVisible.p50, 78);
  assert.equal(stats.pass, true);
  assert.equal(lib.latencyStats(samples, 50).pass, false);
  const missing = samples.map((sample, index) => (index === 3 ? {...sample, visibleAt: undefined} : sample));
  const missed = lib.latencyStats(missing);
  assert.equal(missed.missing, 1);
  assert.equal(missed.pass, false);
  assert.equal(lib.latencyStats([]).pass, false);
});

test('latency markers are fixed width and found by the page pattern', async () => {
  const lib = await load();
  assert.equal(lib.latencyMarker(7), 'LAT#000007#');
  const found = [
    ...`阶段 ${lib.latencyMarker(1)} · ${lib.latencyMarker(12)}`.matchAll(new RegExp(lib.markerSource, 'g')),
  ];
  assert.deepEqual(
    found.map(match => match[0]),
    ['LAT#000001#', 'LAT#000012#'],
  );
});

test('work area and overlap geometry', async () => {
  const lib = await load();
  const area = {x: 0, y: 25, width: 1920, height: 1015};
  assert.equal(lib.rectInside({x: 760, y: 454, width: 400, height: 132}, area), true);
  assert.equal(lib.rectInside({x: -7, y: 25, width: 400, height: 132}, area), false);
  assert.equal(lib.rectInside({x: -7, y: 25, width: 400, height: 132}, area, 8), true);
  const second = {workArea: {x: 1920, y: 0, width: 1280, height: 1024}};
  assert.equal(lib.insideSomeWorkArea({x: 2000, y: 10, width: 400, height: 132}, [{workArea: area}, second]), true);
  assert.equal(lib.insideSomeWorkArea({x: 1800, y: 100, width: 400, height: 132}, [{workArea: area}, second]), false);
  assert.equal(lib.overlapArea({x: 0, y: 0, width: 10, height: 10}, {x: 5, y: 5, width: 10, height: 10}), 25);
  assert.equal(lib.overlapArea({x: 0, y: 0, width: 10, height: 10}, {x: 10, y: 0, width: 10, height: 10}), 0);
});

test('window stack: ours above, below, or nothing to compare', async () => {
  const lib = await load();
  const ours = {owner: 'Electron', pid: 42, layer: 3, bounds: {x: 100, y: 100, width: 400, height: 132}};
  const helper = {owner: 'Electron', pid: 42, layer: 0, bounds: {x: 0, y: 0, width: 1, height: 1}};
  const other = {owner: 'Editor', pid: 7, layer: 0, bounds: {x: 0, y: 0, width: 800, height: 600}};
  const far = {owner: 'Editor', pid: 7, layer: 0, bounds: {x: 2000, y: 0, width: 100, height: 100}};
  const menu = {owner: 'Window Server', pid: 1, layer: 24, bounds: {x: 0, y: 0, width: 2560, height: 30}};
  const expected = {x: 100, y: 100, width: 400, height: 132};
  const above = lib.analyzeWindowStack([menu, ours, other, helper], 42, expected);
  assert.equal(above.found, true);
  assert.equal(above.layer, 3);
  assert.equal(above.index, 1);
  assert.equal(above.aboveOverlapping, true, 'menu bar layer is not a normal window');
  assert.equal(lib.analyzeWindowStack([other, {...ours, layer: 0}], 42, expected).aboveOverlapping, false);
  assert.equal(lib.analyzeWindowStack([ours, far], 42, expected).aboveOverlapping, null);
  assert.equal(lib.analyzeWindowStack([other], 42, expected).found, false);
});

test('fuse wire is read after the sentinel', async () => {
  const lib = await load();
  const wire = Buffer.concat([
    Buffer.from('padding'),
    Buffer.from(lib.FUSE_SENTINEL, 'latin1'),
    Buffer.from([1, 9]),
    Buffer.from('000010r11', 'latin1'),
  ]);
  const parsed = lib.parseFuseWire(wire);
  assert.equal(parsed?.version, 1);
  assert.equal(parsed?.fuses.runAsNode, false);
  assert.equal(parsed?.fuses.enableNodeOptionsEnvironmentVariable, false);
  assert.equal(parsed?.fuses.enableNodeCliInspectArguments, false);
  assert.equal(parsed?.fuses.enableEmbeddedAsarIntegrityValidation, true);
  assert.equal(parsed?.fuses.onlyLoadAppFromAsar, false);
  assert.equal(parsed?.fuses.loadBrowserProcessSpecificV8Snapshot, 'removed');
  assert.equal(parsed?.fuses.wasmTrapHandlers, true);
  assert.equal(lib.parseFuseWire(Buffer.from('no fuses here')), undefined);
  assert.equal(lib.parseFuseWire(wire.subarray(0, wire.length - 3)), undefined, 'truncated wire');
});

test('status labels match the state module', async () => {
  const lib = await load();
  for (const [status, label] of Object.entries(lib.statusLabels)) assert.equal(label, labels[status], status);
});

test('the smoke test looks for the URL the main process loads', async () => {
  const lib = await load();
  assert.equal(lib.RENDERER_URL, RENDERER_URL);
});

test('closed-loop events are valid protocol events with the intended states', async () => {
  const lib = await load();
  const selectOnly = aggregate(lib.selectOnlyEvents(lib.createRun('smoke-select', 'smoke-p1')));
  assert.equal(selectOnly.name, '闭环：只选择');
  assert.equal(selectOnly.simulated, true);
  assert.equal(selectOnly.status, 'selected');
  assert.equal(Object.values(selectOnly.attempts)[0]?.status, 'selected');
  assert.deepEqual(metrics(selectOnly), {passed: 0, failed: 0, unknown: 0, unverified: 0, retries: 0});

  const unverifiedEvents = lib.completedUnverifiedEvents(lib.createRun('smoke-unverified', 'smoke-p2'), 3);
  assert.equal(unverifiedEvents.length, 9);
  const unverified = aggregate(unverifiedEvents);
  assert.equal(unverified.status, 'unverified');
  assert.equal(metrics(unverified).unverified, 1);
  assert.equal(metrics(unverified).passed, 0);
  const withSecret = unverifiedEvents.find(event => JSON.stringify(event).includes(lib.SECRET));
  assert.ok(withSecret, 'one event carries the secret');
  assert.ok(!JSON.stringify(sanitizeEvent(withSecret)).includes(lib.SECRET), 'receiver redaction removes it');
});

test('forbidden words, pause counter and assertion records', async () => {
  const lib = await load();
  assert.deepEqual(lib.forbiddenHits('JEV 选择 A → 应用覆盖为 B → 应用选择/待执行 B', lib.executedWords), []);
  assert.deepEqual(lib.forbiddenHits('JEV 选择 go → 已执行待验证 go', lib.successWords), []);
  assert.deepEqual(lib.forbiddenHits('已执行 go → 验证成功', lib.executedWords), ['已执行', '验证成功']);
  assert.equal(lib.pausedNewCount('已暂停跟随 · 5 条新事件 · 回到最新'), 5);
  assert.equal(lib.pausedNewCount('跟随最新'), undefined);
  const item = lib.assertion('expanded.sameRun', true, {name: '闭环：只选择', status: '状态 已选择'});
  assert.equal(item.name, 'expanded.sameRun', 'details cannot overwrite the assertion name');
  assert.equal(item.status, 'passed');
  assert.deepEqual(
    lib.overallStatus([
      {name: 'a', status: 'passed'},
      {name: 'b', status: 'skipped'},
    ]),
    {
      ok: true,
      failed: [],
    },
  );
  assert.deepEqual(lib.overallStatus([{name: 'a', status: 'failed'}], {pass: false}), {
    ok: false,
    failed: ['a', 'latency.p95'],
  });
});

test('every fixture scenario has a name and status label for the run picker', async () => {
  const lib = await load();
  const dir = path.join(root, 'fixtures/scenarios');
  const expectations = lib.fixtureExpectations(
    JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')),
    file => fs.readFileSync(path.join(dir, file), 'utf8').split(/\r?\n/)[0],
  );
  assert.equal(expectations.length, 7);
  for (const item of expectations) {
    assert.ok(item.name.startsWith('模拟：'), item.id);
    assert.ok(Object.values(labels).includes(item.label), `${item.id}: ${item.label}`);
  }
  const verifyFailed = expectations.find(item => item.id === 'verify-failed');
  assert.ok(verifyFailed);
  assert.equal(lib.optionMatches(`模拟：验证失败 · ${labels.verification_failed} · 模拟`, verifyFailed), true);
  assert.equal(lib.optionMatches('模拟：验证失败 · 任务结束 · 模拟', verifyFailed), false);
});

// 负载测试的接收端子进程：按 src/main/index.ts 的方式接好 EventStore、HTTP 接收器与 50 ms 合并通知，
// 再按 useMonitor 的节流（≥100 ms 一次）模拟渲染端拉取快照。RSS 只属于这个进程。
// 由 scripts/loadtest/run.ts 用 esbuild 打包成 cjs 后 fork，可在 Node 或 ELECTRON_RUN_AS_NODE 下运行。
import fs from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import vm from 'node:vm';
import {monitorEventLoopDelay, performance, type EventLoopUtilization} from 'node:perf_hooks';
import {EventStore} from '../../src/store';
import {startServer} from '../../src/server';
import {createMonitorHandlers, type ReplayFileIO} from '../../src/main/ipc-api';
import {pageReplay, replaySnapshot, REPLAY_MAX_BYTES} from '../../src/replay';
import {pickDefaultRun} from '../../src/renderer/view-model/common';
import type {Snapshot} from '../../src/ipc';
import type {StoredEvent} from '../../src/protocol';

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;

const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

function send(message: object) {
  process.send?.(message);
}

function runtimeInfo() {
  return {
    pid: process.pid,
    execPath: process.execPath,
    node: process.versions.node,
    v8: process.versions.v8,
    electron: (process.versions as Record<string, string | undefined>).electron,
    arch: process.arch,
  };
}

const mb = (bytes: number) => Math.round((bytes / 1048576) * 100) / 100;
function memory() {
  const m = process.memoryUsage();
  const heap = v8.getHeapStatistics();
  return {
    rssMB: mb(m.rss),
    heapTotalMB: mb(m.heapTotal),
    heapUsedMB: mb(m.heapUsed),
    externalMB: mb(m.external),
    arrayBuffersMB: mb(m.arrayBuffers),
    mallocedMB: mb(heap.malloced_memory),
  };
}

const recoverDir = option('--recover');
if (recoverDir) {
  gc();
  const before = memory();
  const started = performance.now();
  const store = new EventStore(recoverDir);
  const ms = performance.now() - started;
  const raw = memory();
  gc();
  send({
    type: 'recovered',
    data: {
      ms,
      events: store.events.length,
      bytes: store.bytes,
      runs: store.runs.size,
      cursor: store.cursor,
      corruptLines: store.corruptLines,
      before,
      afterRaw: raw,
      afterGc: memory(),
      runtime: runtimeInfo(),
    },
  });
  process.exit(0);
}

const home = option('--home');
if (!home) {
  console.error('receiver: --home is required');
  process.exit(2);
}
let follow = option('--follow') ?? 'auto';

// --- 计时桶：只在本进程里包一层，不改 src。
const bucket = () => ({
  ingest: [] as number[],
  append: [] as number[],
  readdir: [] as number[],
  snapshotBuild: [] as number[],
  snapshotSerialize: [] as number[],
  snapshotBytes: [] as number[],
  updateLatency: [] as number[],
  page: [] as number[],
  flushes: 0,
});
let win = bucket();

type AnyFn = (...values: unknown[]) => unknown;
const fsTable = fs as unknown as Record<string, AnyFn>;
function timeFs(name: string, sink: (ms: number) => void) {
  const original = fsTable[name];
  fsTable[name] = function (this: unknown, ...values: unknown[]) {
    const t = performance.now();
    try {
      return original.apply(this, values);
    } finally {
      sink(performance.now() - t);
    }
  };
}
timeFs('appendFileSync', ms => win.append.push(ms));
timeFs('readdirSync', ms => win.readdir.push(ms));

const eventsDir = path.join(home, 'events');
const store = new EventStore(eventsDir);
const ingest = store.ingest.bind(store);
store.ingest = (raw: unknown) => {
  const t = performance.now();
  try {
    return ingest(raw);
  } finally {
    win.ingest.push(performance.now() - t);
  }
};

const rendererUrl = 'file:///loadtest/renderer/index.html';
const contents = {mainFrame: {url: rendererUrl}};
const ipcEvent = {sender: contents, senderFrame: contents.mainFrame};
const handlers = createMonitorHandlers({
  store,
  controller: {setMode: mode => mode, setPinned: pinned => pinned},
  getStatus: () => ({
    listening: true,
    dataDir: home,
    corruptLines: store.corruptLines,
    platform: {os: 'other', arch: process.arch, tier: 3, alwaysOnTopSupported: false, notes: []},
    mode: 'expanded',
    pinned: true,
    startedAt: new Date().toISOString(),
  }),
  rendererUrl,
  contents,
});

// --- 渲染端模拟：主进程 50 ms 合并 changed，useMonitor 每 100 ms 最多拉一次快照。
let flushTimer: NodeJS.Timeout | undefined;
let delayTimer: NodeJS.Timeout | undefined;
let pendingSince: number | undefined;
let lastStart = 0;
let lastSnapshot: Snapshot | undefined;
let autoRun: string | undefined;
let stopped = false;

function selectedRun() {
  return follow === 'auto' ? autoRun : follow;
}

function takeSnapshot() {
  lastStart = performance.now();
  const since = pendingSince;
  pendingSince = undefined;
  const t0 = performance.now();
  const snapshot = handlers.snapshot(ipcEvent, selectedRun());
  const t1 = performance.now();
  // Electron 的 invoke 返回值走 V8 结构化克隆；v8.serialize 是同一套序列化器。
  const bytes = v8.serialize(snapshot).length;
  const t2 = performance.now();
  win.snapshotBuild.push(t1 - t0);
  win.snapshotSerialize.push(t2 - t1);
  win.snapshotBytes.push(bytes);
  if (since !== undefined) win.updateLatency.push(t2 - since);
  lastSnapshot = snapshot;
  if (follow === 'auto') autoRun = pickDefaultRun(snapshot.runs)?.id;
}

function requestSnapshot() {
  if (stopped) return;
  const elapsed = performance.now() - lastStart;
  if (lastStart !== 0 && elapsed < 100) {
    delayTimer ??= setTimeout(() => {
      delayTimer = undefined;
      requestSnapshot();
    }, 100 - elapsed);
    return;
  }
  takeSnapshot();
}

store.on('event', () => {
  pendingSince ??= performance.now();
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    win.flushes += 1;
    requestSnapshot();
  }, 50);
});

// 时间线「加载更早」：每 10 秒翻一页所选 run 和一页全局。
const pageTimer = setInterval(() => {
  const earliest = lastSnapshot?.events[0]?.cursor;
  for (const runId of [selectedRun(), undefined]) {
    const t = performance.now();
    handlers.page(ipcEvent, {runId, beforeCursor: earliest ?? store.cursor, limit: 100});
    win.page.push(performance.now() - t);
  }
}, 10_000);

const ELD_RESOLUTION_MS = 10;
const eld = monitorEventLoopDelay({resolution: ELD_RESOLUTION_MS});
const blocked = (ns: number) => (Number.isFinite(ns) ? Math.max(0, ns / 1e6 - ELD_RESOLUTION_MS) : 0);
eld.enable();
let lastElu: EventLoopUtilization = performance.eventLoopUtilization();
let lastCpu = process.cpuUsage();
let lastSampleAt = performance.now();

function retained(deep: boolean) {
  const inWindow = new Set<StoredEvent>(store.events);
  const seen = new Set<StoredEvent>();
  let refs = 0;
  let outside = 0;
  let outsideBytes = 0;
  const add = (event?: StoredEvent) => {
    if (!event || seen.has(event)) return;
    seen.add(event);
    refs += 1;
    if (inWindow.has(event)) return;
    outside += 1;
    if (deep) outsideBytes += Buffer.byteLength(JSON.stringify(event));
  };
  let decisions = 0;
  let attempts = 0;
  let maxDecisions = 0;
  let maxAttempts = 0;
  let limited = 0;
  let open = 0;
  let stateBytes = 0;
  for (const run of store.runs.values()) {
    const d = Object.values(run.decisions);
    const a = Object.values(run.attempts);
    decisions += d.length;
    attempts += a.length;
    maxDecisions = Math.max(maxDecisions, d.length);
    maxAttempts = Math.max(maxAttempts, a.length);
    if (run.limited) limited += 1;
    if (!run.ended_at) open += 1;
    add(run.latest);
    for (const item of d) {
      add(item.started);
      add(item.resolved);
      add(item.failed);
    }
    for (const item of a) {
      add(item.selected);
      add(item.started);
      add(item.terminal);
      add(item.verification);
    }
    if (deep) stateBytes += Buffer.byteLength(JSON.stringify(run));
  }
  return {
    runs: store.runs.size,
    openRuns: open,
    limitedRuns: limited,
    decisions,
    attempts,
    maxDecisions,
    maxAttempts,
    eventRefs: refs,
    refsOutsideWindow: outside,
    outsideWindowBytes: deep ? outsideBytes : undefined,
    stateJsonBytes: deep ? stateBytes : undefined,
  };
}

function sample(options: {gc?: boolean; deep?: boolean}) {
  const now = performance.now();
  const elu = performance.eventLoopUtilization(lastElu);
  lastElu = performance.eventLoopUtilization();
  const cpu = process.cpuUsage(lastCpu);
  lastCpu = process.cpuUsage();
  const windowMs = now - lastSampleAt;
  lastSampleAt = now;
  const raw = win;
  win = bucket();
  const data: Record<string, unknown> = {
    windowMs,
    memory: memory(),
    // 直方图记录的是两次 10 ms 定时器之间的间隔，减去采样间隔才是被阻塞的时间。
    eld: {
      p50: blocked(eld.percentile(50)),
      p99: blocked(eld.percentile(99)),
      max: blocked(eld.max),
      mean: blocked(eld.mean),
    },
    eldRaw: {p50: eld.percentile(50) / 1e6, p99: eld.percentile(99) / 1e6, max: eld.max / 1e6},
    elu: elu.utilization,
    cpuPercent: ((cpu.user + cpu.system) / 1000 / windowMs) * 100,
    raw,
    store: {
      cursor: store.cursor,
      events: store.events.length,
      bytes: store.bytes,
      ids: store.ids.size,
      sequences: store.sequences.size,
      droppedRuns: (store as unknown as {droppedRuns: Set<string>}).droppedRuns.size,
      corruptLines: store.corruptLines,
    },
    follow: selectedRun(),
  };
  // 以下是测量自身的开销：做完后清掉事件循环延迟直方图，免得记到下一窗口。
  const overheadStart = performance.now();
  // 先 GC 再做深度统计：深度统计会临时拼出几十 MB 的 JSON，Electron 的 V8 做保守栈扫描时可能让它们熬过紧接着的 GC。
  if (options.gc) {
    const t = performance.now();
    gc();
    data.gcMs = performance.now() - t;
    data.memoryAfterGc = memory();
  }
  data.state = retained(options.deep === true);
  if (options.deep && lastSnapshot) {
    const fresh = handlers.snapshot(ipcEvent, selectedRun());
    data.snapshotJsonBytes = Buffer.byteLength(JSON.stringify(fresh));
    data.snapshotV8Bytes = v8.serialize(fresh).length;
  }
  data.overheadMs = performance.now() - overheadStart;
  setTimeout(() => eld.reset(), 0);
  return data;
}

function readBounded(file: string) {
  const stat = fs.statSync(file);
  if (stat.size > REPLAY_MAX_BYTES) return {ok: false as const, reason: 'too-large' as const};
  return {ok: true as const, text: fs.readFileSync(file, 'utf8')};
}

async function exportTo(file: string) {
  const io: ReplayFileIO = {
    saveDialog: async () => file,
    openDialog: async () => undefined,
    readBounded,
    write: (target, text) => fs.writeFileSync(target, text),
  };
  gc();
  const before = memory();
  // 保存对话框立即返回，其余读段、校验、拼接和写文件都是同步的：ms 就是主线程被占用的时间。
  const t = performance.now();
  const result = await handlers.exportEvents(ipcEvent, io);
  const ms = performance.now() - t;
  return {ms, ...result, before, after: memory()};
}

async function replayFrom(file: string, runId?: string) {
  const io: ReplayFileIO = {
    saveDialog: async () => undefined,
    openDialog: async () => file,
    readBounded,
    write: () => undefined,
  };
  gc();
  const before = memory();
  const t0 = performance.now();
  const data = await handlers.openReplay(ipcEvent, io);
  const parseMs = performance.now() - t0;
  if (!data) throw new Error('replay returned null');
  const t1 = performance.now();
  const ipcBytes = v8.serialize(data).length;
  const serializeMs = performance.now() - t1;
  const afterParse = memory();
  const events = data.events;
  const focus = runId ?? events[events.length - 1]?.run_id;
  const t2 = performance.now();
  const full = replaySnapshot(events, events.length, focus);
  const fullMs = performance.now() - t2;
  const t3 = performance.now();
  replaySnapshot(events, Math.floor(events.length / 2), focus);
  const midMs = performance.now() - t3;
  const t4 = performance.now();
  const page = pageReplay(events, events.length, {runId: focus, beforeCursor: full.events[0]?.cursor, limit: 100});
  const pageMs = performance.now() - t4;
  return {
    fileBytes: fs.statSync(file).size,
    parseMs,
    events: events.length,
    invalidLines: data.invalidLines,
    truncated: data.truncated,
    ipcBytes,
    serializeMs,
    replaySnapshotFullMs: fullMs,
    replaySnapshotMidMs: midMs,
    replaySnapshotBytes: v8.serialize(full).length,
    replayPageMs: pageMs,
    replayPageRows: page.length,
    before,
    afterParse,
  };
}

async function main() {
  const started = await startServer(store, path.join(home!, 'session.json'));
  send({type: 'ready', session: started.session, runtime: runtimeInfo(), memory: memory()});
  process.on('message', (raw: unknown) => void handle(raw, started.close));
}

async function handle(raw: unknown, close: () => Promise<void>) {
  const message = raw as {type: string; id?: number; [key: string]: unknown};
  const reply = (data: unknown) => send({type: 'reply', id: message.id, data});
  try {
    if (message.type === 'sample') reply(sample(message as {gc?: boolean; deep?: boolean}));
    else if (message.type === 'follow') {
      follow = String(message.runId);
      reply({follow});
    } else if (message.type === 'export') reply(await exportTo(String(message.file)));
    else if (message.type === 'replay') reply(await replayFrom(String(message.file), message.runId as string));
    else if (message.type === 'exit') {
      stopped = true;
      clearInterval(pageTimer);
      if (flushTimer) clearTimeout(flushTimer);
      if (delayTimer) clearTimeout(delayTimer);
      await close();
      reply({closed: true});
      process.disconnect?.();
      process.exit(0);
    }
  } catch (error) {
    send({type: 'reply', id: message.id, error: error instanceof Error ? error.stack : String(error)});
  }
}

void main();

// `pnpm bench:replay --file <export.jsonl>`：回放打开与拖动的微基准，不进 `pnpm test`。
// 按 openReplay 读文件并解析，用 v8.serialize / deserialize 近似那一次 IPC，再在同一进程里按 ReplayView 的方式定位。
// --module 可以换成另一份 replay 实现（例如旧提交的 src/replay.ts 拷贝）做前后对比；没有 ReplayTimeline 时每次从头重算。
// --synthetic N 不读文件，生成检查点最占内存的情形：N 个 run 轮流收到新决策和新尝试，每段检查点都改到所有 run。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import v8 from 'node:v8';
import vm from 'node:vm';
import type {Snapshot} from '../../src/ipc';
import {validateEvent, type StoredEvent} from '../../src/protocol';
import {sanitizeEvent} from '../../src/redact';
import type * as Replay from '../../src/replay';

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;

const {values: flags} = parseArgs({
  options: {
    file: {type: 'string'},
    synthetic: {type: 'string'},
    events: {type: 'string', default: '20000'},
    module: {type: 'string'},
    run: {type: 'string', default: 'auto'},
    repeat: {type: 'string', default: '5'},
    json: {type: 'string'},
    help: {type: 'boolean', default: false},
  },
});
if (flags.help || (!flags.file && !flags.synthetic)) {
  console.log(`pnpm bench:replay --file <export.jsonl> | --synthetic <runs> [--events 20000]
  [--module <replay.ts>] [--run auto|largest|<run_id>] [--repeat 5] [--json out.json]
  --run auto     与打开回放时一样不指定 run（焦点跟随最后一条事件）
  --run largest  指定事件最多的 run`);
  process.exit(flags.help ? 0 : 1);
}

const modulePath = flags.module ? path.resolve(flags.module) : path.resolve(import.meta.dirname, '../../src/replay.ts');
const replay = (await import(pathToFileURL(modulePath).href)) as typeof Replay;
const repeat = Math.max(1, Number(flags.repeat) || 5);
const mb = (bytes: number) => Math.round((bytes / 1048576) * 100) / 100;
const round = (ms: number) => Math.round(ms * 100) / 100;

function heapMB() {
  gc();
  gc();
  return mb(process.memoryUsage().heapUsed);
}

function timed<T>(fn: () => T): [T, number] {
  const started = performance.now();
  const value = fn();
  return [value, performance.now() - started];
}

function synthetic(runs: number, total: number): string {
  const lines: string[] = [];
  for (let index = 0; index < total; index++) {
    const at = new Date(Date.UTC(2026, 0, 1) + index * 100).toISOString();
    lines.push(
      JSON.stringify({
        schema_version: 1,
        event_id: `s${index}`,
        run_id: `run-${index % runs}`,
        producer_id: 'bench',
        sequence: index,
        occurred_at: at,
        type: 'decision.started',
        decision_id: `d${index}`,
        request_id: 'r1',
        question_id: 'q1',
        action_id: `a${index}`,
        attempt_id: 't1',
        payload: {kind: 'choice', question: `问题 ${index}`, candidates: {A: '甲', B: '乙'}},
        received_at: at,
        cursor: index + 1,
      }),
    );
  }
  return lines.join('\n') + '\n';
}

const source = flags.synthetic
  ? synthetic(Math.max(1, Number(flags.synthetic) || 40), Math.max(1, Number(flags.events) || 20000))
  : undefined;
const label = flags.synthetic ? `synthetic-${flags.synthetic}-runs` : path.basename(flags.file!);

const heapStart = heapMB();
const [parsed, openMs] = timed(() =>
  replay.parseReplay(source ?? fs.readFileSync(flags.file!, 'utf8'), {validateEvent, sanitizeEvent}),
);
const data = {file: label, ...parsed};
const [wire, serializeMs] = timed(() => v8.serialize(data));
const [received, deserializeMs] = timed(() => v8.deserialize(wire) as typeof data);
const ipcBytes = wire.length;
const events: StoredEvent[] = received.events;
const heapEvents = heapMB();

const counts = new Map<string, number>();
for (const event of events) counts.set(event.run_id, (counts.get(event.run_id) ?? 0) + 1);
const largest = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
const runId = flags.run === 'auto' ? undefined : flags.run === 'largest' ? largest : flags.run;

const total = events.length;
const Timeline = (replay as Partial<typeof Replay>).ReplayTimeline;
const timeline = Timeline ? new Timeline(events) : undefined;
const at = (count: number): Snapshot =>
  timeline ? timeline.snapshot(count, runId) : replay.replaySnapshot(events, count, runId);

// 打开回放时播放头在末尾，第一次快照就是全量。ReplayTimeline 在这一次里把检查点都建好。
const [first, firstMs] = timed(() => at(total));
const heapTimeline = heapMB();

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** 每次先停在 from（不计时），再计时跳到 to。 */
function seek(from: number, to: number) {
  const samples: number[] = [];
  for (let i = 0; i < repeat; i++) {
    at(from);
    samples.push(timed(() => at(to))[1]);
  }
  return {from, to, medianMs: round(median(samples)), maxMs: round(Math.max(...samples))};
}

const interval = timeline?.interval ?? 1000;
const half = Math.floor(total / 2);
const blockEnd = Math.floor(half / interval) * interval + interval - 1;
const seeks = {
  '0%': seek(half, 0),
  '50%': seek(total, half),
  '100%': seek(half, total),
  '50%（检查点后 interval-1 条）': seek(total, Math.min(total, blockEnd)),
  前进一条: seek(half, half + 1),
  后退一条: seek(half, half - 1),
};

// 10× 连续播放：从一半处往后走 200 步。
at(half);
const steps: number[] = [];
for (let i = 1; i <= 200 && half + i <= total; i++) steps.push(timed(() => at(half + i))[1]);

// 随机拖动 200 次（固定种子）。
let seed = 1;
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const randomMs: number[] = [];
for (let i = 0; i < 200; i++) randomMs.push(timed(() => at(Math.floor(random() * (total + 1))))[1]);
randomMs.sort((a, b) => a - b);

// 与从头重算逐一比较几个位置，确认测的是同一个结果。
if (timeline) {
  for (const count of [0, 1, half, blockEnd, total - 1, total])
    assert.deepStrictEqual(timeline.snapshot(count, runId), replay.replaySnapshot(events, count, runId));
}

let checkpoints: Record<string, number> | undefined;
if (timeline) {
  // 只为统计读私有字段：检查点之间共用的对象只数一次。
  const saved = (timeline as unknown as {checkpoints: Map<string, {decisions: object; attempts: object}>[]})
    .checkpoints;
  const runs = new Set<object>();
  const tables = new Set<object>();
  const entries = new Set<unknown>();
  let slots = 0;
  let references = 0;
  for (const checkpoint of saved) {
    references += checkpoint.size;
    for (const run of checkpoint.values()) {
      if (runs.has(run)) continue;
      runs.add(run);
      for (const table of [run.decisions, run.attempts]) {
        if (tables.has(table)) continue;
        tables.add(table);
        const values = Object.values(table);
        slots += values.length;
        for (const value of values) entries.add(value);
      }
    }
  }
  checkpoints = {
    count: saved.length,
    runReferences: references,
    distinctRuns: runs.size,
    distinctTables: tables.size,
    tableSlots: slots,
    distinctEntries: entries.size,
  };
}

const usage = process.resourceUsage();
const result = {
  file: label,
  module: path.relative(process.cwd(), modulePath),
  checkpointed: Boolean(timeline),
  interval: timeline?.interval,
  node: process.version,
  lines: (source ?? fs.readFileSync(flags.file!, 'utf8')).split('\n').filter(Boolean).length,
  fileMB: source ? mb(Buffer.byteLength(source)) : mb(fs.statSync(flags.file!).size),
  events: total,
  truncated: parsed.truncated,
  omitted: (parsed as Partial<Replay.ReplayParseResult>).omitted,
  invalidLines: parsed.invalidLines,
  firstEventId: events[0]?.event_id,
  lastEventId: events.at(-1)?.event_id,
  runId: runId ?? '(auto)',
  selectedRun: first.run?.id,
  selectedEvents: first.events.length,
  openMs: round(openMs),
  ipc: {MB: mb(ipcBytes), serializeMs: round(serializeMs), deserializeMs: round(deserializeMs)},
  firstSnapshotMs: round(firstMs),
  seeks,
  playback200: {
    medianMs: round(median(steps)),
    maxMs: round(Math.max(...steps)),
    totalMs: round(steps.reduce((a, b) => a + b, 0)),
  },
  random200: {
    p50Ms: round(randomMs[100]),
    p95Ms: round(randomMs[190]),
    maxMs: round(randomMs[199]),
  },
  heapMB: {
    start: heapStart,
    afterEvents: heapEvents,
    afterFirstSnapshot: heapTimeline,
    timelineRetained: round(heapTimeline - heapEvents),
  },
  peakRssMB: Math.round(usage.maxRSS / 1024),
  checkpoints,
};
console.log(JSON.stringify(result, null, 2));
if (flags.json) fs.writeFileSync(flags.json, JSON.stringify(result, null, 2));

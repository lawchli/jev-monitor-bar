// `pnpm exec tsx scripts/loadtest/bound-bench.mts [--module <state.ts>] [--events 20000] [--repeat 7]`：
// 每个 run 最多 500 个决策 / 尝试，这里测表已满时 applyEvent 每条的耗时，不进 `pnpm test`。
// --module 可以换成旧提交的 src/state.ts 拷贝做前后对比。预先填满 500 个键不计时；每种情形重复 repeat 次取中位数。
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import type {StoredEvent} from '../../src/protocol';
import type * as State from '../../src/state';

const {values: flags} = parseArgs({
  options: {
    module: {type: 'string'},
    events: {type: 'string', default: '20000'},
    repeat: {type: 'string', default: '7'},
  },
});
const modulePath = flags.module ? path.resolve(flags.module) : path.resolve(import.meta.dirname, '../../src/state.ts');
const state = (await import(pathToFileURL(modulePath).href)) as typeof State;
const total = Math.max(1, Number(flags.events) || 20000);
const repeat = Math.max(1, Number(flags.repeat) || 7);

const at = new Date(Date.UTC(2026, 0, 1)).toISOString();
function event(sequence: number, extra: Partial<StoredEvent>): StoredEvent {
  return {
    schema_version: 1,
    event_id: `e${sequence}`,
    run_id: 'run-1',
    producer_id: 'bench',
    sequence,
    occurred_at: at,
    type: 'decision.started',
    payload: {kind: 'choice', question: `问题 ${sequence}`},
    received_at: at,
    cursor: sequence,
    ...extra,
  };
}
const decision = (sequence: number, id: string) => event(sequence, {decision_id: id, request_id: 'r1'});
const attempt = (sequence: number, id: string) =>
  event(sequence, {type: 'action.started', action_id: `act-${id}`, attempt_id: 't1', payload: {action: '点击'}});

/** 先应用 fill（不计时），再计时应用 timed，返回每条微秒数与最后的表。 */
function measure(fill: StoredEvent[], timed: StoredEvent[]) {
  const run = state.emptyRun('run-1');
  for (const e of fill) state.applyEvent(run, e);
  const started = performance.now();
  for (const e of timed) state.applyEvent(run, e);
  const us = ((performance.now() - started) * 1000) / timed.length;
  return {us, run};
}

const prefill = (make: (sequence: number, id: string) => StoredEvent, id: (n: number) => string) =>
  Array.from({length: 500}, (_item, n) => make(n + 1, id(n)));
const series = (make: (sequence: number, id: string) => StoredEvent, id: (n: number) => string, from = 500) =>
  Array.from({length: total}, (_item, n) => make(from + n + 1, id(from + n)));

const cases: Record<string, [StoredEvent[], StoredEvent[]]> = {
  // 表已满，每条都是新决策：每条都淘汰最早的键。
  'decisions: new id each event': [prefill(decision, n => `d${n}`), series(decision, n => `d${n}`)],
  // 表已满，每条更新已有决策：不淘汰。
  'decisions: update existing ids': [prefill(decision, n => `d${n}`), series(decision, n => `d${n % 500}`)],
  // 整数形态的 id 按数值顺序最先枚举，淘汰的是最小的那个。
  'decisions: integer-form new ids': [prefill(decision, n => String(n)), series(decision, n => String(n))],
  'attempts: new id each event': [prefill(attempt, n => `a${n}`), series(attempt, n => `a${n}`)],
  // 表未满时（只有 50 个键）作为参照。
  'decisions: 50 keys, update': [
    Array.from({length: 50}, (_item, n) => decision(n + 1, `d${n}`)),
    series(decision, n => `d${n % 50}`, 50),
  ],
};

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const round = (value: number) => Math.round(value * 1000) / 1000;
const result: Record<string, unknown> = {
  module: path.relative(process.cwd(), modulePath),
  node: process.version,
  events: total,
  repeat,
};
for (const [name, [fill, timed]] of Object.entries(cases)) {
  measure(fill, timed); // 预热
  const samples: number[] = [];
  let run: State.RunState | undefined;
  for (let i = 0; i < repeat; i++) {
    const measured = measure(fill, timed);
    samples.push(measured.us);
    run = measured.run;
  }
  const keys = Object.keys(name.startsWith('attempts') ? run!.attempts : run!.decisions);
  result[name] = {
    medianUsPerEvent: round(median(samples)),
    minUsPerEvent: round(Math.min(...samples)),
    keys: keys.length,
    first: keys[0],
    last: keys.at(-1),
    limited: run!.limited,
  };
}
console.log(JSON.stringify(result, null, 2));

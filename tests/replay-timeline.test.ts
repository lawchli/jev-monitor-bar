import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type {EventType, Payload, StoredEvent} from '../src/protocol';
import {validateEvent} from '../src/protocol';
import {sanitizeEvent} from '../src/redact';
import {
  REPLAY_CHECKPOINT_INTERVAL,
  REPLAY_MAX_CHECKPOINTS,
  ReplayTimeline,
  parseReplay,
  replaySnapshot,
} from '../src/replay';
import {applyEvent, evictRuns, restoreRun, type EvictedRun, type RunState} from '../src/state';
import {EventStore} from '../src/store';

// ReplayTimeline 用检查点拖动；这里逐个位置与 replaySnapshot 的从头计算比较。

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const base = Date.UTC(2026, 0, 1);
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * 带种子的混合事件流：超过 200 个 run（会淘汰），决策、动作、验证、进度、心跳与丢弃计数，
 * 重复 event_id、重复序号、乱序时间、同一时间、关联冲突、整数形态的 decision_id，以及一个超过 500 个决策的 run。
 */
function mixedEvents(total: number, runCount: number, seed: number, spawn = 0.08): StoredEvent[] {
  const random = mulberry32(seed);
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)];
  const runs = Array.from({length: runCount}, (_item, index) => `run-${String(index).padStart(3, '0')}`);
  const sequences = new Map<string, number>();
  const events: StoredEvent[] = [];
  let clock = base;
  let cursor = 0;
  let nextRun = 0;
  const active: string[] = [];
  const big = 'run-big';
  let bigDecision = 0;
  for (let index = 0; index < total; index++) {
    clock += Math.floor(random() * 3) * 500;
    // 新 run 陆续出现，保持约 40 个活跃，总数超过 200。
    let runId: string;
    if (index % 5 === 3) runId = big;
    else if (nextRun < runs.length && (active.length < 40 || random() < spawn)) {
      runId = runs[nextRun++];
      active.push(runId);
    } else runId = pick(active.length > 0 ? active : runs);
    const producer = `${runId}-p${random() < 0.2 ? 2 : 1}`;
    let sequence = (sequences.get(producer) ?? 0) + 1;
    if (random() < 0.02 && sequence > 1) sequence -= 1; // 重复序号
    sequences.set(producer, sequence);
    const roll = random();
    let type: EventType;
    const extra: Partial<StoredEvent> = {};
    let payload: Payload = {};
    // run-big 每条都是新决策，超过 500 条上限后按插入顺序丢最早的键；其他 run 混用整数形态的 id。
    const decisionPool = runId === big ? `b${bigDecision++}` : pick(['d0', 'd1', 'd2', '7', '12', '300']);
    const attemptKey = {action_id: `a${Math.floor(random() * 4)}`, attempt_id: `t${Math.floor(random() * 3)}`};
    if (runId === big) {
      type = pick(['decision.started', 'decision.resolved'] as const);
      extra.decision_id = decisionPool;
      extra.request_id = 'r1';
      payload = {question: `问题 ${decisionPool}`, choice: 'A'};
    } else if (roll < 0.05) {
      type = 'run.started';
      payload = {name: `任务 ${runId}`, simulated: random() < 0.5};
    } else if (roll < 0.09) {
      type = pick(['run.completed', 'run.failed', 'run.cancelled'] as const);
      const at = active.indexOf(runId);
      if (at >= 0 && random() < 0.7) active.splice(at, 1);
    } else if (roll < 0.35) {
      type = pick(['decision.started', 'decision.resolved', 'decision.failed'] as const);
      extra.decision_id = decisionPool;
      extra.request_id = random() < 0.05 ? 'r-other' : 'r1';
      extra.question_id = random() < 0.5 ? 'q1' : undefined;
      if (extra.question_id === undefined) delete extra.question_id;
      payload = {question: '选哪个', choice: pick(['A', 'B']), candidates: {A: '甲', B: null}, confidence: random()};
    } else if (roll < 0.7) {
      type = pick([
        'action.selected',
        'action.started',
        'action.completed',
        'action.failed',
        'action.cancelled',
        'verification.completed',
      ] as const);
      Object.assign(extra, attemptKey);
      if (random() < 0.6) extra.decision_id = random() < 0.05 ? 'd-conflict' : 'd1';
      payload =
        type === 'verification.completed'
          ? {
              result: pick(['passed', 'failed', 'unknown'] as const),
              checks: [{name: 'c', observed: 'o', result: 'passed'}],
            }
          : {action: pick(['点击', '输入'])};
    } else if (roll < 0.8) {
      type = 'progress.updated';
      payload = {completed: index, total: total, phase: '阶段'};
    } else if (roll < 0.85) {
      type = 'telemetry.dropped';
      payload = {count: 1 + Math.floor(random() * 3)};
    } else type = 'heartbeat';
    // 乱序：偶尔比时钟早，或与上一条同一时间。
    const occurredMs = random() < 0.1 ? clock - Math.floor(random() * 5000) : clock;
    const receivedMs = random() < 0.1 ? clock - 1000 : clock;
    cursor = random() < 0.02 ? -cursor : random() < 0.02 ? cursor : Math.abs(cursor) + 1;
    const duplicateId = random() < 0.02 && events.length > 0;
    events.push({
      schema_version: 1,
      event_id: duplicateId ? pick(events).event_id : `e${index}`,
      run_id: runId,
      producer_id: producer,
      sequence,
      occurred_at: iso(occurredMs),
      type,
      payload,
      ...extra,
      received_at: iso(receivedMs),
      cursor,
    });
  }
  return events;
}

/**
 * 与 replaySnapshot 同样的循环，只记下哪些位置发生了淘汰（第 i 条应用后 run 超过 200），
 * 以及哪些位置把已淘汰的 run 按记录恢复（revived）。
 */
function replayEvictions(events: readonly StoredEvent[]) {
  const runs = new Map<string, RunState>();
  const evicted = new Map<string, EvictedRun>();
  const ids = new Set<string>();
  const sequences = new Set<string>();
  const points: {index: number; evicted: string; added: string}[] = [];
  const revived: {index: number; runId: string; ended: boolean}[] = [];
  events.forEach((event, index) => {
    const key = JSON.stringify([event.run_id, event.producer_id, event.sequence]);
    if (ids.has(event.event_id) || sequences.has(key)) return;
    ids.add(event.event_id);
    sequences.add(key);
    let run = runs.get(event.run_id);
    if (!run) {
      const past = evicted.get(event.run_id);
      if (past) revived.push({index, runId: event.run_id, ended: past.ended_at !== undefined});
      run = restoreRun(event.run_id, evicted);
      runs.set(event.run_id, run);
    }
    applyEvent(run, event);
    const before = [...runs.keys()];
    evictRuns(runs, evicted);
    for (const id of before) if (!runs.has(id)) points.push({index, evicted: id, added: event.run_id});
  });
  return {points, revived};
}
const evictionPoints = (events: readonly StoredEvent[]) => replayEvictions(events).points;

function same(timeline: ReplayTimeline, events: readonly StoredEvent[], count: number, runId?: string) {
  assert.deepStrictEqual(
    timeline.snapshot(count, runId),
    replaySnapshot(events, count, runId),
    `count=${count} runId=${runId ?? '(auto)'}`,
  );
}

const mixed = mixedEvents(3000, 260, 7);
const mixedFrozen = JSON.stringify(mixed);

test('the mixed stream covers eviction, duplicates, the 500-decision bound and anomalies', () => {
  const full = replaySnapshot(mixed, mixed.length);
  assert.equal(full.runs.length, 200);
  assert.ok(evictionPoints(mixed).length > 20);
  assert.ok(new Set(mixed.map(event => event.run_id)).size > 200);
  const big = replaySnapshot(mixed, mixed.length, 'run-big').run;
  assert.equal(big?.limited, true);
  assert.equal(Object.keys(big?.decisions ?? {}).length, 500);
  assert.ok(full.runs.some(run => run.anomalies > 0));
  const applied = new Set(full.runs.map(run => run.id));
  assert.ok(applied.size > 0);
  assert.ok(mixed.length - new Set(mixed.map(event => event.event_id)).size > 10);
});

test('checkpointed snapshots equal the from-scratch replay at random positions and run ids', () => {
  const random = mulberry32(11);
  const runIds = [...new Set(mixed.map(event => event.run_id))];
  for (const interval of [97, 1000]) {
    const timeline = new ReplayTimeline(mixed, interval);
    let position = mixed.length;
    for (let round = 0; round < 90; round++) {
      const move = random();
      // 随机跳、前后一步、跳过检查点边界。
      if (move < 0.4) position = Math.floor(random() * (mixed.length + 1));
      else if (move < 0.6) position = Math.min(mixed.length, position + 1);
      else if (move < 0.8) position = Math.max(0, position - 1);
      else position = Math.min(mixed.length, Math.ceil(position / interval) * interval + (random() < 0.5 ? -1 : 1));
      const choice = random();
      const runId =
        choice < 0.4 ? undefined : choice < 0.9 ? runIds[Math.floor(random() * runIds.length)] : 'run-missing';
      same(timeline, mixed, position, runId);
    }
  }
});

test('checkpointed snapshots match just before and after each run eviction', () => {
  const points = evictionPoints(mixed);
  const timeline = new ReplayTimeline(mixed, 250);
  // 第 i 条应用后淘汰：count = i 还在，count = i + 1 已淘汰。
  for (const point of points.filter((_point, index) => index % 3 === 0)) {
    for (const count of [point.index, point.index + 1]) {
      same(timeline, mixed, count);
      same(timeline, mixed, count, point.evicted);
      same(timeline, mixed, count, point.added);
    }
  }
  for (const point of points.slice(0, 5)) {
    for (const count of [point.index - 1, point.index + 2]) same(timeline, mixed, count, point.evicted);
  }
});

test('checkpoint boundaries, playback steps and out-of-range counts agree', () => {
  const timeline = new ReplayTimeline(mixed, 100);
  for (const boundary of [0, 100, 1000, 1900, 2900, 3000]) {
    for (const count of [boundary - 1, boundary, boundary + 1]) same(timeline, mixed, count);
  }
  // 连续播放一段，再倒着走回去。
  for (let count = 1450; count <= 1520; count++) same(timeline, mixed, count);
  for (let count = 1520; count >= 1480; count--) same(timeline, mixed, count, 'run-big');
  for (const count of [-5, Number.NaN, Number.POSITIVE_INFINITY, 1e9, 12.7]) same(timeline, mixed, count);
});

test('a short stream matches at every position with a tiny interval', () => {
  const events = mixedEvents(420, 230, 3, 0.6);
  assert.ok(evictionPoints(events).length > 0);
  const timeline = new ReplayTimeline(events, 7);
  for (let count = 0; count <= events.length; count++) same(timeline, events, count);
  for (let count = events.length; count >= 0; count -= 13) same(timeline, events, count, events[count]?.run_id);
});

test('replay timeline never mutates events and hands out copies of its state', () => {
  const timeline = new ReplayTimeline(mixed, 200);
  const first = timeline.snapshot(1234, 'run-big');
  assert.ok(first.run);
  // 外面改返回值，不影响之后同一位置的结果。
  first.run.status = 'tampered';
  first.run.decisions['0'] = {id: 'x', status: 'x', payload: {}};
  for (const decision of Object.values(first.run.decisions)) decision.status = 'tampered';
  first.events.length = 0;
  first.runs.length = 0;
  same(timeline, mixed, 1234, 'run-big');
  same(timeline, mixed, 1300, 'run-big');
  same(timeline, mixed, 1200, 'run-big');
  same(timeline, mixed, mixed.length);
  assert.equal(JSON.stringify(mixed), mixedFrozen);
});

function a7Runs(count: number): StoredEvent[] {
  return Array.from({length: count}, (_item, index) => {
    const n = index + 1;
    const at = iso(base + n * 1000);
    return {
      schema_version: 1,
      event_id: `start-${n}`,
      run_id: `run-${String(n).padStart(3, '0')}`,
      producer_id: 'host-1',
      sequence: 1,
      occurred_at: at,
      type: 'run.started',
      payload: {name: `任务${n}`},
      received_at: at,
      cursor: n,
    };
  });
}

test('A7 cases: 201 runs, the chosen run evicted, and stepping back before it started', () => {
  const events = a7Runs(201);
  for (const interval of [1000, 50]) {
    const timeline = new ReplayTimeline(events, interval);
    for (const runId of [undefined, 'run-001', 'run-150', 'run-201']) {
      for (const count of [201, 200, 199, 150, 149, 151, 1, 0, 201]) same(timeline, events, count, runId);
    }
    const opened = timeline.snapshot(201);
    assert.equal(opened.runs.length, 200);
    assert.equal(opened.run?.id, 'run-201');
    const evicted = timeline.snapshot(201, 'run-001');
    assert.equal(evicted.run?.id, 'run-201');
    assert.equal(evicted.events.length, 1);
  }
});

const parsers = {validateEvent, sanitizeEvent};

function line(sequence: number, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    schema_version: 1,
    event_id: `e${sequence}`,
    run_id: 'run-1',
    producer_id: 'host-1',
    sequence,
    occurred_at: iso(base + sequence * 1000),
    type: 'heartbeat',
    payload: {},
    ...extra,
  });
}

test('parseReplay keeps the newest events and counts earlier valid and invalid lines', () => {
  const text = [
    line(1),
    'not-json',
    line(2, {payload: {summary: 'password=early'}}),
    line(3, {cursor: 1.5}),
    line(4),
    '{"torn"',
    line(5, {payload: {summary: 'password=hunter2'}}),
    line(6, {cursor: 60, received_at: '2026-01-01T00:01:00.000Z'}),
  ].join('\r\n');
  const parsed = parseReplay(text, parsers, 3);
  assert.deepEqual(
    parsed.events.map(event => event.event_id),
    ['e4', 'e5', 'e6'],
  );
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.omitted, 2);
  assert.equal(parsed.invalidLines, 3);
  // 缺 cursor 时仍用 1 起的行号。
  assert.deepEqual(
    parsed.events.map(event => event.cursor),
    [5, 7, 60],
  );
  assert.equal(parsed.events[1].payload.summary, 'password=[REDACTED]');
  assert.equal(parsed.events[2].received_at, '2026-01-01T00:01:00.000Z');

  const exact = parseReplay(text, parsers, 5);
  assert.equal(exact.truncated, false);
  assert.equal(exact.omitted, 0);
  assert.deepEqual(
    exact.events.map(event => event.event_id),
    ['e1', 'e2', 'e4', 'e5', 'e6'],
  );
});

test('export then replay keeps the same newest events as the live memory window', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-replay-window-'));
  const window = 40;
  const store = new EventStore(path.join(dir, 'events'), window);
  const at = (n: number) => iso(base + n * 1000);
  // run-old 在窗口之前开始，run-new 完全在窗口里。
  let sequence = 0;
  const ingest = (runId: string, type: EventType, payload: Payload = {}) => {
    sequence++;
    const result = store.ingest({
      schema_version: 1,
      event_id: `w${sequence}`,
      run_id: runId,
      producer_id: 'host-1',
      sequence,
      occurred_at: at(sequence),
      type,
      payload,
    });
    assert.equal(result.accepted, true);
  };
  ingest('run-old', 'run.started', {name: '早开始'});
  for (let n = 0; n < 60; n++) ingest('run-old', 'heartbeat');
  ingest('run-new', 'run.started', {name: '窗口内'});
  for (let n = 0; n < 20; n++) ingest(n % 2 ? 'run-new' : 'run-old', 'progress.updated', {completed: n});
  assert.equal(store.events.length, window);

  const exported = store.exportLines();
  const parsed = parseReplay(exported.text, parsers, window);
  assert.equal(parsed.omitted, sequence - window);
  assert.deepEqual(
    parsed.events.map(event => event.event_id),
    store.events.map(event => event.event_id),
  );
  const timeline = new ReplayTimeline(parsed.events);
  const replayed = timeline.snapshot(parsed.events.length, 'run-new');
  assert.deepStrictEqual(replayed, replaySnapshot(parsed.events, parsed.events.length, 'run-new'));
  // 完全落在窗口里的 run，回放与实时聚合一致；窗口之前开始的 run 在回放里缺更早的事件。
  assert.deepEqual(replayed.run, store.snapshot('run-new').run);
  const old = timeline.snapshot(parsed.events.length, 'run-old').run;
  assert.ok(old);
  assert.ok(old.event_count < (store.snapshot('run-old').run?.event_count ?? 0));
});

test('more events widen the checkpoint interval instead of adding checkpoints', () => {
  const heartbeats = (count: number) =>
    Array.from({length: count}, (_item, index): StoredEvent => {
      const at = iso(base + index);
      return {
        schema_version: 1,
        event_id: `h${index}`,
        run_id: `run-${index % 3}`,
        producer_id: 'host-1',
        sequence: index,
        occurred_at: at,
        type: 'heartbeat',
        payload: {},
        received_at: at,
        cursor: index + 1,
      };
    });
  assert.equal(new ReplayTimeline(heartbeats(20000)).interval, REPLAY_CHECKPOINT_INTERVAL);
  const wide = heartbeats(REPLAY_CHECKPOINT_INTERVAL * REPLAY_MAX_CHECKPOINTS * 2 + 1);
  const timeline = new ReplayTimeline(wide);
  assert.equal(timeline.interval, REPLAY_CHECKPOINT_INTERVAL * 2 + 1);
  same(timeline, wide, wide.length);
  same(timeline, wide, timeline.interval * 7 + 3, 'run-1');
});

test('runs brought back after eviction match at every position, and the mixed stream brings back ended runs', () => {
  const {revived} = replayEvictions(mixed);
  assert.ok(revived.some(item => item.ended));
  const events = mixedEvents(600, 230, 3, 0.6);
  assert.ok(replayEvictions(events).revived.length > 0);
  for (const interval of [7, 50]) {
    const timeline = new ReplayTimeline(events, interval);
    for (let count = 0; count <= events.length; count++) same(timeline, events, count, events[count - 1]?.run_id);
  }
  for (const item of revived.slice(0, 10)) {
    const timeline = new ReplayTimeline(mixed, 250);
    for (const count of [item.index, item.index + 1, item.index + 2]) same(timeline, mixed, count, item.runId);
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import type {StoredEvent} from '../src/protocol';
import {ReplayTimeline, replaySnapshot} from '../src/replay';
import {applyEvent, emptyRun, type RunState} from '../src/state';

// 每个 run 最多 500 个决策 / 尝试。这里拿每条事件都调用 Object.keys、删掉 keys[0] 的旧做法当参照，
// 逐条比较保留的键（含顺序）和 limited。整数形态的 id 按数值顺序最先枚举，所以被删的不一定是最早插入的键。

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Table = Record<string, unknown>;
interface Model {
  decisions: Table;
  attempts: Table;
  limited: boolean;
  /** 被删的键不是表里最早插入的那个的次数。 */
  outOfInsertionOrder: number;
  inserted: string[];
}
const dict = () => Object.create(null) as Table;
const newModel = (): Model => ({
  decisions: dict(),
  attempts: dict(),
  limited: false,
  outOfInsertionOrder: 0,
  inserted: [],
});

function oldBound(map: Table, model: Model) {
  const keys = Object.keys(map);
  if (keys.length > 500) {
    if (map === model.decisions) {
      const oldest = model.inserted.find(key => key in map);
      if (oldest !== keys[0]) model.outOfInsertionOrder++;
    }
    delete map[keys[0]];
    model.limited = true;
  }
}

/** 事件里没有关联冲突，所以 applyEvent 对每条决策 / 动作事件都会走到 bound。 */
function applyModel(model: Model, e: StoredEvent) {
  if (e.type.startsWith('decision.') && e.decision_id) {
    if (!(e.decision_id in model.decisions)) model.inserted.push(e.decision_id);
    model.decisions[e.decision_id] ??= true;
    oldBound(model.decisions, model);
  }
  if (e.action_id && e.attempt_id) {
    model.attempts[JSON.stringify([e.action_id, e.attempt_id])] ??= true;
    oldBound(model.attempts, model);
  }
}

function copyTable(table: Table): Table {
  const copy = dict();
  for (const key of Object.keys(table)) copy[key] = table[key];
  return copy;
}
// 与 replay.ts 的 copyRun 相同：表按 Object.keys 的顺序复制，条目各复制一层。
function copyRun(run: RunState): RunState {
  const entries = <T extends object>(table: Record<string, T>) => {
    const copy = Object.create(null) as Record<string, T>;
    for (const key of Object.keys(table)) copy[key] = {...table[key]};
    return copy;
  };
  return {...run, decisions: entries(run.decisions), attempts: entries(run.attempts)};
}
const copyModel = (model: Model): Model => ({
  ...model,
  decisions: copyTable(model.decisions),
  attempts: copyTable(model.attempts),
  inserted: [...model.inserted],
});

function same(run: RunState, model: Model, label: string) {
  assert.deepEqual(Object.keys(run.decisions), Object.keys(model.decisions), `decisions ${label}`);
  assert.deepEqual(Object.keys(run.attempts), Object.keys(model.attempts), `attempts ${label}`);
  assert.equal(run.limited, model.limited, `limited ${label}`);
}

const edgeIds = ['0', '4294967294', '4294967295', '4294967296', '01', '-0', '1e3', ' 7', '7.0', 'NaN', '__proto__'];

/** 带种子的决策与动作事件：字符串 id、整数形态的 id、边界写法混用，会重复也会在被删后再出现。 */
function events(total: number, seed: number, runIds: readonly string[] = ['run-1']): StoredEvent[] {
  const random = mulberry32(seed);
  const int = (n: number) => Math.floor(random() * n);
  const at = new Date(Date.UTC(2026, 0, 1)).toISOString();
  return Array.from({length: total}, (_item, index): StoredEvent => {
    const base = {
      schema_version: 1 as const,
      event_id: `s${seed}-${index}`,
      run_id: runIds[int(runIds.length)],
      producer_id: 'p1',
      sequence: index + 1,
      occurred_at: at,
      payload: {},
      received_at: at,
      cursor: index + 1,
    };
    if (random() < 0.6) {
      const roll = random();
      const id =
        roll < 0.45
          ? `d${int(900)}`
          : roll < 0.8
            ? String(int(1200))
            : roll < 0.9
              ? edgeIds[int(edgeIds.length)]
              : `n${seed}-${index}`;
      const type = (['decision.started', 'decision.resolved', 'decision.failed'] as const)[int(3)];
      return {...base, type, decision_id: id, request_id: 'r1'};
    }
    const type = (['action.selected', 'action.started', 'action.completed'] as const)[int(3)];
    return {...base, type, action_id: `a${int(30)}`, attempt_id: `t${int(40)}`};
  });
}

test('bound keeps the same keys, in the same order, and the same limited flag as the Object.keys version', () => {
  const stream = events(4000, 21);
  const run = emptyRun('run-1');
  const model = newModel();
  stream.forEach((event, index) => {
    applyEvent(run, event);
    applyModel(model, event);
    same(run, model, `at ${index}`);
  });
  assert.equal(Object.keys(run.decisions).length, 500);
  assert.equal(Object.keys(run.attempts).length, 500);
  assert.equal(run.limited, true);
  // 确实删到过「不是最早插入」的键，并且最后表里同时有整数形态和字符串的 id。
  assert.ok(model.outOfInsertionOrder > 50, `outOfInsertionOrder=${model.outOfInsertionOrder}`);
  const keys = Object.keys(run.decisions);
  assert.ok(keys.some(key => /^\d+$/.test(key)) && keys.some(key => !/^\d+$/.test(key)));
});

test('a copied run and the run it was copied from keep evicting independently and like before', () => {
  const stream = events(3000, 5);
  const run = emptyRun('run-1');
  const model = newModel();
  const forks: {run: RunState; model: Model; stream: StoredEvent[]}[] = [];
  stream.forEach((event, index) => {
    applyEvent(run, event);
    applyModel(model, event);
    // 未满、刚满、已满后各复制一次，复制品接着收另一串事件。
    if (index === 300 || index === 900 || index === 2000)
      forks.push({run: copyRun(run), model: copyModel(model), stream: events(800, 100 + index)});
    if (index % 5 === 0) {
      for (const fork of forks) {
        const next = fork.stream.shift();
        if (!next) continue;
        applyEvent(fork.run, next);
        applyModel(fork.model, next);
        same(fork.run, fork.model, `fork at ${index}`);
      }
    }
    same(run, model, `at ${index}`);
  });
  for (const fork of forks) {
    for (const event of fork.stream) {
      applyEvent(fork.run, event);
      applyModel(fork.model, event);
    }
    same(fork.run, fork.model, 'fork end');
    assert.equal(fork.run.limited, true);
  }
});

test('the checkpointed replay copies tables on write and still matches the from-scratch replay and the old bound', () => {
  const stream = events(3500, 9, ['run-a', 'run-b']);
  const random = mulberry32(17);
  for (const interval of [97, 1000]) {
    const timeline = new ReplayTimeline(stream, interval);
    const counts = [stream.length, 0, 1, 1200, 1199, 2300, 970, 971, 3499];
    for (let i = 0; i < 25; i++) counts.push(Math.floor(random() * (stream.length + 1)));
    for (const count of counts) {
      for (const runId of ['run-a', 'run-b']) {
        const snapshot = timeline.snapshot(count, runId);
        assert.deepStrictEqual(snapshot, replaySnapshot(stream, count, runId), `count=${count} ${runId}`);
        const mine = stream.slice(0, count).filter(event => event.run_id === runId);
        const model = newModel();
        for (const event of mine) applyModel(model, event);
        if (mine.length > 0) same(snapshot.run!, model, `count=${count} ${runId}`);
        else assert.notEqual(snapshot.run?.id, runId);
      }
    }
  }
});

test('a table first seen with more than 500 keys loses one key per event, as before', () => {
  const run = emptyRun('run-1');
  const model = newModel();
  // 不经 applyEvent 直接放进 505 个键：第一次 bound 时才数。
  for (const id of [
    ...Array.from({length: 300}, (_item, n) => `x${n}`),
    ...Array.from({length: 205}, (_item, n) => `${n * 3}`),
  ]) {
    run.decisions[id] = {id, request_id: 'r1', status: 'unknown', payload: {}};
    model.decisions[id] = true;
    model.inserted.push(id);
  }
  // 随机的新键与旧键，再加几条只更新已有键的事件：旧做法在超过 500 时每条都删一个。
  const updates = events(40, 4)
    .filter(event => event.decision_id)
    .slice(0, 8)
    .map(event => ({...event, decision_id: 'x299'}));
  const stream = [...events(40, 3).filter(event => event.decision_id), ...updates];
  for (const [index, event] of stream.entries()) {
    applyEvent(run, event);
    applyModel(model, event);
    same(run, model, `at ${index}`);
  }
  assert.equal(Object.keys(run.decisions).length, 500);
});

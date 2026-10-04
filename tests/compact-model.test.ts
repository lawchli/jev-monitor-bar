import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventStore} from '../src/store';
import type {ReceiverStatus} from '../src/ipc';
import {formatClock} from '../src/renderer/view-model/common';
import {compactModel} from '../src/renderer/compact/model';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jev-compact-'));
const at = (sec: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, sec)).toISOString();

function events(runId: string) {
  let n = 0;
  return (type: string, extra: Record<string, unknown> = {}, payload: Record<string, unknown> = {}, sec?: number) => {
    n += 1;
    return {
      schema_version: 1 as const,
      event_id: `${runId}-${n}`,
      run_id: runId,
      producer_id: 'host-1',
      sequence: n,
      occurred_at: at(sec ?? n),
      type,
      payload,
      ...extra,
    };
  };
}

function ingest(store: EventStore, rows: unknown[]) {
  for (const row of rows) assert.equal(store.ingest(row).accepted, true);
}

function status(partial: Partial<ReceiverStatus> = {}): ReceiverStatus {
  return {
    listening: true,
    url: 'http://127.0.0.1:9',
    dataDir: '/tmp/jev',
    corruptLines: 0,
    platform: {os: 'linux-x11', arch: 'x64', tier: 2, alwaysOnTopSupported: true, notes: []},
    mode: 'compact',
    pinned: true,
    startedAt: at(0),
    ...partial,
  };
}

const decision = (id: string) => ({decision_id: id, request_id: 'req1', question_id: 'next'});
const attempt = (id: string, decisionId = 'd1') => ({action_id: 'act1', attempt_id: id, decision_id: decisionId});

test('compact model describes an empty receiver', () => {
  const store = new EventStore(tempDir());
  const model = compactModel(store.snapshot(), status(), Date.now());
  assert.equal(model.hasRun, false);
  assert.equal(model.waiting, '任务发来事件后，会显示在这里。');
  assert.equal(model.name, '还没有运行记录');
  assert.equal(model.receiver, '监听中 · http://127.0.0.1:9');
  assert.equal(model.connectionText, model.receiver);
  assert.equal(model.runStatus, '等待');
  assert.equal(model.otherRunning, 0);
  assert.equal(model.nextRunId, undefined);
  assert.equal(model.simulated, false);
  for (const key of ['phase', 'progress', 'duration', 'choice', 'action', 'execStatus'] as const) {
    assert.equal(model[key], '未知');
  }
  assert.equal(compactModel(undefined, undefined, Date.now()).name, '正在读取本地记录…');
  assert.equal(
    compactModel(store.snapshot(), status({listening: false, url: undefined}), Date.now()).receiver,
    '未监听',
  );
  assert.equal(compactModel(store.snapshot(), undefined, Date.now()).receiver, '未连接');
});

test('compact model shows an evaluating run and summary-only fallback', () => {
  const store = new EventStore(tempDir());
  const ev = events('run-1');
  const started = ev('run.started', {}, {name: '整理报告'}, 0);
  ingest(store, [
    started,
    ev('decision.started', decision('d1'), {kind: 'choice', question: '下一步？'}),
    ev('progress.updated', {}, {completed: 4}),
  ]);
  const now = Date.parse(started.occurred_at) + 12_000;
  const model = compactModel(store.snapshot('run-1'), status(), now);
  assert.equal(model.hasRun, true);
  assert.equal(model.simulated, false);
  assert.equal(model.runStatus, '评估中');
  assert.equal(model.runTone, 'active');
  assert.equal(model.choice, '正在评估候选');
  assert.equal(model.actionText, '未知');
  assert.equal(model.execStatus, '未知');
  assert.equal(model.phase, '未知');
  assert.equal(model.progress, '已完成 4 步');
  assert.equal(model.duration, '12秒');
  assert.equal(model.eventType, 'progress.updated');

  const summary = compactModel(store.snapshot(), status(), now);
  assert.equal(summary.hasRun, true);
  assert.equal(summary.name, '整理报告');
  assert.equal(summary.choice, '未知');
  assert.equal(summary.progress, '已完成 4 步');
});

test('compact model shows the latest choice, progress, and truncates the name', () => {
  const store = new EventStore(tempDir());
  const ev = events('run-1');
  const fullName = '甲'.repeat(41);
  const started = ev('run.started', {}, {name: fullName, simulated: false}, 0);
  const rows = [
    started,
    ev('progress.updated', {}, {phase: '汇总', completed: 2, total: 5}),
    ev('decision.resolved', decision('d-old'), {kind: 'choice', choice: '旧选项'}),
    ev('decision.resolved', decision('d-new'), {kind: 'choice', choice: '打开报告'}),
    ev('action.selected', attempt('t1', 'd-new'), {action: '打开报告', source: 'model'}),
    ev('heartbeat'),
  ];
  const selected = rows[4];
  ingest(store, rows);
  const now = Date.parse(started.occurred_at) + 12_000;
  const model = compactModel(store.snapshot('run-1'), status(), now);
  assert.equal(model.nameFull, fullName);
  assert.equal(model.name, `${'甲'.repeat(40)}…`);
  assert.equal(model.simulated, false);
  assert.equal(model.choice, '打开报告');
  assert.equal(model.action, '打开报告');
  assert.equal(model.actionSource, '模型');
  assert.equal(model.overridden, false);
  assert.equal(model.actionText, '打开报告 · 模型');
  assert.equal(model.execStatus, '已选择');
  assert.equal(model.execTone, 'active');
  assert.equal(model.phase, '汇总');
  assert.equal(model.progress, '2/5');
  assert.equal(model.duration, '12秒');
  assert.equal(model.eventType, 'action.selected');
  assert.equal(model.eventTime, formatClock(selected.occurred_at));
  assert.equal(model.runStatus, '已选择');
});

test('compact model formats score with the nearest legend grade', () => {
  const store = new EventStore(tempDir());
  const ev = events('run-score');
  ingest(store, [
    ev('run.started', {}, {name: '评分'}, 0),
    ev('decision.resolved', decision('d1'), {
      kind: 'score',
      score: 1.43,
      legend: {0: '安全', 1: '注意', 2: '危险'},
    }),
  ]);
  const graded = compactModel(store.snapshot('run-score'), status(), Date.now());
  assert.equal(graded.choice, '1.43 注意');

  const plain = events('run-plain');
  ingest(store, [
    plain('run.started', {}, {name: '无图例'}, 0),
    plain('decision.resolved', decision('d1'), {kind: 'score', score: 2}),
  ]);
  assert.equal(compactModel(store.snapshot('run-plain'), status(), Date.now()).choice, '2');

  const gap = events('run-gap');
  ingest(store, [
    gap('run.started', {}, {name: '缺口'}, 0),
    gap('decision.resolved', decision('d1'), {kind: 'score', score: 1.2, legend: {0: '低', 2: '高'}}),
  ]);
  assert.equal(compactModel(store.snapshot('run-gap'), status(), Date.now()).choice, '1.2 高');
});

test('compact model formats noul as a yes percentage', () => {
  const store = new EventStore(tempDir());
  const ev = events('run-noul');
  ingest(store, [
    ev('run.started', {}, {name: '是否完成', simulated: true}, 0),
    ev('decision.resolved', decision('d1'), {kind: 'noul', noul: 0.86}),
  ]);
  const model = compactModel(store.snapshot('run-noul'), status(), Date.now());
  assert.equal(model.choice, `是 ${Math.round(0.86 * 100)}%`);
  assert.equal(model.simulated, true);
  assert.equal(model.overridden, false);
});

test('compact model marks a rule override when the action differs from the choice', () => {
  const store = new EventStore(tempDir());
  const ev = events('run-rule');
  ingest(store, [
    ev('run.started', {}, {name: '规则覆盖'}, 0),
    ev('decision.resolved', decision('d1'), {kind: 'choice', choice: 'a'}),
    ev('action.selected', attempt('t1'), {action: 'b', source: 'rule', rule: 'avoid-danger', rule_source: 'policy'}),
  ]);
  const model = compactModel(store.snapshot('run-rule'), status(), Date.now());
  assert.equal(model.choice, 'a');
  assert.equal(model.action, 'b');
  assert.equal(model.actionSource, '规则');
  assert.equal(model.overridden, true);
  assert.equal(model.actionText, 'b · 规则 · 已覆盖');
  assert.equal(model.execStatus, '已选择');

  const app = events('run-app');
  ingest(store, [
    app('run.started', {}, {name: '应用'}, 0),
    app('decision.resolved', decision('d1'), {kind: 'choice', choice: '留下'}),
    app('action.selected', attempt('t1'), {action: '留下', source: 'application'}),
  ]);
  const applied = compactModel(store.snapshot('run-app'), status(), Date.now());
  assert.equal(applied.actionSource, '应用');
  assert.equal(applied.overridden, false);
  assert.equal(applied.actionText, '留下 · 应用');
});

test('compact model follows the retry instead of the failed attempt', () => {
  const store = new EventStore(tempDir());
  const ev = events('run-retry');
  ingest(store, [
    ev('run.started', {}, {name: '重试'}, 0),
    ev('decision.resolved', decision('d1'), {kind: 'choice', choice: '重试动作'}),
    ev('action.selected', attempt('t1'), {action: '重试动作', source: 'model'}),
    ev('action.failed', attempt('t1'), {reason: 'timeout'}),
    ev('action.selected', attempt('t2'), {action: '重试动作', source: 'model'}),
    ev('action.started', attempt('t2')),
  ]);
  const model = compactModel(store.snapshot('run-retry'), status(), Date.now());
  assert.equal(model.actionText, '重试动作 · 模型');
  assert.equal(model.overridden, false);
  assert.equal(model.execStatus, '执行中');
  assert.equal(model.execTone, 'active');
  assert.equal(model.runStatus, '执行中');
  assert.notEqual(model.execStatus, '失败');
});

test('compact model reports verification failure separately from completion', () => {
  const store = new EventStore(tempDir());
  const ev = events('run-verify');
  const started = ev('run.started', {}, {name: '验证'}, 0);
  ingest(store, [
    started,
    ev('action.selected', attempt('t1'), {action: '写入', source: 'model'}),
    ev('action.completed', attempt('t1')),
    ev('verification.completed', attempt('t1'), {
      result: 'failed',
      checks: [{name: 'file', observed: 'missing', result: 'failed'}],
    }),
  ]);
  const open = compactModel(store.snapshot('run-verify'), status(), Date.parse(started.occurred_at) + 5_000);
  assert.equal(open.execStatus, '验证失败');
  assert.equal(open.execTone, 'danger');
  assert.equal(open.runStatus, '验证失败');
  assert.equal(open.runTone, 'danger');
  assert.equal(open.actionText, '写入 · 模型');

  ingest(store, [ev('run.completed', {}, {}, 185)]);
  const ended = compactModel(store.snapshot('run-verify'), status(), Date.now());
  assert.equal(ended.runStatus, '任务结束');
  assert.equal(ended.runTone, 'success');
  assert.equal(ended.connectionKind, 'ended');
  assert.equal(ended.connectionText, '已结束');
  assert.equal(ended.duration, '3分05秒');
  assert.equal(ended.execStatus, '验证失败');
});

test('compact model reports a stale connection from last_received', () => {
  const store = new EventStore(tempDir());
  const ev = events('run-stale');
  ingest(store, [ev('run.started', {}, {name: '静默'}, 0), ev('heartbeat')]);
  const snapshot = store.snapshot('run-stale');
  const last = Date.parse(snapshot.run?.last_received ?? '');
  assert.equal(compactModel(snapshot, status(), last + 5_000).connectionText, '在线');
  assert.equal(compactModel(snapshot, status(), last + 15_000).connectionKind, 'quiet');
  const stale = compactModel(snapshot, status(), last + 31_000);
  assert.equal(stale.connectionKind, 'stale');
  assert.equal(stale.connectionTone, 'danger');
  assert.match(stale.connectionText, /^可能断开 · 最后更新 /);
  assert.equal(stale.eventType, 'run.started');
});

test('compact model counts other running runs and points at the next one', () => {
  const store = new EventStore(tempDir());
  const a = events('run-a');
  const b = events('run-b');
  const c = events('run-c');
  ingest(store, [
    a('run.started', {}, {name: '模拟：甲', simulated: true}, 0),
    b('run.started', {}, {name: '乙'}, 0),
    c('run.started', {}, {name: '丙'}, 0),
    c('run.completed', {}, {}, 10),
  ]);
  const first = compactModel(store.snapshot('run-a'), status(), Date.now());
  assert.equal(first.simulated, true);
  assert.equal(first.otherRunning, 1);
  assert.equal(first.nextRunId, 'run-b');

  const second = compactModel(store.snapshot('run-b'), status(), Date.now());
  assert.equal(second.simulated, false);
  assert.equal(second.otherRunning, 1);
  assert.equal(second.nextRunId, 'run-a');

  const ended = compactModel(store.snapshot('run-c'), status(), Date.now());
  assert.equal(ended.connectionText, '已结束');
  assert.equal(ended.otherRunning, 2);
  assert.equal(ended.nextRunId, 'run-a');
  assert.equal(ended.duration, '10秒');
});

test('compact model passes through platform notes and storage errors', () => {
  const store = new EventStore(tempDir());
  const ev = events('run-1');
  ingest(store, [ev('run.started', {}, {name: '提示'}, 0)]);
  const model = compactModel(
    store.snapshot('run-1'),
    status({
      storageError: '磁盘已满',
      platform: {
        os: 'linux-wayland',
        arch: 'x64',
        tier: 3,
        alwaysOnTopSupported: false,
        notes: ['无法置顶', '位置可能无法恢复'],
      },
    }),
    Date.now(),
  );
  assert.deepEqual(model.notes, ['无法置顶', '位置可能无法恢复']);
  assert.equal(model.storageError, '磁盘已满');
  assert.deepEqual(compactModel(store.snapshot('run-1'), status(), Date.now()).notes, []);
});

test('compact model stays on the selected run while its detail is hidden', () => {
  const store = new EventStore(tempDir());
  const older = events('run-a');
  const selected = events('run-b');
  ingest(store, [
    older('run.started', {}, {name: '甲任务'}, 0),
    older('decision.resolved', decision('d1'), {kind: 'choice', choice: '甲选项'}),
    selected('run.started', {}, {name: '乙任务'}, 0),
    selected('progress.updated', {}, {phase: '等待', completed: 1, total: 3}),
  ]);
  const hidden = store.snapshot('run-a');
  hidden.run = undefined;
  hidden.events = [];
  const model = compactModel(hidden, status(), Date.now(), 'run-b');
  assert.equal(model.name, '乙任务');
  assert.equal(model.phase, '等待');
  assert.equal(model.progress, '1/3');
  assert.equal(model.choice, '未知');
  assert.equal(model.actionText, '未知');
  assert.equal(model.otherRunning, 1);
  assert.equal(model.nextRunId, 'run-a');
  assert.notEqual(model.name, '甲任务');

  const missing = compactModel(hidden, status(), Date.now(), 'run-missing');
  assert.equal(missing.hasRun, true);
  assert.equal(missing.name, '正在读取');
  assert.equal(missing.runStatus, '正在读取');
  assert.equal(missing.choice, '未知');
  assert.notEqual(missing.name, '甲任务');
  assert.notEqual(missing.name, '乙任务');
});

test('compact model marks an override from the linked decision, not the latest one', () => {
  const store = new EventStore(tempDir());
  const ev = events('run-link');
  ingest(store, [
    ev('run.started', {}, {name: '关联'}, 0),
    ev('decision.resolved', decision('d-old'), {kind: 'choice', choice: '留下'}),
    ev('action.selected', attempt('t1', 'd-old'), {
      action: '改写',
      source: 'rule',
      rule: 'prefer-rewrite',
      rule_source: 'policy',
    }),
    ev('decision.resolved', decision('d-new'), {kind: 'choice', choice: '改写'}),
  ]);
  const overridden = compactModel(store.snapshot('run-link'), status(), Date.now(), 'run-link');
  assert.equal(overridden.choice, '改写');
  assert.equal(overridden.overridden, true);
  assert.equal(overridden.actionText, '改写 · 规则 · 已覆盖');

  const same = events('run-same');
  ingest(store, [
    same('run.started', {}, {name: '一致'}, 0),
    same('decision.resolved', decision('d-old'), {kind: 'choice', choice: '留下'}),
    same('action.selected', attempt('t1', 'd-old'), {
      action: '留下',
      source: 'rule',
      rule: 'keep',
      rule_source: 'policy',
    }),
    same('decision.resolved', decision('d-new'), {kind: 'choice', choice: '改写'}),
  ]);
  const confirmed = compactModel(store.snapshot('run-same'), status(), Date.now(), 'run-same');
  assert.equal(confirmed.choice, '改写');
  assert.equal(confirmed.overridden, false);
  assert.equal(confirmed.actionText, '留下 · 规则');

  const scored = events('run-score-link');
  ingest(store, [
    scored('run.started', {}, {name: '分数'}, 0),
    scored('decision.resolved', decision('d1'), {kind: 'score', score: 1, legend: {'0': '低', '1': '高'}}),
    scored('action.selected', attempt('t1', 'd1'), {action: '继续', source: 'model'}),
  ]);
  const scoreModel = compactModel(store.snapshot('run-score-link'), status(), Date.now(), 'run-score-link');
  assert.equal(scoreModel.choice, '1 高');
  assert.equal(scoreModel.overridden, false);
  assert.equal(scoreModel.actionText, '继续 · 模型');

  const loose = events('run-loose');
  ingest(store, [
    loose('run.started', {}, {name: '无关联'}, 0),
    loose('decision.resolved', decision('d1'), {kind: 'choice', choice: '留下'}),
    loose('action.selected', {action_id: 'act1', attempt_id: 't1'}, {action: '改写', source: 'application'}),
  ]);
  const unlinked = compactModel(store.snapshot('run-loose'), status(), Date.now(), 'run-loose');
  assert.equal(unlinked.choice, '留下');
  assert.equal(unlinked.overridden, false);
  assert.equal(unlinked.actionText, '改写 · 应用');
});

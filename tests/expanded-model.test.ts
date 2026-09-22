import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {EventType, Payload, StoredEvent} from '../src/protocol';
import {applyEvent, emptyRun, type RunState} from '../src/state';
import {formatClock} from '../src/renderer/view-model/common';
import {attemptGroups, decisionCards, decisionChain, runSummary, timelineItems} from '../src/renderer/expanded/model';

function at(second: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
}

function event(
  sequence: number,
  type: EventType,
  payload: Payload = {},
  extra: Partial<StoredEvent> = {},
): StoredEvent {
  const occurred = extra.occurred_at ?? at(sequence);
  return {
    schema_version: 1,
    event_id: extra.event_id ?? `e${sequence}`,
    run_id: extra.run_id ?? 'run-1',
    producer_id: extra.producer_id ?? 'host',
    sequence: extra.sequence ?? sequence,
    occurred_at: occurred,
    type,
    payload,
    received_at: extra.received_at ?? occurred,
    cursor: extra.cursor ?? sequence,
    decision_id: extra.decision_id,
    request_id: extra.request_id,
    question_id: extra.question_id,
    action_id: extra.action_id,
    attempt_id: extra.attempt_id,
  };
}

function play(events: StoredEvent[]): RunState {
  const run = emptyRun(events[0]?.run_id ?? 'run-1');
  for (const item of events) applyEvent(run, item);
  return run;
}

const decisionIds = (id: string, question = 'q') => ({
  decision_id: id,
  request_id: 'req',
  question_id: question,
});

test('choice bars sort by probability and stay unknown until the decision resolves', () => {
  const run = play([
    event(
      1,
      'decision.started',
      {kind: 'choice', question: '还在看', candidates: {C: '等', A: '左', B: '右'}},
      decisionIds('eval'),
    ),
    event(
      2,
      'decision.started',
      {kind: 'choice', question: '走哪边', candidates: {A: '左', B: '右', C: '等'}},
      decisionIds('done', 'done-q'),
    ),
    event(
      3,
      'decision.resolved',
      {
        kind: 'choice',
        choice: 'B',
        probabilities: {A: 0.1, B: 0.5, C: 0.4},
        confidence: 0.62,
        model: 'jev-1',
        latency_ms: 120,
        explanation: '因为桥',
        explanation_source: '模型',
      },
      decisionIds('done', 'done-q'),
    ),
    event(
      4,
      'decision.started',
      {kind: 'choice', question: '没有分布', candidates: {B: '右', A: '左'}},
      decisionIds('plain', 'plain-q'),
    ),
    event(5, 'decision.resolved', {kind: 'choice', choice: 'A'}, decisionIds('plain', 'plain-q')),
  ]);
  const cards = decisionCards(run);
  const evaluating = cards.find(card => card.id === 'eval');
  const resolved = cards.find(card => card.id === 'done');
  const plain = cards.find(card => card.id === 'plain');
  assert.ok(evaluating?.choice);
  assert.equal(evaluating.title, '正在评估候选');
  assert.deepEqual(
    evaluating.choice.bars.map(bar => bar.name),
    ['A', 'B', 'C'],
  );
  assert.ok(evaluating.choice.bars.every(bar => bar.probabilityText === '未知' && bar.width === 0 && !bar.selected));
  assert.equal(evaluating.confidenceText, undefined);
  assert.ok(resolved?.choice);
  assert.equal(resolved.title, '走哪边');
  assert.deepEqual(
    resolved.choice.bars.map(bar => bar.name),
    ['B', 'C', 'A'],
  );
  assert.deepEqual(
    resolved.choice.bars.map(bar => bar.probabilityText),
    ['0.5', '0.4', '0.1'],
  );
  assert.deepEqual(
    resolved.choice.bars.map(bar => bar.width),
    [50, 40, 10],
  );
  assert.deepEqual(
    resolved.choice.bars.map(bar => bar.selected),
    [true, false, false],
  );
  assert.equal(resolved.confidenceText, '分布集中度 0.62（不是正确率）');
  assert.equal(resolved.modelText, '模型 jev-1');
  assert.equal(resolved.latencyText, '耗时 120毫秒');
  assert.equal(resolved.explanationText, '决策说明：因为桥 · 来源 模型');
  assert.ok(plain?.choice);
  assert.equal(plain.title, '没有分布');
  assert.ok(plain.choice.bars.every(bar => bar.probabilityText === '未知'));
  assert.equal(plain.choice.bars.find(bar => bar.name === 'A')?.selected, true);
});

test('score marks the legend and noul shows yes without confidence', () => {
  const run = play([
    event(
      1,
      'decision.resolved',
      {
        kind: 'score',
        question: '危险程度',
        score: 1,
        legend: {'0': '低', '1': '中', '2': '高'},
        probabilities: {'0': 0.2, '1': 0.5, '2': 0.3},
        confidence: 0.62,
      },
      decisionIds('score-1'),
    ),
    event(
      2,
      'decision.resolved',
      {kind: 'noul', question: '到了吗', noul: 0.86, confidence: 0.9},
      decisionIds('noul-1', 'noul-q'),
    ),
  ]);
  const score = decisionCards(run).find(card => card.id === 'score-1');
  const noul = decisionCards(run).find(card => card.id === 'noul-1');
  assert.ok(score?.score);
  assert.equal(score.score.scoreText, '1');
  assert.equal(score.score.position, 0.5);
  assert.equal(score.score.legend.find(tick => tick.active)?.label, '中');
  assert.deepEqual(
    score.score.probabilities?.map(item => `${item.name} ${item.text}`),
    ['1 0.5', '2 0.3', '0 0.2'],
  );
  assert.equal(score.confidenceText, '分布集中度 0.62（不是正确率）');
  assert.equal(score.choice, undefined);
  assert.equal(score.noul, undefined);
  assert.equal(decisionChain(run, 'score-1'), 'JEV 评分 1（中）');
  assert.ok(noul?.noul);
  assert.equal(noul.noul.yesText, '是 86%');
  assert.equal(noul.confidenceText, undefined);
  assert.equal(noul.score, undefined);
  assert.equal(noul.choice, undefined);
  assert.equal(JSON.stringify(noul).includes('分布集中度'), false);
  assert.equal(JSON.stringify(noul).includes('0.9'), false);
  assert.equal(decisionChain(run, 'noul-1'), 'JEV 判断 是 86%');
});

test('rule override chain keeps each present step and omits a model source', () => {
  const overridden = play([
    event(1, 'decision.started', {kind: 'choice', question: '走哪边', summary: '桥边'}, decisionIds('d1')),
    event(2, 'decision.resolved', {kind: 'choice', choice: 'A'}, decisionIds('d1')),
    event(
      3,
      'action.selected',
      {action: 'B', source: 'rule', rule: 'X', rule_source: 'Y'},
      {decision_id: 'd1', action_id: 'act', attempt_id: 't1'},
    ),
    event(4, 'action.completed', {}, {decision_id: 'd1', action_id: 'act', attempt_id: 't1'}),
    event(
      5,
      'verification.completed',
      {result: 'failed', checks: [{name: '到达', observed: '未到达', result: 'failed'}]},
      {decision_id: 'd1', action_id: 'act', attempt_id: 't1'},
    ),
  ]);
  const chain = 'JEV 选择 A → 规则覆盖为 B（规则 X · 来源 Y） → 实际执行 B → 验证：失败';
  assert.equal(decisionChain(overridden, 'd1'), chain);
  assert.equal(decisionCards(overridden).find(card => card.id === 'd1')?.chain, chain);
  assert.equal(decisionChain(overridden, 'missing'), '');

  const modeled = play([
    event(1, 'decision.resolved', {kind: 'choice', choice: 'A'}, decisionIds('d1')),
    event(
      2,
      'action.selected',
      {action: 'A', source: 'model'},
      {decision_id: 'd1', action_id: 'act', attempt_id: 't1'},
    ),
  ]);
  assert.equal(decisionChain(modeled, 'd1'), 'JEV 选择 A → 实际执行 A');

  const chosen = play([event(1, 'decision.resolved', {kind: 'choice', choice: 'A'}, decisionIds('d1'))]);
  assert.equal(decisionChain(chosen, 'd1'), 'JEV 选择 A');
});

test('a rule action without a decision is its own card', () => {
  const run = play([
    event(1, 'decision.resolved', {kind: 'choice', choice: 'A'}, decisionIds('d1')),
    event(
      2,
      'action.selected',
      {action: 'A', source: 'model'},
      {decision_id: 'd1', action_id: 'model-act', attempt_id: 't1'},
    ),
    event(
      3,
      'action.selected',
      {action: '停下', source: 'rule', rule: '安全', rule_source: '策略'},
      {action_id: 'rule-act', attempt_id: 't9'},
    ),
    event(
      4,
      'verification.completed',
      {result: 'passed', checks: [{name: '停稳', observed: '已停', result: 'passed'}]},
      {action_id: 'rule-act', attempt_id: 't9'},
    ),
  ]);
  const cards = decisionCards(run);
  const rule = cards.find(card => card.kind === 'rule');
  assert.ok(rule);
  assert.equal(rule.badge, '规则决策');
  assert.equal(rule.chain.includes('JEV'), false);
  assert.equal(rule.chain, '规则决策（规则 安全 · 来源 策略） → 实际执行 停下 → 验证：成功');
  assert.equal(cards.find(card => card.id === 'd1')?.chain, 'JEV 选择 A → 实际执行 A');
  assert.equal(
    cards.some(card => card.kind === 'decision' && card.chain.includes('停下')),
    false,
  );
});

test('attempts group by action and number retries in order', () => {
  const run = play([
    event(1, 'action.selected', {action: '跳', source: 'model'}, {action_id: 'act-1', attempt_id: 'a1'}),
    event(2, 'action.failed', {reason: 'timeout'}, {action_id: 'act-1', attempt_id: 'a1'}),
    event(3, 'action.selected', {action: '跳', source: 'model'}, {action_id: 'act-1', attempt_id: 'a2'}),
    event(4, 'action.completed', {}, {action_id: 'act-1', attempt_id: 'a2'}),
    event(
      5,
      'verification.completed',
      {result: 'passed', checks: [{name: '落地', observed: '稳', result: 'passed', evidence: '帧 12'}]},
      {action_id: 'act-1', attempt_id: 'a2'},
    ),
    event(6, 'action.selected', {action: '看', source: 'model'}, {action_id: 'act-2', attempt_id: 'b1'}),
    event(7, 'action.completed', {}, {action_id: 'act-2', attempt_id: 'b1'}),
  ]);
  const groups = attemptGroups(run);
  assert.deepEqual(
    groups.map(group => group.actionId),
    ['act-2', 'act-1'],
  );
  const retried = groups[1];
  assert.equal(retried.action, '跳');
  assert.deepEqual(
    retried.rows.map(row => [row.attemptNumber, row.attemptId, row.status, row.reason]),
    [
      [1, 'a1', 'failed', 'timeout'],
      [2, 'a2', 'passed', '未提供'],
    ],
  );
  assert.equal(retried.rows[0].statusText, '失败');
  assert.equal(retried.rows[1].checks[0].resultText, '通过');
  assert.equal(retried.rows[1].checks[0].evidence, '帧 12');
  assert.equal(groups[0].rows.length, 1);
  assert.equal(groups[0].rows[0].attemptNumber, 1);
  assert.equal(runSummary(run, Date.parse(at(30))).retries, 1);
});

test('run summary states the verification denominator, progress, and dropped count', () => {
  const started = '2026-01-01T00:00:00.000Z';
  const ended = '2026-01-01T00:01:05.000Z';
  const run = play([
    event(1, 'run.started', {name: '模拟：验收', simulated: true}, {occurred_at: started}),
    event(2, 'progress.updated', {phase: '过桥', completed: 2, total: 5}),
    event(3, 'action.completed', {}, {action_id: 'p1', attempt_id: 't'}),
    event(
      4,
      'verification.completed',
      {result: 'passed', checks: [{name: '甲', observed: '是', result: 'passed'}]},
      {action_id: 'p1', attempt_id: 't'},
    ),
    event(5, 'action.completed', {}, {action_id: 'p2', attempt_id: 't'}),
    event(
      6,
      'verification.completed',
      {result: 'passed', checks: [{name: '乙', observed: '是', result: 'passed'}]},
      {action_id: 'p2', attempt_id: 't'},
    ),
    event(7, 'action.completed', {}, {action_id: 'p3', attempt_id: 't'}),
    event(
      8,
      'verification.completed',
      {result: 'failed', checks: [{name: '丙', observed: '否', result: 'failed'}]},
      {action_id: 'p3', attempt_id: 't'},
    ),
    event(9, 'action.completed', {}, {action_id: 'p4', attempt_id: 't'}),
    event(10, 'telemetry.dropped', {count: 4}),
    event(11, 'run.completed', {}, {occurred_at: ended}),
  ]);
  const summary = runSummary(run, Date.parse('2026-01-01T00:10:00.000Z'));
  assert.equal(summary.verificationText, '验证成功 2 / 已验证 3；验证失败 1；未知 0；未验证 1');
  assert.equal(summary.passed, 2);
  assert.equal(summary.verified, 3);
  assert.equal(summary.unverified, 1);
  assert.equal(summary.progress, '2/5');
  assert.equal(summary.phase, '过桥');
  assert.equal(summary.duration, '1分05秒');
  assert.equal(summary.droppedText, '发送端丢弃 4');
  assert.equal(summary.retryText, '重试 0');
  assert.equal(summary.statusText, '任务结束');
  assert.equal(summary.tone, 'success');
  assert.equal(summary.anomalyText, '异常 0');
  assert.equal(summary.limitedText, undefined);
  assert.equal(summary.simulated, true);

  const stepsOnly = play([
    event(1, 'run.started', {name: '只计步'}, {occurred_at: started}),
    event(2, 'progress.updated', {completed: 3}),
  ]);
  const open = runSummary(stepsOnly, Date.parse('2026-01-01T00:00:10.000Z'));
  assert.equal(open.progress, '已完成 3 步');
  assert.equal(open.phase, '未知');
  assert.equal(open.duration, '10秒');

  const bare = play([event(1, 'run.started', {name: '空'}, {occurred_at: started})]);
  assert.equal(runSummary(bare, Date.parse(started)).progress, '未知');
});

test('timeline filter keeps failures, failed checks, drops, and later attempts', () => {
  const events = [
    event(1, 'heartbeat'),
    event(2, 'action.started', {}, {action_id: 'A', attempt_id: '1'}),
    event(3, 'action.completed', {}, {action_id: 'A', attempt_id: '1'}),
    event(4, 'action.started', {}, {action_id: 'A', attempt_id: '2'}),
    event(5, 'action.failed', {reason: 'timeout'}, {action_id: 'A', attempt_id: '2'}),
    event(
      6,
      'verification.completed',
      {result: 'failed', checks: [{name: '门', observed: '关', result: 'failed'}]},
      {action_id: 'B', attempt_id: '1'},
    ),
    event(7, 'telemetry.dropped', {count: 3}),
    event(8, 'decision.failed', {kind: 'choice', reason: '超时'}, decisionIds('d')),
    event(
      9,
      'verification.completed',
      {result: 'passed', checks: [{name: '门', observed: '开', result: 'passed'}]},
      {action_id: 'C', attempt_id: '1'},
    ),
    event(10, 'run.completed'),
    event(11, 'action.cancelled', {}, {action_id: 'D', attempt_id: '1'}),
  ];
  assert.deepEqual(
    timelineItems(events, 'errors').map(item => item.cursor),
    [4, 5, 6, 7, 8],
  );
  const all = timelineItems(events, 'all');
  assert.deepEqual(
    all.map(item => item.cursor),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  );
  assert.equal(all[0].typeText, '心跳');
  assert.ok(all.every(item => !item.late));
});

test('timeline marks events whose clocks differ by more than five seconds', () => {
  const items = timelineItems(
    [
      event(1, 'heartbeat', {}, {occurred_at: '2026-01-01T00:00:00.000Z', received_at: '2026-01-01T00:00:05.000Z'}),
      event(2, 'heartbeat', {}, {occurred_at: '2026-01-01T00:00:00.000Z', received_at: '2026-01-01T00:00:05.001Z'}),
      event(
        3,
        'progress.updated',
        {},
        {occurred_at: '2026-01-01T00:00:06.000Z', received_at: '2026-01-01T00:00:00.000Z'},
      ),
    ],
    'all',
  );
  assert.deepEqual(
    items.map(item => item.late),
    [false, true, true],
  );
  assert.equal(items[1].occurredText, formatClock(items[1].occurredAt));
  assert.equal(items[1].receivedText, formatClock(items[1].receivedAt));
  assert.equal(items[2].typeText, '进度更新');
});

test('decision cards stay in reverse time order and cap at 50', () => {
  const events = Array.from({length: 51}, (_value, index) => {
    const n = index + 1;
    return event(n, 'decision.started', {kind: 'choice', question: `问题 ${n}`}, decisionIds(`d${n}`, `q${n}`));
  });
  const cards = decisionCards(play(events));
  assert.equal(cards.length, 50);
  assert.equal(cards[0].id, 'd51');
  assert.equal(cards[49].id, 'd2');
  assert.equal(
    cards.some(card => card.id === 'd1'),
    false,
  );
});

import type {Payload, StoredEvent} from '../../protocol';
import {later, metrics, type Attempt, type Decision, type RunState} from '../../state';
import {
  NOT_PROVIDED,
  UNKNOWN,
  formatClock,
  formatDuration,
  statusText,
  statusTone,
  type StatusTone,
} from '../view-model/common';

export interface RunSummaryModel {
  name: string;
  simulated: boolean;
  status: string;
  statusText: string;
  tone: StatusTone;
  phase: string;
  progress: string;
  duration: string;
  retries: number;
  retryText: string;
  verificationText: string;
  passed: number;
  failed: number;
  unknown: number;
  unverified: number;
  verified: number;
  dropped: number;
  droppedText: string;
  anomalies: number;
  anomalyText: string;
  limited: boolean;
  limitedText?: string;
}

export interface ChoiceBar {
  name: string;
  description?: string;
  probability?: number;
  probabilityText: string;
  width: number;
  selected: boolean;
}

export interface ScoreTick {
  key: string;
  label: string;
  active: boolean;
}

export interface ScoreProbability {
  name: string;
  probability: number;
  text: string;
}

export interface ScoreView {
  scoreText: string;
  legend: ScoreTick[];
  position?: number;
  probabilities?: ScoreProbability[];
}

export interface NoulView {
  yesText: string;
  probability?: number;
}

export interface DecisionCardModel {
  id: string;
  kind: 'decision' | 'rule';
  badge: string;
  title: string;
  question: string;
  summary: string;
  evaluating: boolean;
  statusText: string;
  tone: StatusTone;
  choice?: {bars: ChoiceBar[]};
  score?: ScoreView;
  noul?: NoulView;
  confidenceText?: string;
  modelText: string;
  latencyText: string;
  explanationText: string;
  chain: string;
  ruleText?: string;
}

export interface CheckRow {
  name: string;
  observed: string;
  result: string;
  resultText: string;
  evidence: string;
}

export interface AttemptRowModel {
  key: string;
  actionId: string;
  attemptId: string;
  attemptNumber: number;
  status: string;
  statusText: string;
  tone: StatusTone;
  reason: string;
  checks: CheckRow[];
}

export interface AttemptGroupModel {
  actionId: string;
  action: string;
  rows: AttemptRowModel[];
}

export type TimelineFilter = 'all' | 'errors';

export interface TimelineItemModel {
  cursor: number;
  type: string;
  typeText: string;
  occurredAt: string;
  receivedAt: string;
  occurredText: string;
  receivedText: string;
  late: boolean;
  event: StoredEvent;
}

const typeText: Record<string, string> = {
  'run.started': '任务开始',
  'run.completed': '任务结束',
  'run.failed': '任务失败',
  'run.cancelled': '任务取消',
  'decision.started': '开始决策',
  'decision.resolved': '决策完成',
  'decision.failed': '决策失败',
  'action.selected': '选定动作',
  'action.started': '开始执行',
  'action.completed': '执行完成',
  'action.failed': '执行失败',
  'action.cancelled': '执行取消',
  'verification.completed': '验证完成',
  'progress.updated': '进度更新',
  heartbeat: '心跳',
  'telemetry.dropped': '发送端丢弃',
};

function formatRatio(value: number): string {
  if (!Number.isFinite(value)) return UNKNOWN;
  return String(Math.round(value * 1000) / 1000);
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return UNKNOWN;
  const rounded = Math.round(value * 1000) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${text}%`;
}

function clampPercent(probability: number): number {
  if (!Number.isFinite(probability)) return 0;
  return Math.min(100, Math.max(0, probability * 100));
}

function progressText(progress?: Payload): string {
  if (!progress) return UNKNOWN;
  if (progress.total !== undefined) return `${progress.completed ?? 0}/${progress.total}`;
  if (progress.completed !== undefined) return `已完成 ${progress.completed} 步`;
  return UNKNOWN;
}

function durationText(run: RunState, now: number): string {
  if (!run.started_at) return UNKNOWN;
  const start = Date.parse(run.started_at);
  if (!Number.isFinite(start)) return UNKNOWN;
  const end = run.ended_at ? Date.parse(run.ended_at) : now;
  if (!Number.isFinite(end)) return UNKNOWN;
  return formatDuration(end - start);
}

export function runSummary(run: RunState, now: number): RunSummaryModel {
  const counts = metrics(run);
  const verified = counts.passed + counts.failed + counts.unknown;
  return {
    name: run.name,
    simulated: run.simulated,
    status: run.status,
    statusText: statusText(run.status),
    tone: statusTone(run.status),
    phase: run.progress?.phase || UNKNOWN,
    progress: progressText(run.progress),
    duration: durationText(run, now),
    retries: counts.retries,
    retryText: `重试 ${counts.retries}`,
    verificationText: `验证成功 ${counts.passed} / 已验证 ${verified}；验证失败 ${counts.failed}；未知 ${counts.unknown}；未验证 ${counts.unverified}`,
    passed: counts.passed,
    failed: counts.failed,
    unknown: counts.unknown,
    unverified: counts.unverified,
    verified,
    dropped: run.dropped,
    droppedText: `发送端丢弃 ${run.dropped}`,
    anomalies: run.anomalies,
    anomalyText: `异常 ${run.anomalies}`,
    limited: run.limited,
    limitedText: run.limited ? '部分历史已截断' : undefined,
  };
}

function eventsOf(attempt: Attempt): StoredEvent[] {
  return [attempt.selected, attempt.started, attempt.terminal, attempt.verification].filter(
    (event): event is StoredEvent => Boolean(event),
  );
}

function newestEvent(attempt: Attempt): StoredEvent | undefined {
  return eventsOf(attempt).reduce<StoredEvent | undefined>(
    (best, event) => (!best || later(event, best) ? event : best),
    undefined,
  );
}

function oldestEvent(attempt: Attempt): StoredEvent | undefined {
  return eventsOf(attempt).reduce<StoredEvent | undefined>((best, event) => {
    if (!best) return event;
    return later(event, best) ? best : event;
  }, undefined);
}

function compareNewest(a?: StoredEvent, b?: StoredEvent): number {
  if (a && b) {
    if (later(a, b)) return -1;
    if (later(b, a)) return 1;
    return b.cursor - a.cursor;
  }
  if (a) return -1;
  if (b) return 1;
  return 0;
}

function verificationLink(attempt: Attempt | undefined): string | undefined {
  const result = attempt?.verification?.payload.result;
  if (!attempt?.verification) return undefined;
  if (result === 'failed') return '验证：失败';
  if (result === 'passed') return '验证：成功';
  return '验证：未知';
}

function sameChoice(attempt: Attempt | undefined, decision: Decision): boolean {
  const action = attempt?.selected?.payload.action;
  const resolved = decision.resolved?.payload;
  return Boolean(action && resolved?.kind === 'choice' && resolved.choice !== undefined && action === resolved.choice);
}

function overrideLink(attempt: Attempt | undefined, decision: Decision): string | undefined {
  const payload = attempt?.selected?.payload;
  if (!payload?.action || sameChoice(attempt, decision)) return undefined;
  if (payload.source === 'rule') {
    const rule = payload.rule || NOT_PROVIDED;
    const ruleSource = payload.rule_source || NOT_PROVIDED;
    return `规则覆盖为 ${payload.action}（规则 ${rule} · 来源 ${ruleSource}）`;
  }
  // Application reselection is not a rule; do not invent a rule name or source.
  const resolved = decision.resolved?.payload;
  if (payload.source === 'application' && resolved?.kind === 'choice' && resolved.choice !== undefined)
    return `应用覆盖为 ${payload.action}`;
  return undefined;
}

function executionLink(attempt: Attempt | undefined): string | undefined {
  if (!attempt) return undefined;
  const action = attempt.selected?.payload.action;
  const text = (label: string) => (action ? `${label} ${action}` : label);
  // Once verification arrives, "pending verification" is stale; the verification link carries the result.
  if (attempt.terminal?.type === 'action.completed') return text(attempt.verification ? '已执行' : '已执行待验证');
  if (attempt.terminal?.type === 'action.failed') return text('执行失败');
  if (attempt.terminal?.type === 'action.cancelled') return text('执行取消');
  // Verification without a terminal event: the execution step is missing, so omit it instead of calling it pending.
  if (attempt.verification) return undefined;
  if (attempt.started) return text('执行中');
  if (attempt.selected) return text('应用选择/待执行');
  return undefined;
}

function jevLink(decision: Decision): string | undefined {
  const payload = decision.resolved?.payload;
  if (!payload) return undefined;
  if (payload.kind === 'choice' && payload.choice) return `JEV 选择 ${payload.choice}`;
  if (payload.kind === 'score' && payload.score !== undefined) {
    const label = payload.legend?.[String(payload.score)];
    return label ? `JEV 评分 ${payload.score}（${label}）` : `JEV 评分 ${payload.score}`;
  }
  if (payload.kind === 'noul' && payload.noul !== undefined) return `JEV 判断 是 ${formatPercent(payload.noul)}`;
  return undefined;
}

function attemptsFor(run: RunState, decisionId: string): Attempt[] {
  return Object.values(run.attempts).filter(attempt => attempt.decision_id === decisionId);
}

function latestAttempt(attempts: Attempt[]): Attempt | undefined {
  return attempts.reduce<Attempt | undefined>((best, attempt) => {
    if (!best) return attempt;
    const event = newestEvent(attempt);
    const bestEvent = newestEvent(best);
    if (event && (!bestEvent || later(event, bestEvent))) return attempt;
    return best;
  }, undefined);
}

export function decisionChain(run: RunState, decisionId: string): string {
  const decision = run.decisions[decisionId];
  if (!decision) return '';
  const parts: string[] = [];
  const chosen = jevLink(decision);
  if (chosen) parts.push(chosen);
  const attempt = latestAttempt(attemptsFor(run, decisionId));
  const override = overrideLink(attempt, decision);
  if (override) parts.push(override);
  const execution = executionLink(attempt);
  if (execution) parts.push(execution);
  const verification = verificationLink(attempt);
  if (verification) parts.push(verification);
  return parts.join(' → ');
}

function textOrMissing(value: string | undefined): string {
  return value ? value : NOT_PROVIDED;
}

function choiceView(payload: Payload, evaluating: boolean): {bars: ChoiceBar[]} {
  const names = new Set<string>([
    ...Object.keys(payload.candidates ?? {}),
    ...Object.keys(payload.probabilities ?? {}),
  ]);
  if (payload.choice) names.add(payload.choice);
  const showProbability = !evaluating && payload.probabilities !== undefined;
  const bars = [...names].map(name => {
    const probability = showProbability ? payload.probabilities?.[name] : undefined;
    const known = probability !== undefined;
    const description = payload.candidates?.[name];
    return {
      name,
      description: typeof description === 'string' && description ? description : undefined,
      probability: known ? probability : undefined,
      probabilityText: known ? formatRatio(probability) : UNKNOWN,
      width: known ? clampPercent(probability) : 0,
      selected: !evaluating && payload.choice === name,
    };
  });
  bars.sort((left, right) => {
    if (!showProbability) return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
    const leftProbability = left.probability ?? -1;
    const rightProbability = right.probability ?? -1;
    if (leftProbability !== rightProbability) return rightProbability - leftProbability;
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  });
  return {bars};
}

function scoreView(payload: Payload, evaluating: boolean): ScoreView {
  const score = evaluating ? undefined : payload.score;
  const legend = Object.entries(payload.legend ?? {})
    .map(([key, label]) => ({
      key,
      label,
      active: score !== undefined && (key === String(score) || (Number.isFinite(Number(key)) && Number(key) === score)),
    }))
    .sort((left, right) => {
      const leftValue = Number(left.key);
      const rightValue = Number(right.key);
      const leftOk = Number.isFinite(leftValue);
      const rightOk = Number.isFinite(rightValue);
      if (leftOk && rightOk && leftValue !== rightValue) return leftValue - rightValue;
      if (leftOk !== rightOk) return leftOk ? -1 : 1;
      return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
    });
  const numeric = legend.map(tick => Number(tick.key)).filter(value => Number.isFinite(value));
  let position: number | undefined;
  if (score !== undefined && numeric.length >= 2) {
    const min = numeric[0];
    const max = numeric[numeric.length - 1];
    position = max === min ? 0 : Math.min(1, Math.max(0, (score - min) / (max - min)));
  }
  const probabilities =
    !evaluating && payload.probabilities
      ? Object.entries(payload.probabilities)
          .map(([name, probability]) => ({name, probability, text: formatRatio(probability)}))
          .sort((left, right) => right.probability - left.probability || (left.name < right.name ? -1 : 1))
      : undefined;
  return {
    scoreText: score === undefined ? UNKNOWN : String(score),
    legend,
    position,
    probabilities,
  };
}

function noulView(payload: Payload, evaluating: boolean): NoulView {
  if (evaluating || payload.noul === undefined || !Number.isFinite(payload.noul)) return {yesText: '是 未知'};
  return {yesText: `是 ${formatPercent(payload.noul)}`, probability: payload.noul};
}

function confidenceLine(payload: Payload, kind: Payload['kind']): string | undefined {
  if (kind === 'noul' || payload.confidence === undefined) return undefined;
  return `分布集中度 ${formatRatio(payload.confidence)}（不是正确率）`;
}

function primitiveBadge(kind: Payload['kind']): string {
  if (kind === 'choice') return 'Choice';
  if (kind === 'score') return 'Score';
  if (kind === 'noul') return 'Noul';
  return UNKNOWN;
}

function decisionCard(run: RunState, decision: Decision): DecisionCardModel {
  const payload = decision.payload;
  const kind = payload.kind ?? decision.started?.payload.kind;
  const evaluating = decision.status === 'evaluating';
  const question = textOrMissing(payload.question ?? decision.started?.payload.question);
  return {
    id: decision.id,
    kind: 'decision',
    badge: primitiveBadge(kind),
    title: evaluating && kind === 'choice' ? '正在评估候选' : question,
    question,
    summary: textOrMissing(payload.summary),
    evaluating,
    statusText: statusText(decision.status),
    tone: statusTone(decision.status),
    choice: kind === 'choice' ? choiceView(payload, evaluating) : undefined,
    score: kind === 'score' ? scoreView(payload, evaluating) : undefined,
    noul: kind === 'noul' ? noulView(payload, evaluating) : undefined,
    confidenceText: confidenceLine(payload, kind),
    modelText: `模型 ${textOrMissing(payload.model)}`,
    latencyText: payload.latency_ms !== undefined ? `耗时 ${payload.latency_ms}毫秒` : `耗时 ${NOT_PROVIDED}`,
    explanationText: payload.explanation
      ? `决策说明：${payload.explanation} · 来源 ${textOrMissing(payload.explanation_source)}`
      : `决策说明：${NOT_PROVIDED}`,
    chain: decisionChain(run, decision.id),
  };
}

function directRule(attempt: Attempt): boolean {
  const selected = attempt.selected;
  if (!selected || selected.decision_id || attempt.decision_id) return false;
  return selected.payload.source === 'rule';
}

function ruleCard(attempt: Attempt): DecisionCardModel {
  const payload = attempt.selected?.payload ?? {};
  const rule = payload.rule || NOT_PROVIDED;
  const ruleSource = payload.rule_source || NOT_PROVIDED;
  const action = payload.action || attempt.action_id;
  const parts = [`规则决策（规则 ${rule} · 来源 ${ruleSource}）`];
  const execution = executionLink(attempt);
  if (execution) parts.push(execution);
  const verification = verificationLink(attempt);
  if (verification) parts.push(verification);
  return {
    id: `rule:${attempt.action_id}:${attempt.id}`,
    kind: 'rule',
    badge: '规则决策',
    title: action,
    question: action,
    summary: textOrMissing(payload.reason),
    evaluating: false,
    statusText: statusText(attempt.status),
    tone: statusTone(attempt.status),
    modelText: `模型 ${NOT_PROVIDED}`,
    latencyText: `耗时 ${NOT_PROVIDED}`,
    explanationText: `决策说明：${NOT_PROVIDED}`,
    chain: parts.join(' → '),
    ruleText: `规则 ${rule} · 来源 ${ruleSource}`,
  };
}

function newestDecisionEvent(decision: Decision): StoredEvent | undefined {
  return [decision.started, decision.resolved, decision.failed]
    .filter((event): event is StoredEvent => Boolean(event))
    .reduce<StoredEvent | undefined>((best, event) => (!best || later(event, best) ? event : best), undefined);
}

export function decisionCards(run: RunState): DecisionCardModel[] {
  const cards: {event?: StoredEvent; card: DecisionCardModel}[] = [];
  for (const decision of Object.values(run.decisions)) {
    cards.push({event: newestDecisionEvent(decision), card: decisionCard(run, decision)});
  }
  for (const attempt of Object.values(run.attempts)) {
    if (!directRule(attempt)) continue;
    cards.push({event: attempt.selected, card: ruleCard(attempt)});
  }
  cards.sort((left, right) => compareNewest(left.event, right.event));
  return cards.slice(0, 50).map(item => item.card);
}

function attemptReason(attempt: Attempt): string {
  return (
    attempt.terminal?.payload.reason ||
    attempt.verification?.payload.reason ||
    attempt.selected?.payload.reason ||
    NOT_PROVIDED
  );
}

function checkRows(attempt: Attempt): CheckRow[] {
  return (attempt.verification?.payload.checks ?? []).map(check => ({
    name: check.name,
    observed: check.observed,
    result: check.result,
    resultText: check.result === 'passed' ? '通过' : check.result === 'failed' ? '失败' : UNKNOWN,
    evidence: check.evidence || NOT_PROVIDED,
  }));
}

function byOldest(left: Attempt, right: Attempt): number {
  const leftEvent = oldestEvent(left);
  const rightEvent = oldestEvent(right);
  if (leftEvent && rightEvent) {
    if (later(leftEvent, rightEvent)) return 1;
    if (later(rightEvent, leftEvent)) return -1;
    return leftEvent.cursor - rightEvent.cursor;
  }
  if (leftEvent) return -1;
  if (rightEvent) return 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export function attemptGroups(run: RunState): AttemptGroupModel[] {
  const grouped = new Map<string, Attempt[]>();
  for (const attempt of Object.values(run.attempts)) {
    const list = grouped.get(attempt.action_id) ?? [];
    list.push(attempt);
    grouped.set(attempt.action_id, list);
  }
  const groups = [...grouped.entries()].map(([actionId, attempts]) => {
    const ordered = [...attempts].sort(byOldest);
    const rows = ordered.map((attempt, index) => ({
      key: `${attempt.action_id}:${attempt.id}`,
      actionId: attempt.action_id,
      attemptId: attempt.id,
      attemptNumber: index + 1,
      status: attempt.status,
      statusText: statusText(attempt.status),
      tone: statusTone(attempt.status),
      reason: attemptReason(attempt),
      checks: checkRows(attempt),
    }));
    const newest = [...ordered].sort((left, right) => compareNewest(newestEvent(left), newestEvent(right)))[0];
    const action = ordered.map(attempt => attempt.selected?.payload.action).find(Boolean) ?? actionId;
    return {actionId, action, rows, newest: newest ? newestEvent(newest) : undefined};
  });
  groups.sort((left, right) => compareNewest(left.newest, right.newest));
  return groups.map(({actionId, action, rows}) => ({actionId, action, rows}));
}

function attemptKey(actionId: string, attemptId: string): string {
  return `${actionId}\0${attemptId}`;
}

/** Attempts after the first one for each action, using the run's full attempt history. */
export function laterAttemptKeys(run: RunState): Set<string> {
  const grouped = new Map<string, Attempt[]>();
  for (const attempt of Object.values(run.attempts)) {
    const list = grouped.get(attempt.action_id) ?? [];
    list.push(attempt);
    grouped.set(attempt.action_id, list);
  }
  const keys = new Set<string>();
  for (const [actionId, attempts] of grouped) {
    const ordered = [...attempts].sort(byOldest);
    for (const attempt of ordered.slice(1)) keys.add(attemptKey(actionId, attempt.id));
  }
  return keys;
}

function retryKeys(events: readonly StoredEvent[]): Set<string> {
  const first = new Map<string, string>();
  const keys = new Set<string>();
  const ordered = [...events].sort((left, right) => left.cursor - right.cursor);
  for (const event of ordered) {
    if (!event.action_id || !event.attempt_id) continue;
    const seen = first.get(event.action_id);
    if (!seen) {
      first.set(event.action_id, event.attempt_id);
      continue;
    }
    if (seen !== event.attempt_id) keys.add(attemptKey(event.action_id, event.attempt_id));
  }
  return keys;
}

function isErrorOrRetry(event: StoredEvent, retries: ReadonlySet<string>): boolean {
  if (event.type.endsWith('.failed')) return true;
  if (event.type === 'verification.completed' && event.payload.result === 'failed') return true;
  if (event.type === 'telemetry.dropped') return true;
  return Boolean(event.action_id && event.attempt_id && retries.has(attemptKey(event.action_id, event.attempt_id)));
}

function isLate(event: StoredEvent): boolean {
  const occurred = Date.parse(event.occurred_at);
  const received = Date.parse(event.received_at);
  if (!Number.isFinite(occurred) || !Number.isFinite(received)) return false;
  return Math.abs(received - occurred) > 5000;
}

/** At most `limit` rows ending at `endCursor`. A null anchor keeps the newest rows. */
export function timelineWindow<T extends {cursor: number}>(
  items: readonly T[],
  endCursor: number | null,
  limit: number,
): T[] {
  if (limit <= 0 || items.length === 0) return [];
  if (endCursor === null) return items.slice(-limit);
  let end = items.length - 1;
  while (end >= 0 && items[end].cursor > endCursor) end--;
  if (end < 0) return items.slice(0, Math.min(limit, items.length));
  const start = Math.max(0, end + 1 - limit);
  return items.slice(start, end + 1);
}

export function timelineItems(
  events: readonly StoredEvent[],
  filter: TimelineFilter,
  retryKeysFromRun?: ReadonlySet<string>,
): TimelineItemModel[] {
  const retries = filter === 'errors' ? (retryKeysFromRun ?? retryKeys(events)) : undefined;
  return [...events]
    .filter(event => !retries || isErrorOrRetry(event, retries))
    .sort((left, right) => left.cursor - right.cursor)
    .map(event => ({
      cursor: event.cursor,
      type: event.type,
      typeText: typeText[event.type] ?? event.type,
      occurredAt: event.occurred_at,
      receivedAt: event.received_at,
      occurredText: formatClock(event.occurred_at),
      receivedText: formatClock(event.received_at),
      late: isLate(event),
      event,
    }));
}

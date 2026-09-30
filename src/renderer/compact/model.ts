import type {ReceiverStatus, Snapshot} from '../../ipc';
import type {StoredEvent} from '../../protocol';
import {later, type Attempt, type Decision, type RunState} from '../../state';
import {
  UNKNOWN,
  connectionState,
  formatClock,
  formatDuration,
  pickDefaultRun,
  statusText,
  statusTone,
  truncate,
  type ConnectionKind,
  type StatusTone,
} from '../view-model/common';

const sourceLabels: Record<string, string> = {model: '模型', rule: '规则', application: '应用'};

export interface CompactModel {
  hasRun: boolean;
  waiting: string;
  receiver: string;
  name: string;
  nameFull: string;
  simulated: boolean;
  runStatus: string;
  runTone: StatusTone;
  connectionText: string;
  connectionKind: ConnectionKind | 'none';
  connectionTone: StatusTone;
  phase: string;
  progress: string;
  duration: string;
  choice: string;
  action: string;
  actionSource: string;
  overridden: boolean;
  actionText: string;
  execStatus: string;
  execTone: StatusTone;
  eventTime: string;
  eventType: string;
  otherRunning: number;
  nextRunId?: string;
  notes: string[];
  storageError?: string;
}

function newest(events: Array<StoredEvent | undefined>): StoredEvent | undefined {
  let best: StoredEvent | undefined;
  for (const event of events) {
    if (event && later(event, best)) best = event;
  }
  return best;
}

function latestDecision(run: RunState): Decision | undefined {
  let best: Decision | undefined;
  let bestEvent: StoredEvent | undefined;
  for (const decision of Object.values(run.decisions)) {
    const event = newest([decision.failed, decision.resolved, decision.started]);
    if (event && later(event, bestEvent)) {
      best = decision;
      bestEvent = event;
    }
  }
  return best;
}

function latestAttempt(run: RunState): Attempt | undefined {
  let best: Attempt | undefined;
  let bestEvent: StoredEvent | undefined;
  for (const attempt of Object.values(run.attempts)) {
    const event = newest([attempt.verification, attempt.terminal, attempt.started, attempt.selected]);
    if (event && later(event, bestEvent)) {
      best = attempt;
      bestEvent = event;
    }
  }
  return best;
}

function legendName(legend: Record<string, string>, score: number): string | undefined {
  const exact = legend[String(score)];
  if (exact) return exact;
  const rounded = legend[String(Math.round(score))];
  if (rounded) return rounded;
  const keys = Object.keys(legend)
    .map(key => Number(key))
    .filter(key => Number.isFinite(key));
  if (keys.length === 0) return undefined;
  let nearest = keys[0];
  for (const key of keys) {
    if (Math.abs(key - score) < Math.abs(nearest - score)) nearest = key;
  }
  return legend[String(nearest)];
}

function choiceText(decision: Decision | undefined): string {
  if (!decision) return UNKNOWN;
  if (decision.status === 'evaluating') return '正在评估候选';
  if (decision.status === 'failed') return statusText('failed');
  const payload = decision.payload;
  if (payload.kind === 'choice') return payload.choice ?? UNKNOWN;
  if (payload.kind === 'score') {
    if (payload.score === undefined) return UNKNOWN;
    const grade = payload.legend ? legendName(payload.legend, payload.score) : undefined;
    return grade ? `${payload.score} ${grade}` : String(payload.score);
  }
  if (payload.kind === 'noul') {
    if (payload.noul === undefined) return UNKNOWN;
    return `是 ${Math.round(payload.noul * 100)}%`;
  }
  return UNKNOWN;
}

function progressText(progress: {completed?: number; total?: number} | undefined): string {
  if (!progress) return UNKNOWN;
  if (progress.total !== undefined) return `${progress.completed ?? 0}/${progress.total}`;
  if (progress.completed !== undefined) return `已完成 ${progress.completed} 步`;
  return UNKNOWN;
}

function durationText(run: {started_at?: string; ended_at?: string}, now: number): string {
  if (!run.started_at) return UNKNOWN;
  const start = Date.parse(run.started_at);
  const end = run.ended_at ? Date.parse(run.ended_at) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return UNKNOWN;
  return formatDuration(end - start);
}

function receiverText(status: ReceiverStatus | undefined): string {
  if (!status) return '未连接';
  if (!status.listening) return '未监听';
  return status.url ? `监听中 · ${status.url}` : '监听中';
}

function toneForConnection(kind: ConnectionKind | 'none'): StatusTone {
  if (kind === 'live') return 'success';
  if (kind === 'quiet') return 'warning';
  if (kind === 'stale') return 'danger';
  return 'neutral';
}

function followingRunId(snapshot: Snapshot | undefined, currentId: string | undefined): string | undefined {
  const running = (snapshot?.runs ?? []).filter(run => !run.ended_at);
  if (running.length === 0) return undefined;
  const index = running.findIndex(run => run.id === currentId);
  if (index < 0) return running[0]?.id;
  const next = running[(index + 1) % running.length];
  return next && next.id !== currentId ? next.id : undefined;
}

function loadingModel(
  status: ReceiverStatus | undefined,
  snapshot: Snapshot | undefined,
  selectedRunId: string,
): CompactModel {
  const model = emptyModel(status);
  const others = (snapshot?.runs ?? []).filter(item => item.id !== selectedRunId && !item.ended_at);
  return {
    ...model,
    hasRun: true,
    name: '正在读取',
    nameFull: '正在读取',
    runStatus: '正在读取',
    connectionText: UNKNOWN,
    connectionKind: 'none',
    connectionTone: 'neutral',
    otherRunning: others.length,
    nextRunId: others.length > 0 ? followingRunId(snapshot, selectedRunId) : undefined,
  };
}

function emptyModel(status: ReceiverStatus | undefined): CompactModel {
  const receiver = receiverText(status);
  return {
    hasRun: false,
    waiting: '等待宿主连接…',
    receiver,
    name: '等待宿主连接…',
    nameFull: '等待宿主连接…',
    simulated: false,
    runStatus: '等待',
    runTone: 'neutral',
    connectionText: receiver,
    connectionKind: 'none',
    connectionTone: 'neutral',
    phase: UNKNOWN,
    progress: UNKNOWN,
    duration: UNKNOWN,
    choice: UNKNOWN,
    action: UNKNOWN,
    actionSource: '',
    overridden: false,
    actionText: UNKNOWN,
    execStatus: UNKNOWN,
    execTone: 'neutral',
    eventTime: UNKNOWN,
    eventType: UNKNOWN,
    otherRunning: 0,
    notes: status?.platform.notes ?? [],
    storageError: status?.storageError,
  };
}

export function compactModel(
  snapshot: Snapshot | undefined,
  status: ReceiverStatus | undefined,
  now: number,
  selectedRunId?: string,
): CompactModel {
  const loaded = snapshot?.run;
  const full = loaded && (selectedRunId === undefined || loaded.id === selectedRunId) ? loaded : undefined;
  const summary = selectedRunId ? snapshot?.runs.find(item => item.id === selectedRunId) : undefined;
  const run = full ?? summary ?? (selectedRunId === undefined ? pickDefaultRun(snapshot?.runs ?? []) : undefined);
  if (!run) return selectedRunId ? loadingModel(status, snapshot, selectedRunId) : emptyModel(status);

  const connection = connectionState(run, now);
  const decision = full ? latestDecision(full) : undefined;
  const attempt = full ? latestAttempt(full) : undefined;
  const action = attempt?.selected?.payload.action;
  const actionSource = sourceLabels[attempt?.selected?.payload.source ?? ''] ?? '';
  const linked = attempt?.decision_id ? full?.decisions[attempt.decision_id] : undefined;
  const linkedChoice = linked?.payload.kind === 'choice' ? linked.payload.choice : undefined;
  const overridden = Boolean(action && linkedChoice !== undefined && action !== linkedChoice);
  const actionParts: string[] = [];
  if (action) {
    actionParts.push(action);
    if (actionSource) actionParts.push(actionSource);
    if (overridden) actionParts.push('已覆盖');
  }
  const others = (snapshot?.runs ?? []).filter(item => item.id !== run.id && !item.ended_at);
  const latest = run.latest;

  return {
    hasRun: true,
    waiting: '等待宿主连接…',
    receiver: receiverText(status),
    name: truncate(run.name, 40),
    nameFull: run.name,
    simulated: run.simulated === true,
    runStatus: statusText(run.status),
    runTone: statusTone(run.status),
    connectionText: connection.text,
    connectionKind: connection.kind,
    connectionTone: toneForConnection(connection.kind),
    phase: run.progress?.phase || UNKNOWN,
    progress: progressText(run.progress),
    duration: durationText(run, now),
    choice: choiceText(decision),
    action: action ?? UNKNOWN,
    actionSource,
    overridden,
    actionText: actionParts.length > 0 ? actionParts.join(' · ') : UNKNOWN,
    execStatus: attempt ? statusText(attempt.status) : UNKNOWN,
    execTone: attempt ? statusTone(attempt.status) : 'neutral',
    eventTime: latest ? formatClock(latest.occurred_at) : UNKNOWN,
    eventType: latest?.type ?? UNKNOWN,
    otherRunning: others.length,
    nextRunId: others.length > 0 ? followingRunId(snapshot, run.id) : undefined,
    notes: status?.platform.notes ?? [],
    storageError: status?.storageError,
  };
}

import type {StoredEvent, Payload} from './protocol';
export const labels: Record<string, string> = {
  waiting: '等待',
  evaluating: '评估中',
  selected: '已选择',
  executing: '执行中',
  unverified: '已执行待验证',
  passed: '验证成功',
  failed: '失败',
  verification_failed: '验证失败',
  cancelled: '取消',
  unknown: '未知',
  completed: '任务结束',
};
export interface Decision {
  id: string;
  request_id?: string;
  question_id?: string;
  status: string;
  started?: StoredEvent;
  resolved?: StoredEvent;
  failed?: StoredEvent;
  payload: Payload;
}
export interface Attempt {
  id: string;
  action_id: string;
  decision_id?: string;
  status: string;
  selected?: StoredEvent;
  started?: StoredEvent;
  terminal?: StoredEvent;
  verification?: StoredEvent;
}
export interface RunState {
  id: string;
  name: string;
  simulated: boolean;
  status: string;
  started_at?: string;
  ended_at?: string;
  latest?: StoredEvent;
  last_received?: string;
  progress?: Payload;
  decisions: Record<string, Decision>;
  attempts: Record<string, Attempt>;
  dropped: number;
  anomalies: number;
  event_count: number;
  limited: boolean;
}
const dict = <T>() => Object.create(null) as Record<string, T>;
export function emptyRun(id: string): RunState {
  return {
    id,
    name: id,
    simulated: false,
    status: 'waiting',
    decisions: dict(),
    attempts: dict(),
    dropped: 0,
    anomalies: 0,
    event_count: 0,
    limited: false,
  };
}
export function later(a: StoredEvent, b?: StoredEvent): boolean {
  if (!b) return true;
  if (a.producer_id === b.producer_id) return a.sequence > b.sequence;
  return (
    Date.parse(a.occurred_at) > Date.parse(b.occurred_at) ||
    (a.occurred_at === b.occurred_at && a.event_id > b.event_id)
  );
}
function bound<T>(map: Record<string, T>, run: RunState) {
  const keys = Object.keys(map);
  if (keys.length > 500) {
    delete map[keys[0]];
    run.limited = true;
  }
}
export function applyEvent(r: RunState, e: StoredEvent) {
  r.event_count++;
  r.last_received = e.received_at;
  const current = later(e, r.latest);
  if (current && e.type !== 'heartbeat' && e.type !== 'telemetry.dropped') r.latest = e;
  if (e.type === 'run.started') {
    r.name = e.payload.name ?? r.name;
    r.simulated = e.payload.simulated ?? false;
    r.started_at ??= e.occurred_at;
  }
  if (['run.completed', 'run.failed', 'run.cancelled'].includes(e.type)) {
    if (!r.ended_at || Date.parse(e.occurred_at) > Date.parse(r.ended_at)) {
      r.ended_at = e.occurred_at;
      r.status = e.type.split('.')[1];
    }
  }
  if (e.type === 'progress.updated' && current) r.progress = e.payload;
  if (e.type === 'telemetry.dropped') r.dropped += e.payload.count ?? 0;
  if (e.type.startsWith('decision.') && e.decision_id) {
    const d = (r.decisions[e.decision_id] ??= {
      id: e.decision_id,
      request_id: e.request_id,
      question_id: e.question_id,
      status: 'unknown',
      payload: {},
    });
    if (d.request_id !== e.request_id || d.question_id !== e.question_id) {
      r.anomalies++;
      return;
    }
    if (e.type === 'decision.started' && later(e, d.started)) d.started = e;
    if (e.type === 'decision.resolved' && later(e, d.resolved)) d.resolved = e;
    if (e.type === 'decision.failed' && later(e, d.failed)) d.failed = e;
    const terminal = d.failed && later(d.failed, d.resolved) ? d.failed : d.resolved;
    d.status = terminal ? (terminal.type === 'decision.resolved' ? 'selected' : 'failed') : 'evaluating';
    d.payload = {...d.started?.payload, ...terminal?.payload};
    bound(r.decisions, r);
    if (!r.ended_at && current) r.status = d.status;
  }
  if (e.action_id && e.attempt_id) {
    const key = JSON.stringify([e.action_id, e.attempt_id]);
    const a = (r.attempts[key] ??= {
      id: e.attempt_id,
      action_id: e.action_id,
      decision_id: e.decision_id,
      status: 'unknown',
    });
    if (a.decision_id && e.decision_id && a.decision_id !== e.decision_id) {
      r.anomalies++;
      return;
    }
    a.decision_id ??= e.decision_id;
    if (e.type === 'action.selected' && later(e, a.selected)) a.selected = e;
    if (e.type === 'action.started' && later(e, a.started)) a.started = e;
    if (['action.completed', 'action.failed', 'action.cancelled'].includes(e.type) && later(e, a.terminal))
      a.terminal = e;
    if (e.type === 'verification.completed' && later(e, a.verification)) a.verification = e;
    a.status =
      a.terminal?.type === 'action.failed'
        ? 'failed'
        : a.terminal?.type === 'action.cancelled'
          ? 'cancelled'
          : a.verification
            ? a.verification.payload.result === 'failed'
              ? 'verification_failed'
              : (a.verification.payload.result ?? 'unknown')
            : a.terminal
              ? 'unverified'
              : a.started
                ? 'executing'
                : a.selected
                  ? 'selected'
                  : 'unknown';
    if (!r.ended_at && current) r.status = a.status;
    bound(r.attempts, r);
  }
}
export function metrics(r: RunState) {
  const attempts = Object.values(r.attempts);
  const counts = {passed: 0, failed: 0, unknown: 0, unverified: 0, retries: 0};
  const actions = new Map<string, number>();
  for (const a of attempts) {
    actions.set(a.action_id, (actions.get(a.action_id) ?? 0) + 1);
    if (a.verification) counts[a.verification.payload.result ?? 'unknown']++;
    else if (a.terminal?.type === 'action.completed') counts.unverified++;
  }
  for (const n of actions.values()) counts.retries += Math.max(0, n - 1);
  return counts;
}

import {labels, type RunState} from '../../state';

export const UNKNOWN = '未知';
export const NOT_PROVIDED = '未提供';

export type StatusTone = 'neutral' | 'active' | 'success' | 'warning' | 'danger';
export type ConnectionKind = 'ended' | 'live' | 'quiet' | 'stale';

export function statusText(status: string): string {
  return labels[status] ?? UNKNOWN;
}

export function statusTone(status: string): StatusTone {
  if (status === 'waiting' || status === 'unknown' || status === 'cancelled') return 'neutral';
  if (status === 'evaluating' || status === 'selected' || status === 'executing') return 'active';
  if (status === 'unverified') return 'warning';
  if (status === 'passed' || status === 'completed') return 'success';
  if (status === 'failed' || status === 'verification_failed') return 'danger';
  return 'neutral';
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function formatClock(iso: string): string {
  const date = new Date(iso);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}秒`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}分${pad(totalSeconds % 60)}秒`;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}时${pad(totalMinutes % 60)}分`;
}

export function connectionState(
  run: Pick<RunState, 'ended_at' | 'last_received'>,
  now: number,
): {kind: ConnectionKind; text: string} {
  if (run.ended_at) return {kind: 'ended', text: '已结束'};
  const last = run.last_received ? Date.parse(run.last_received) : Number.NaN;
  const age = now - last;
  if (age <= 10_000) return {kind: 'live', text: '在线'};
  if (age <= 30_000) return {kind: 'quiet', text: `${Math.floor(age / 1000)} 秒无新事件`};
  const stamp = run.last_received ? formatClock(run.last_received) : UNKNOWN;
  return {kind: 'stale', text: `可能断开 · 最后更新 ${stamp}`};
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max))}…`;
}

export function pickDefaultRun<T extends {ended_at?: string; last_received?: string}>(
  runs: readonly T[],
): T | undefined {
  if (runs.length === 0) return undefined;
  const open = runs.filter(run => !run.ended_at);
  const pool = open.length > 0 ? open : runs;
  return pool.reduce((best, run) => {
    const bestTime = Date.parse(best.last_received ?? '') || 0;
    const runTime = Date.parse(run.last_received ?? '') || 0;
    return runTime >= bestTime ? run : best;
  });
}

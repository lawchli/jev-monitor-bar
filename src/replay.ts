import type {PageQuery, Snapshot} from './ipc';
import type {MonitorEvent, StoredEvent} from './protocol';
import {applyEvent, emptyRun, type RunState} from './state';

export const REPLAY_EVENT_LIMIT = 20000;
export const REPLAY_MAX_BYTES = 50 * 1024 * 1024;

export interface ReplayParsers {
  validateEvent(value: unknown): asserts value is MonitorEvent;
  sanitizeEvent<T>(event: T, diagnostics?: boolean): T;
}

export interface ReplayParseResult {
  events: StoredEvent[];
  invalidLines: number;
  truncated: boolean;
}

export function exportFileName(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `jev-monitor-export-${stamp}.jsonl`;
}

export function fileBase(file: string): string {
  const parts = file.split(/[/\\]/);
  return parts[parts.length - 1] || file;
}

function sequenceKey(event: Pick<StoredEvent, 'run_id' | 'producer_id' | 'sequence'>): string {
  return JSON.stringify([event.run_id, event.producer_id, event.sequence]);
}

export function parseReplay(text: string, parsers: ReplayParsers, limit = REPLAY_EVENT_LIMIT): ReplayParseResult {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const events: StoredEvent[] = [];
  let invalidLines = 0;
  let truncated = false;
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].replace(/\r$/, '');
    if (!line) continue;
    try {
      const row = JSON.parse(line) as unknown;
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid row');
      const record = row as Record<string, unknown>;
      const {received_at, cursor, ...event} = record;
      parsers.validateEvent(event);
      const clean = parsers.sanitizeEvent(event, false);
      const lineNumber = index + 1;
      if (cursor !== undefined && !Number.isSafeInteger(cursor)) throw new Error('Invalid cursor');
      if (received_at !== undefined && typeof received_at !== 'string') throw new Error('Invalid received_at');
      if (events.length >= limit) {
        truncated = true;
        continue;
      }
      events.push({
        ...clean,
        received_at: typeof received_at === 'string' ? received_at : clean.occurred_at,
        cursor: Number.isSafeInteger(cursor) ? (cursor as number) : lineNumber,
      });
    } catch {
      invalidLines++;
    }
  }
  return {events, invalidLines, truncated};
}

export function replaySnapshot(events: readonly StoredEvent[], count: number, runId?: string): Snapshot {
  const end = Number.isFinite(count) ? Math.max(0, Math.min(events.length, Math.trunc(count))) : 0;
  const runs = new Map<string, RunState>();
  const seenIds = new Set<string>();
  const seenSequences = new Set<string>();
  const applied: StoredEvent[] = [];
  let cursor = 0;
  let focus = runId;
  for (const event of events.slice(0, end)) {
    const key = sequenceKey(event);
    if (seenIds.has(event.event_id) || seenSequences.has(key)) continue;
    seenIds.add(event.event_id);
    seenSequences.add(key);
    let run = runs.get(event.run_id);
    if (!run) {
      run = emptyRun(event.run_id);
      runs.set(event.run_id, run);
    }
    applyEvent(run, event);
    applied.push(event);
    if (event.cursor > cursor) cursor = event.cursor;
    if (runId === undefined) focus = event.run_id;
    while (runs.size > 200) {
      const oldest = runs.keys().next().value;
      if (oldest === undefined) break;
      runs.delete(oldest);
    }
  }
  const selected = focus !== undefined ? runs.get(focus) : undefined;
  const visible = selected ? applied.filter(event => event.run_id === selected.id) : applied;
  return {
    cursor,
    runs: [...runs.values()].map(({decisions, attempts, ...summary}) => summary),
    run: selected,
    events: visible,
    corruptLines: 0,
  };
}

export function pageReplay(events: readonly StoredEvent[], count: number, query: PageQuery = {}): StoredEvent[] {
  const end = Number.isFinite(count) ? Math.max(0, Math.min(events.length, Math.trunc(count))) : 0;
  const raw = query.limit;
  const requested = typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(raw) : 100;
  const limit = Math.min(500, Math.max(1, requested));
  const before = typeof query.beforeCursor === 'number' ? query.beforeCursor : undefined;
  const rows = events.slice(0, end).filter(event => {
    if (query.runId !== undefined && event.run_id !== query.runId) return false;
    if (before !== undefined && event.cursor >= before) return false;
    return true;
  });
  rows.sort((left, right) => left.cursor - right.cursor);
  return rows.slice(-limit);
}

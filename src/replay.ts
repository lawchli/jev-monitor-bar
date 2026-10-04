import type {PageQuery, Snapshot} from './ipc';
import type {MonitorEvent, StoredEvent} from './protocol';
import {pickDefaultRun} from './renderer/view-model/common';
import {applyEvent, emptyRun, selectRunToEvict, type RunState} from './state';

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
  /** 超过上限时略过的更早有效事件数。 */
  omitted: number;
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

/** Detach public replay data while preserving shared references and null-prototype state tables. */
function copyReplayData<T>(value: T, copies = new WeakMap<object, object>()): T {
  if (value === null || typeof value !== 'object') return value;
  const previous = copies.get(value);
  if (previous) return previous as T;
  const copy = Array.isArray(value)
    ? []
    : Object.create(Object.getPrototypeOf(value) === null ? null : Object.prototype);
  copies.set(value, copy);
  for (const key of Object.keys(value)) {
    const entry = copyReplayData((value as Record<string, unknown>)[key], copies);
    if (key === '__proto__')
      Object.defineProperty(copy, key, {value: entry, enumerable: true, writable: true, configurable: true});
    else copy[key] = entry;
  }
  return copy as T;
}

export function parseReplay(text: string, parsers: ReplayParsers, limit = REPLAY_EVENT_LIMIT): ReplayParseResult {
  const requested = Number.isFinite(limit) ? Math.trunc(limit) : REPLAY_EVENT_LIMIT;
  const retainedLimit = Math.min(REPLAY_EVENT_LIMIT, Math.max(1, requested));
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const events: StoredEvent[] = [];
  let invalidLines = 0;
  let omitted = 0;
  const lines = source.split('\n');
  // 从文件末尾往前读：超过上限时留下最近的事件。更早的行照样校验，只计入无效行或略过数，不脱敏也不保留。
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].replace(/\r$/, '');
    if (!line) continue;
    try {
      const row = JSON.parse(line) as unknown;
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid row');
      const record = row as Record<string, unknown>;
      const {received_at, cursor, ...event} = record;
      parsers.validateEvent(event);
      if (cursor !== undefined && !Number.isSafeInteger(cursor)) throw new Error('Invalid cursor');
      if (received_at !== undefined && typeof received_at !== 'string') throw new Error('Invalid received_at');
      if (events.length >= retainedLimit) {
        omitted++;
        continue;
      }
      const clean = parsers.sanitizeEvent(event, false);
      events.push({
        ...clean,
        received_at: typeof received_at === 'string' ? received_at : clean.occurred_at,
        cursor: Number.isSafeInteger(cursor) ? (cursor as number) : index + 1,
      });
    } catch {
      invalidLines++;
    }
  }
  events.reverse();
  return {events, invalidLines, truncated: omitted > 0, omitted};
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
      const victim = selectRunToEvict(runs.values());
      if (!victim) break;
      runs.delete(victim.id);
    }
  }
  let selected = focus !== undefined ? runs.get(focus) : undefined;
  if (!selected) selected = pickDefaultRun([...runs.values()]);
  return copyReplayData({
    cursor,
    runs: [...runs.values()].map(({decisions, attempts, ...summary}) => summary),
    run: selected,
    events: selected ? applied.filter(event => event.run_id === selected.id) : [],
    corruptLines: 0,
  });
}

export const REPLAY_CHECKPOINT_INTERVAL = 1000;
/** 检查点最多这么多段；事件更多时加大间隔，检查点占用随事件数线性增长。 */
export const REPLAY_MAX_CHECKPOINTS = 20;

type Entries<T> = Record<string, T>;

function copyEntries<T extends object>(entries: Entries<T>): Entries<T> {
  const copy = Object.create(null) as Entries<T>;
  for (const key of Object.keys(entries)) copy[key] = {...entries[key]};
  return copy;
}

function copyRun(run: RunState): RunState {
  return {...run, decisions: copyEntries(run.decisions), attempts: copyEntries(run.attempts)};
}

function sameFields(left: object, right: object): boolean {
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  for (const key of keys) if (!Object.hasOwn(b, key) || a[key] !== b[key]) return false;
  return true;
}

// 字段逐一相同的条目换回上一个检查点里的对象；键和顺序也都相同时整张表共用。
function shareEntries<T extends object>(entries: Entries<T>, previous: Entries<T>): Entries<T> {
  const keys = Object.keys(entries);
  const before = Object.keys(previous);
  let same = keys.length === before.length;
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    const old = previous[key];
    if (old !== undefined && old !== entries[key] && sameFields(entries[key], old)) entries[key] = old;
    if (same && (before[index] !== key || entries[key] !== old)) same = false;
  }
  return same ? previous : entries;
}

/**
 * 回放拖动不再每次从第 0 条重算，结果与 replaySnapshot 相同。
 *
 * 每 interval 条留一个聚合状态检查点。跳到第 p 条时，从 p 之前最近的检查点起最多再应用 interval - 1 条；
 * 从当前位置往后走只应用新增的几条。检查点里的 RunState 之后不再改动：检查点之后第一次改某个 run 时才复制它
 * （run 本身、decisions 和 attempts 里的条目各复制一层），存检查点时把没变的条目换回上一个检查点的对象。
 * 内部事件和 payload 共用同一份：applyEvent 只替换对它们的引用，不改内容；交给调用方的快照另作深拷贝。
 *
 * 内存上限：检查点最多 REPLAY_MAX_CHECKPOINTS + 1 个。每条事件最多新增一个决策和一个尝试，第 j 个检查点的表格
 * 最多 2·j·interval 个键，所以全部检查点合计不超过 n·(n / interval + 1) 个键，n = 20000 时约 42 万个。
 * 这是每段都改到所有 run 的极端情形，实测约 27 MB；30 分钟负载的导出只有约 2 万个键、不到 3 MB。
 */
export class ReplayTimeline {
  readonly interval: number;
  /** 1 表示这条事件会被应用，0 表示按 event_id 或序号重复而跳过。 */
  private readonly applies: Uint8Array;
  /** 前 p 条之后的 cursor。 */
  private readonly cursors: Float64Array;
  /** 前 p 条里最后一条被应用的事件下标，没有为 -1。 */
  private readonly lastApplied: Int32Array;
  /** 每个 run 被应用的事件下标，升序。 */
  private readonly runEvents = new Map<string, number[]>();
  private readonly checkpoints: Map<string, RunState>[] = [new Map()];
  private readonly frozen = new WeakSet<RunState>();
  private readonly origins = new WeakMap<RunState, RunState>();
  private runs = new Map<string, RunState>();
  private position = 0;

  constructor(
    readonly events: readonly StoredEvent[],
    interval = Math.max(REPLAY_CHECKPOINT_INTERVAL, Math.ceil(events.length / REPLAY_MAX_CHECKPOINTS)),
  ) {
    this.interval = Math.max(1, Math.trunc(interval) || 1);
    const total = events.length;
    this.applies = new Uint8Array(total);
    this.cursors = new Float64Array(total + 1);
    this.lastApplied = new Int32Array(total + 1).fill(-1);
    // 是否重复只取决于更早被应用的事件，与播放到哪里无关，所以一次算完对所有前缀都成立。
    const seenIds = new Set<string>();
    const seenSequences = new Set<string>();
    let cursor = 0;
    let last = -1;
    for (let index = 0; index < total; index++) {
      const event = events[index];
      const key = sequenceKey(event);
      if (!seenIds.has(event.event_id) && !seenSequences.has(key)) {
        seenIds.add(event.event_id);
        seenSequences.add(key);
        this.applies[index] = 1;
        if (event.cursor > cursor) cursor = event.cursor;
        last = index;
        const list = this.runEvents.get(event.run_id);
        if (list) list.push(index);
        else this.runEvents.set(event.run_id, [index]);
      }
      this.cursors[index + 1] = cursor;
      this.lastApplied[index + 1] = last;
    }
  }

  snapshot(count: number, runId?: string): Snapshot {
    const end = Number.isFinite(count) ? Math.max(0, Math.min(this.events.length, Math.trunc(count))) : 0;
    this.seek(end);
    const last = this.lastApplied[end];
    const focus = runId !== undefined ? runId : last >= 0 ? this.events[last].run_id : undefined;
    const runs = [...this.runs.values()];
    let selected = focus !== undefined ? this.runs.get(focus) : undefined;
    if (!selected) selected = pickDefaultRun(runs);
    return copyReplayData({
      cursor: this.cursors[end],
      runs: runs.map(({decisions, attempts, ...summary}) => summary),
      run: selected,
      events: selected ? this.eventsOf(selected.id, end) : [],
      corruptLines: 0,
    });
  }

  private eventsOf(runId: string, end: number): StoredEvent[] {
    const list = this.runEvents.get(runId);
    if (!list) return [];
    let low = 0;
    let high = list.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (list[middle] < end) low = middle + 1;
      else high = middle;
    }
    return list.slice(0, low).map(index => this.events[index]);
  }

  private seek(target: number) {
    const base = Math.min(Math.floor(target / this.interval), this.checkpoints.length - 1);
    const baseAt = base * this.interval;
    if (this.position > target || this.position < baseAt) {
      // 往回走，或者目标越过了下一个已有的检查点：从目标之前最近的检查点接着算。
      this.runs = new Map(this.checkpoints[base]);
      this.position = baseAt;
    }
    while (this.position < target) this.advance();
  }

  private advance() {
    const index = this.position;
    if (this.applies[index]) {
      const event = this.events[index];
      let run = this.runs.get(event.run_id);
      if (!run) {
        run = emptyRun(event.run_id);
        this.runs.set(event.run_id, run);
      } else if (this.frozen.has(run)) {
        const copy = copyRun(run);
        this.origins.set(copy, run);
        // 已有的键原位替换，Map 的顺序不变，淘汰时同时间先出现的 run 仍排在前面。
        this.runs.set(event.run_id, copy);
        run = copy;
      }
      applyEvent(run, event);
      // 与 replaySnapshot、EventStore 一样最多保留 200 个 run。
      while (this.runs.size > 200) {
        const victim = selectRunToEvict(this.runs.values());
        if (!victim) break;
        this.runs.delete(victim.id);
      }
    }
    this.position = index + 1;
    if (this.position % this.interval === 0 && this.position / this.interval === this.checkpoints.length) this.record();
  }

  private record() {
    for (const run of this.runs.values()) {
      if (this.frozen.has(run)) continue;
      const origin = this.origins.get(run);
      if (origin) {
        run.decisions = shareEntries(run.decisions, origin.decisions);
        run.attempts = shareEntries(run.attempts, origin.attempts);
        this.origins.delete(run);
      }
      this.frozen.add(run);
    }
    this.checkpoints.push(new Map(this.runs));
  }
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
  return copyReplayData(rows.slice(-limit));
}

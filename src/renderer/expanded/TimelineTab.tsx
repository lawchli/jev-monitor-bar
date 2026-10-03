import {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import type {MonitorBridge} from '../../ipc';
import type {StoredEvent} from '../../protocol';
import {timelineItems, timelineWindow, type TimelineFilter, type TimelineItemModel} from './model';

const renderLimit = 500;

type OlderEnd = 'unknown' | 'none' | 'truncated';

export function TimelineTab({
  events,
  runId,
  bridge,
  retryKeys,
  eventCount,
}: {
  events: StoredEvent[];
  runId?: string;
  bridge: MonitorBridge;
  retryKeys?: ReadonlySet<string>;
  /** Events received for the run so far. Snapshots carry only the newest rows, so this counts arrivals while paused. */
  eventCount?: number;
}) {
  const [filter, setFilter] = useState<TimelineFilter>('all');
  const [older, setOlder] = useState<StoredEvent[]>([]);
  const [held, setHeld] = useState<StoredEvent[]>([]);
  const [following, setFollowing] = useState(true);
  const [pinnedEnd, setPinnedEnd] = useState<number | null>(null);
  const [pausedAt, setPausedAt] = useState(0);
  const [pausedCount, setPausedCount] = useState(0);
  const [selected, setSelected] = useState<number>();
  const [loading, setLoading] = useState(false);
  const [olderFailed, setOlderFailed] = useState(false);
  const [olderEnd, setOlderEnd] = useState<OlderEnd>('unknown');
  const listRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const newestRef = useRef(0);
  const scrollToTop = useRef(false);
  const epochRef = useRef(0);
  const runIdRef = useRef(runId);
  const visibleStartRef = useRef<number | undefined>(undefined);
  const visibleEndRef = useRef<number | undefined>(undefined);
  const filteredStartRef = useRef<number | undefined>(undefined);
  const filteredEndRef = useRef<number | undefined>(undefined);
  const eventCountRef = useRef(eventCount);
  runIdRef.current = runId;
  eventCountRef.current = eventCount;

  useEffect(() => {
    epochRef.current += 1;
    setOlder([]);
    setHeld([]);
    setPinnedEnd(null);
    setOlderEnd('unknown');
    setSelected(undefined);
    setLoading(false);
    setOlderFailed(false);
    followingRef.current = true;
    setFollowing(true);
  }, [runId]);

  useEffect(() => {
    return () => {
      epochRef.current += 1;
    };
  }, []);

  const merged = useMemo(() => mergeEvents([...held, ...older], events, runId), [held, older, events, runId]);
  const allItems = useMemo(() => timelineItems(merged, 'all'), [merged]);
  const filtered = useMemo(() => timelineItems(merged, filter, retryKeys), [merged, filter, retryKeys]);
  const visible = useMemo(
    () => timelineWindow(filtered, following ? null : pinnedEnd, renderLimit),
    [filtered, following, pinnedEnd],
  );
  const newest = allItems.at(-1)?.cursor ?? 0;
  newestRef.current = newest;
  visibleStartRef.current = visible[0]?.cursor;
  visibleEndRef.current = visible.at(-1)?.cursor;
  filteredStartRef.current = filtered[0]?.cursor;
  filteredEndRef.current = filtered.at(-1)?.cursor;
  const newCount =
    eventCount !== undefined
      ? Math.max(0, eventCount - pausedCount)
      : allItems.filter(item => item.cursor > pausedAt).length;
  const selectedItem =
    visible.find(item => item.cursor === selected) ?? allItems.find(item => item.cursor === selected);
  const atLoadedStart = visible.length > 0 && filtered[0]?.cursor === visible[0].cursor;
  const showingTail = filtered.length === 0 || visible.at(-1)?.cursor === filtered.at(-1)?.cursor;

  useEffect(() => {
    if (following) return;
    const rows = visible.map(item => item.event);
    setHeld(current => {
      const next = mergeEvents(current, rows, runId);
      return next.length === current.length ? current : next;
    });
  }, [following, visible, runId]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    if (scrollToTop.current) {
      list.scrollTop = 0;
      scrollToTop.current = false;
      return;
    }
    if (!followingRef.current) return;
    list.scrollTop = list.scrollHeight;
  }, [visible, following]);

  function stopFollowing(anchor: number) {
    if (followingRef.current) {
      followingRef.current = false;
      setPausedAt(newestRef.current);
      setPausedCount(eventCountRef.current ?? 0);
      setFollowing(false);
    }
    setPinnedEnd(anchor);
  }

  function followLatest() {
    followingRef.current = true;
    setFollowing(true);
    setPinnedEnd(null);
    // Rows kept for reading history stop where the snapshot has moved on. Following shows only the snapshot,
    // so the tail never skips the events in between. An in-flight older page belongs to the history view.
    epochRef.current += 1;
    setLoading(false);
    setOlderFailed(false);
    setOlder([]);
    setHeld([]);
    setOlderEnd('unknown');
  }

  function onScroll() {
    const list = listRef.current;
    if (!list) return;
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight <= 8;
    if (atBottom) {
      const tail = filteredEndRef.current === undefined || visibleEndRef.current === filteredEndRef.current;
      if (tail && !followingRef.current) followLatest();
      return;
    }
    const anchor = visibleEndRef.current;
    if (followingRef.current && anchor !== undefined) stopFollowing(anchor);
  }

  function resume() {
    followLatest();
    setPausedAt(newestRef.current);
    setPausedCount(eventCountRef.current ?? 0);
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }

  async function loadOlder() {
    const start = visibleStartRef.current;
    const atStart = start !== undefined && start === filteredStartRef.current;
    if (!atStart && start !== undefined) {
      scrollToTop.current = true;
      stopFollowing(start);
      return;
    }
    const requestRunId = runIdRef.current;
    if (!requestRunId || loading || olderEnd !== 'unknown') return;
    const captured = epochRef.current;
    const earliest = merged.reduce((min, event) => Math.min(min, event.cursor), Number.POSITIVE_INFINITY);
    if (!Number.isFinite(earliest)) return;
    setLoading(true);
    const current = () => captured === epochRef.current && runIdRef.current === requestRunId;
    try {
      const page = await bridge.page({runId: requestRunId, beforeCursor: earliest, limit: 100});
      if (!current()) return;
      setOlderFailed(false);
      const accepted = page.events.filter(event => event.run_id === requestRunId);
      if (accepted.length === 0) {
        setOlderEnd(page.truncated ? 'truncated' : 'none');
        return;
      }
      const anchor = visibleStartRef.current;
      if (anchor !== undefined) {
        scrollToTop.current = true;
        stopFollowing(anchor);
      }
      setOlder(currentRows => mergeEvents(currentRows, accepted, requestRunId));
    } catch {
      if (!current()) return;
      scrollToTop.current = false;
      setOlderFailed(true);
    } finally {
      if (current()) setLoading(false);
    }
  }

  const olderLabel = loading
    ? '正在加载…'
    : atLoadedStart && olderEnd === 'none'
      ? '没有更早的事件'
      : atLoadedStart && olderEnd === 'truncated'
        ? '更早的事件已超出保留窗口'
        : olderFailed
          ? '重试加载更早'
          : '加载更早';

  return (
    <div className="timeline">
      <div className="timeline-tools">
        <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
          全部
        </button>
        <button type="button" aria-pressed={filter === 'errors'} onClick={() => setFilter('errors')}>
          仅错误与重试
        </button>
        <button
          type="button"
          data-testid="timeline-load-older"
          disabled={
            loading || (atLoadedStart && (olderEnd !== 'unknown' || !runId)) || (visible.length === 0 && !runId)
          }
          onClick={() => void loadOlder()}
        >
          {olderLabel}
        </button>
      </div>
      {olderFailed ? (
        <p className="muted" role="status">
          暂时未能加载更早的事件，请重试。
        </p>
      ) : null}
      {following ? (
        <p className="follow-note">跟随最新</p>
      ) : (
        <button type="button" className="resume-button" data-testid="timeline-resume" onClick={resume}>
          已暂停跟随 · {newCount} 条新事件 · 回到最新
        </button>
      )}
      {!showingTail ? (
        <p className="muted">正在查看较早事件（{visible.length} 条）</p>
      ) : filtered.length > renderLimit ? (
        <p className="muted">仅显示最近 {renderLimit} 条</p>
      ) : null}
      {visible.length === 0 ? <p className="expanded-empty">尚无事件</p> : null}
      <div className="timeline-list" ref={listRef} onScroll={onScroll}>
        {visible.map(item => (
          <TimelineRow key={item.cursor} item={item} selected={item.cursor === selected} onSelect={setSelected} />
        ))}
      </div>
      {selectedItem ? <pre className="timeline-json">{JSON.stringify(selectedItem.event, null, 2)}</pre> : null}
    </div>
  );
}

function TimelineRow({
  item,
  selected,
  onSelect,
}: {
  item: TimelineItemModel;
  selected: boolean;
  onSelect(cursor: number): void;
}) {
  return (
    <button
      type="button"
      className={selected ? 'timeline-item is-selected' : 'timeline-item'}
      data-testid="timeline-item"
      data-cursor={item.cursor}
      onClick={() => onSelect(item.cursor)}
    >
      <span>{item.typeText}</span>
      <span className="muted">{item.type}</span>
      <span>
        发生 {item.occurredText} · 接收 {item.receivedText}
      </span>
      {item.late ? <span className="late">迟到</span> : null}
    </button>
  );
}

function mergeEvents(left: readonly StoredEvent[], right: readonly StoredEvent[], runId?: string): StoredEvent[] {
  const byCursor = new Map<number, StoredEvent>();
  for (const event of [...left, ...right]) {
    if (runId && event.run_id !== runId) continue;
    byCursor.set(event.cursor, event);
  }
  return [...byCursor.values()].sort((a, b) => a.cursor - b.cursor);
}

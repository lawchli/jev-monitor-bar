import {useEffect, useId, useLayoutEffect, useMemo, useRef, useState} from 'react';
import type {MonitorBridge} from '../../ipc';
import type {StoredEvent} from '../../protocol';
import {timelineItems, timelineWindow, type TimelineFilter, type TimelineItemModel} from './model';
import {searchTimelineItemsAsync} from './search';

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
  const [query, setQuery] = useState('');
  const [searchResult, setSearchResult] = useState<{
    query: string;
    source: TimelineItemModel[];
    items: TimelineItemModel[];
    failed?: boolean;
  }>();
  const [older, setOlder] = useState<StoredEvent[]>([]);
  const [held, setHeld] = useState<StoredEvent[]>([]);
  const [following, setFollowing] = useState(true);
  const [pinnedEnd, setPinnedEnd] = useState<number | null>(null);
  const [pausedAt, setPausedAt] = useState(0);
  const [pausedCount, setPausedCount] = useState(0);
  const [selected, setSelected] = useState<number>();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [olderEnd, setOlderEnd] = useState<OlderEnd>('unknown');
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const searchNoteId = useId();
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
    setLoadError(false);
    setQuery('');
    followingRef.current = true;
    setFollowing(true);
  }, [runId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 'f') return;
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => setSelected(undefined), [filter, query]);

  useEffect(() => {
    return () => {
      epochRef.current += 1;
    };
  }, []);

  const merged = useMemo(() => mergeEvents([...held, ...older], events, runId), [held, older, events, runId]);
  const allItems = useMemo(() => timelineItems(merged, 'all'), [merged]);
  const categoryItems = useMemo(
    () => (filter === 'all' ? allItems : timelineItems(merged, filter, retryKeys)),
    [merged, allItems, filter, retryKeys],
  );
  const hasQuery = query.trim().length > 0;
  const currentSearch = searchResult?.source === categoryItems && searchResult.query === query;
  const searchPending = hasQuery && !currentSearch;
  const searchFailed = hasQuery && currentSearch && searchResult.failed;
  const filtered = hasQuery ? (currentSearch ? searchResult.items : []) : categoryItems;

  useEffect(() => {
    if (!query.trim()) {
      setSearchResult(undefined);
      return;
    }
    const controller = new AbortController();
    void searchTimelineItemsAsync(categoryItems, query, {signal: controller.signal})
      .then(items => {
        if (!controller.signal.aborted) setSearchResult({query, source: categoryItems, items});
      })
      .catch(() => {
        if (!controller.signal.aborted) setSearchResult({query, source: categoryItems, items: [], failed: true});
      });
    return () => controller.abort();
  }, [categoryItems, query]);
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
  const selectedItem = searchPending
    ? undefined
    : (visible.find(item => item.cursor === selected) ?? allItems.find(item => item.cursor === selected));
  const atLoadedStart = visible.length > 0 && filtered[0]?.cursor === visible[0].cursor;
  const canReachOlder = atLoadedStart || visible.length === 0;
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
    setLoadError(false);
    setOlder([]);
    setHeld([]);
    setOlderEnd('unknown');
  }

  function onScroll() {
    if (searchPending) return;
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
    setLoadError(false);
    const current = () => captured === epochRef.current && runIdRef.current === requestRunId;
    try {
      const page = await bridge.page({runId: requestRunId, beforeCursor: earliest, limit: 100});
      if (!current()) return;
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
      scrollToTop.current = false;
      if (current()) setLoadError(true);
    } finally {
      if (current()) setLoading(false);
    }
  }

  const olderLabel = loading
    ? '正在加载…'
    : canReachOlder && olderEnd === 'none'
      ? '没有更早的事件'
      : canReachOlder && olderEnd === 'truncated'
        ? '更早的事件已超出保留窗口'
        : '加载更早';

  return (
    <div className="timeline">
      <div className="timeline-search">
        <label className="sr-only" htmlFor={`${searchNoteId}-input`}>
          搜索已加载的脱敏事件
        </label>
        <input
          ref={searchRef}
          id={`${searchNoteId}-input`}
          type="search"
          data-testid="timeline-search"
          placeholder="搜索事件、内容或 ID"
          aria-describedby={searchNoteId}
          maxLength={200}
          value={query}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            setQuery('');
          }}
        />
        {query ? (
          <button type="button" aria-label="清除时间线搜索" onClick={() => setQuery('')}>
            清除
          </button>
        ) : (
          <span className="search-shortcut" aria-hidden="true">
            Ctrl / ⌘ F
          </span>
        )}
      </div>
      <p className="timeline-search-note" id={searchNoteId}>
        {searchPending ? (
          <span data-testid="timeline-search-pending" role="status">
            正在搜索… ·{' '}
          </span>
        ) : searchFailed ? (
          '搜索失败，请重试 · '
        ) : hasQuery ? (
          `匹配 ${filtered.length} / ${categoryItems.length} 条 · `
        ) : (
          ''
        )}
        仅搜索已加载的 {allItems.length} 条脱敏事件；可加载更早记录
      </p>
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
            loading || (canReachOlder && (olderEnd !== 'unknown' || !runId)) || (visible.length === 0 && !runId)
          }
          onClick={() => void loadOlder()}
        >
          {olderLabel}
        </button>
      </div>
      {loadError ? (
        <p className="timeline-load-error tone-danger" role="alert">
          加载失败，请点击「加载更早」重试
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
      {!searchPending && !searchFailed && visible.length === 0 ? (
        <p className="expanded-empty">
          {allItems.length === 0
            ? '尚无事件，宿主发来的记录会显示在这里'
            : hasQuery
              ? '已加载的事件中没有匹配项，试试其他关键词或加载更早记录'
              : '已加载的事件中没有错误与重试'}
        </p>
      ) : null}
      <div className="timeline-list" ref={listRef} onScroll={onScroll}>
        {visible.map(item => (
          <TimelineRow key={item.cursor} item={item} selected={item.cursor === selected} onSelect={setSelected} />
        ))}
      </div>
      {selectedItem ? (
        <section className="timeline-detail" aria-label="脱敏事件详情">
          <p className="timeline-detail-label">脱敏事件详情 · #{selectedItem.cursor}</p>
          <pre className="timeline-json">{JSON.stringify(selectedItem.event, null, 2)}</pre>
        </section>
      ) : null}
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
      <span className="timeline-event-name">{item.typeText}</span>
      <span className="muted timeline-event-type">{item.type}</span>
      <span className="timeline-event-time">
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

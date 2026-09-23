import {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import type {MonitorBridge} from '../../ipc';
import type {StoredEvent} from '../../protocol';
import {timelineItems, type TimelineFilter, type TimelineItemModel} from './model';
import {
  shiftTimelineWindow,
  timelinePageSize,
  timelineRenderLimit,
  visibleTimelineItems,
  type TimelineAnchor,
} from './timeline-window';

export function TimelineTab({
  events,
  runId,
  bridge,
  retryKeys,
}: {
  events: StoredEvent[];
  runId?: string;
  bridge: MonitorBridge;
  retryKeys?: ReadonlySet<string>;
}) {
  const [filter, setFilter] = useState<TimelineFilter>('all');
  const [older, setOlder] = useState<StoredEvent[]>([]);
  const [archive, setArchive] = useState<StoredEvent[]>([]);
  const [following, setFollowing] = useState(true);
  const [anchor, setAnchor] = useState<TimelineAnchor>({following: true});
  const [pausedAt, setPausedAt] = useState(0);
  const [selected, setSelected] = useState<number>();
  const [loading, setLoading] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const newestRef = useRef(0);
  const pendingAdjust = useRef(false);
  const previousHeight = useRef(0);
  const epochRef = useRef(0);
  const runIdRef = useRef(runId);
  const suppressScroll = useRef(false);
  const archiveRef = useRef(archive);
  const olderRef = useRef(older);
  const eventsRef = useRef(events);
  runIdRef.current = runId;
  archiveRef.current = archive;
  olderRef.current = older;
  eventsRef.current = events;

  useEffect(() => {
    epochRef.current += 1;
    setOlder([]);
    setArchive([]);
    setExhausted(false);
    setSelected(undefined);
    setLoading(false);
    setAnchor({following: true});
    followingRef.current = true;
    setFollowing(true);
  }, [runId]);

  useEffect(() => {
    setArchive(current => {
      const next = mergeEvents(current, events, runId);
      if (next.length === current.length && next.every((event, index) => event === current[index])) return current;
      return next;
    });
  }, [events, runId]);

  useEffect(() => {
    return () => {
      epochRef.current += 1;
    };
  }, []);

  const merged = useMemo(
    () => mergeEvents(mergeEvents(archive, older, runId), events, runId),
    [archive, older, events, runId],
  );
  const allItems = useMemo(() => timelineItems(merged, 'all'), [merged]);
  const filtered = useMemo(() => timelineItems(merged, filter, retryKeys), [merged, filter, retryKeys]);
  const windowAnchor = following ? {following: true} : anchor;
  const visible = visibleTimelineItems(filtered, windowAnchor, timelineRenderLimit);
  const newest = allItems.at(-1)?.cursor ?? 0;
  newestRef.current = newest;
  const newCount = allItems.filter(item => item.cursor > pausedAt).length;
  const selectedItem =
    visible.find(item => item.cursor === selected) ?? allItems.find(item => item.cursor === selected);
  const atOldest = visible.length > 0 && visible[0].cursor === filtered[0]?.cursor;
  const noEarlier = exhausted && atOldest;

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    if (pendingAdjust.current && !followingRef.current) {
      const delta = list.scrollHeight - previousHeight.current;
      suppressScroll.current = true;
      if (delta > 0) list.scrollTop += delta;
      pendingAdjust.current = false;
      queueMicrotask(() => {
        suppressScroll.current = false;
      });
      return;
    }
    if (!followingRef.current) return;
    suppressScroll.current = true;
    list.scrollTop = list.scrollHeight;
    queueMicrotask(() => {
      suppressScroll.current = false;
    });
  }, [visible, following]);

  function pinWindow(next: {startCursor: number; endCursor: number}) {
    const wasFollowing = followingRef.current;
    followingRef.current = false;
    setFollowing(false);
    setAnchor({following: false, startCursor: next.startCursor, endCursor: next.endCursor});
    if (wasFollowing) setPausedAt(newestRef.current);
    const list = listRef.current;
    previousHeight.current = list?.scrollHeight ?? 0;
    pendingAdjust.current = true;
  }

  function onScroll() {
    const list = listRef.current;
    if (!list || suppressScroll.current) return;
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight <= 8;
    if (atBottom) {
      if (!followingRef.current) {
        followingRef.current = true;
        setFollowing(true);
        setAnchor({following: true});
      }
      return;
    }
    if (followingRef.current) {
      followingRef.current = false;
      setPausedAt(newestRef.current);
      setFollowing(false);
      if (visible.length > 0) {
        setAnchor({
          following: false,
          startCursor: visible[0].cursor,
          endCursor: visible[visible.length - 1].cursor,
        });
      }
    }
  }

  function resume() {
    followingRef.current = true;
    setFollowing(true);
    setAnchor({following: true});
    setPausedAt(newestRef.current);
    const list = listRef.current;
    if (list) {
      suppressScroll.current = true;
      list.scrollTop = list.scrollHeight;
      queueMicrotask(() => {
        suppressScroll.current = false;
      });
    }
  }

  async function loadOlder() {
    const requestRunId = runIdRef.current;
    if (!requestRunId || loading || noEarlier) return;
    const anchorNow: TimelineAnchor = following
      ? {following: true}
      : {following: false, startCursor: anchor.startCursor, endCursor: anchor.endCursor};
    const shifted = shiftTimelineWindow(filtered, anchorNow, timelinePageSize, timelineRenderLimit);
    if (shifted.moved) {
      pinWindow(shifted);
      return;
    }
    let anchorForShift: TimelineAnchor = anchorNow;
    if (visible.length > 0) {
      const pinned = {startCursor: visible[0].cursor, endCursor: visible[visible.length - 1].cursor};
      anchorForShift = {following: false, ...pinned};
      if (followingRef.current) pinWindow(pinned);
    }
    const captured = epochRef.current;
    const earliest = merged.reduce((min, event) => Math.min(min, event.cursor), Number.POSITIVE_INFINITY);
    if (!Number.isFinite(earliest)) return;
    const list = listRef.current;
    previousHeight.current = list?.scrollHeight ?? 0;
    pendingAdjust.current = true;
    setLoading(true);
    const current = () => captured === epochRef.current && runIdRef.current === requestRunId;
    try {
      const page = await bridge.page({runId: requestRunId, beforeCursor: earliest, limit: timelinePageSize});
      if (!current()) {
        pendingAdjust.current = false;
        return;
      }
      const accepted = page.filter(event => event.run_id === requestRunId);
      if (accepted.length === 0) {
        setExhausted(true);
        pendingAdjust.current = false;
        return;
      }
      const nextOlder = mergeEvents(olderRef.current, accepted, requestRunId);
      const nextMerged = mergeEvents(
        mergeEvents(archiveRef.current, nextOlder, requestRunId),
        eventsRef.current,
        requestRunId,
      );
      const nextFiltered = timelineItems(nextMerged, filter, retryKeys);
      const nextShift = shiftTimelineWindow(nextFiltered, anchorForShift, timelinePageSize, timelineRenderLimit);
      if (nextShift.moved) pinWindow(nextShift);
      setOlder(nextOlder);
    } catch {
      if (current()) pendingAdjust.current = false;
    } finally {
      if (current()) setLoading(false);
    }
  }

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
          disabled={!runId || loading || noEarlier}
          onClick={() => void loadOlder()}
        >
          {loading ? '正在加载…' : noEarlier ? '没有更早的事件' : '加载更早'}
        </button>
      </div>
      {following ? (
        <p className="follow-note">跟随最新</p>
      ) : (
        <button type="button" className="resume-button" data-testid="timeline-resume" onClick={resume}>
          已暂停跟随 · {newCount} 条新事件 · 回到最新
        </button>
      )}
      {filtered.length > visible.length ? (
        <p className="muted">{following ? `仅显示最近 ${timelineRenderLimit} 条` : `仅显示 ${visible.length} 条`}</p>
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

import {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import type {MonitorBridge} from '../../ipc';
import type {StoredEvent} from '../../protocol';
import {timelineItems, type TimelineFilter, type TimelineItemModel} from './model';

const renderLimit = 500;

export function TimelineTab({events, runId, bridge}: {events: StoredEvent[]; runId?: string; bridge: MonitorBridge}) {
  const [filter, setFilter] = useState<TimelineFilter>('all');
  const [older, setOlder] = useState<StoredEvent[]>([]);
  const [following, setFollowing] = useState(true);
  const [pausedAt, setPausedAt] = useState(0);
  const [selected, setSelected] = useState<number>();
  const [loading, setLoading] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const newestRef = useRef(0);
  const pendingAdjust = useRef(false);
  const previousHeight = useRef(0);

  useEffect(() => {
    setOlder([]);
    setExhausted(false);
    setSelected(undefined);
    followingRef.current = true;
    setFollowing(true);
  }, [runId]);

  const merged = useMemo(() => mergeEvents(older, events), [older, events]);
  const allItems = useMemo(() => timelineItems(merged, 'all'), [merged]);
  const filtered = useMemo(() => timelineItems(merged, filter), [merged, filter]);
  const visible = filtered.slice(-renderLimit);
  const newest = allItems.at(-1)?.cursor ?? 0;
  newestRef.current = newest;
  const newCount = allItems.filter(item => item.cursor > pausedAt).length;
  const selectedItem =
    visible.find(item => item.cursor === selected) ?? allItems.find(item => item.cursor === selected);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    if (pendingAdjust.current && !followingRef.current) {
      const delta = list.scrollHeight - previousHeight.current;
      if (delta > 0) list.scrollTop += delta;
      pendingAdjust.current = false;
      return;
    }
    if (!followingRef.current) return;
    list.scrollTop = list.scrollHeight;
  }, [visible, following]);

  function onScroll() {
    const list = listRef.current;
    if (!list) return;
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight <= 8;
    if (atBottom) {
      followingRef.current = true;
      setFollowing(true);
      return;
    }
    if (followingRef.current) {
      followingRef.current = false;
      setPausedAt(newestRef.current);
      setFollowing(false);
    }
  }

  function resume() {
    followingRef.current = true;
    setFollowing(true);
    setPausedAt(newestRef.current);
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }

  async function loadOlder() {
    if (!runId || loading || exhausted) return;
    const earliest = merged.reduce((min, event) => Math.min(min, event.cursor), Number.POSITIVE_INFINITY);
    if (!Number.isFinite(earliest)) return;
    const list = listRef.current;
    previousHeight.current = list?.scrollHeight ?? 0;
    pendingAdjust.current = true;
    setLoading(true);
    try {
      const page = await bridge.page({runId, beforeCursor: earliest, limit: 100});
      if (page.length === 0) {
        setExhausted(true);
        pendingAdjust.current = false;
      }
      setOlder(current => mergeEvents(current, page));
    } catch {
      pendingAdjust.current = false;
    } finally {
      setLoading(false);
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
          disabled={!runId || loading || exhausted}
          onClick={() => void loadOlder()}
        >
          {loading ? '正在加载…' : exhausted ? '没有更早的事件' : '加载更早'}
        </button>
      </div>
      {following ? (
        <p className="follow-note">跟随最新</p>
      ) : (
        <button type="button" className="resume-button" data-testid="timeline-resume" onClick={resume}>
          已暂停跟随 · {newCount} 条新事件 · 回到最新
        </button>
      )}
      {filtered.length > renderLimit ? <p className="muted">仅显示最近 {renderLimit} 条</p> : null}
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

function mergeEvents(left: readonly StoredEvent[], right: readonly StoredEvent[]): StoredEvent[] {
  const byCursor = new Map<number, StoredEvent>();
  for (const event of [...left, ...right]) byCursor.set(event.cursor, event);
  return [...byCursor.values()].sort((a, b) => a.cursor - b.cursor);
}

export const timelineRenderLimit = 500;
export const timelinePageSize = 100;

export interface TimelineCursorItem {
  cursor: number;
}

/** `following` shows the tail. Otherwise the inclusive cursor range is the pinned window. */
export interface TimelineAnchor {
  following: boolean;
  startCursor?: number;
  endCursor?: number;
}

export function visibleTimelineItems<T extends TimelineCursorItem>(
  items: readonly T[],
  anchor: TimelineAnchor,
  limit = timelineRenderLimit,
): T[] {
  const startCursor = anchor.startCursor;
  const endCursor = anchor.endCursor;
  if (items.length === 0) return [];
  if (anchor.following || startCursor === undefined || endCursor === undefined) {
    return items.slice(-limit);
  }
  const ranged = items.filter(item => item.cursor >= startCursor && item.cursor <= endCursor);
  if (ranged.length <= limit) return ranged;
  return ranged.slice(0, limit);
}

/**
 * Move the window toward older items by one page, keeping at most `limit` rows.
 * `moved` is false when the window already includes the oldest item in memory.
 */
export function shiftTimelineWindow<T extends TimelineCursorItem>(
  items: readonly T[],
  anchor: TimelineAnchor,
  pageSize = timelinePageSize,
  limit = timelineRenderLimit,
): {startCursor: number; endCursor: number; moved: boolean} {
  const visible = visibleTimelineItems(items, anchor, limit);
  if (items.length === 0 || visible.length === 0) {
    return {startCursor: 0, endCursor: 0, moved: false};
  }
  const startIndex = items.findIndex(item => item.cursor === visible[0].cursor);
  if (startIndex <= 0) {
    return {
      startCursor: visible[0].cursor,
      endCursor: visible[visible.length - 1].cursor,
      moved: false,
    };
  }
  const nextStart = Math.max(0, startIndex - pageSize);
  const slice = items.slice(nextStart, nextStart + limit);
  return {
    startCursor: slice[0].cursor,
    endCursor: slice[slice.length - 1].cursor,
    moved: slice[0].cursor !== visible[0].cursor,
  };
}

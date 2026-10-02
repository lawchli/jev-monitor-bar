import type {TimelineItemModel} from './model';

// Stored IPC/replay events are immutable. Weak keys release text when an event leaves the loaded window.
const textCache = new WeakMap<TimelineItemModel['event'], string>();

function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}

function termsOf(query: string): string[] {
  return normalize(query).trim().split(/\s+/u).filter(Boolean);
}

function itemText(item: TimelineItemModel): string {
  let text = textCache.get(item.event);
  if (text === undefined) {
    text = normalize(`${item.typeText} ${item.occurredText} ${item.receivedText} ${JSON.stringify(item.event)}`);
    textCache.set(item.event, text);
  }
  return text;
}

/** Literal, whitespace-separated terms are ANDed. Input is only the already-loaded, redacted IPC data. */
export function searchTimelineItems(items: readonly TimelineItemModel[], query: string): TimelineItemModel[] {
  const terms = termsOf(query);
  if (terms.length === 0) return [...items];
  return items.filter(item => {
    const text = itemText(item);
    return terms.every(term => text.includes(term));
  });
}

export interface SearchOptions {
  signal?: AbortSignal;
  /** Best-effort CPU budget; one event or a GC pause can exceed it. */
  budgetMs?: number;
  /** Injectable scheduler and observations for deterministic cancellation tests and isolated benchmarks. */
  yieldControl?: () => Promise<void>;
  onSlice?: (durationMs: number, processed: number) => void;
}

function checkAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  const error = new Error('Search cancelled');
  error.name = 'AbortError';
  throw error;
}

/** Full loaded-window search yields between CPU slices; it never opens files or starts a worker. */
export async function searchTimelineItemsAsync(
  items: readonly TimelineItemModel[],
  query: string,
  {
    signal,
    budgetMs = 6,
    yieldControl = () => new Promise(resolve => setTimeout(resolve, 0)),
    onSlice,
  }: SearchOptions = {},
): Promise<TimelineItemModel[]> {
  checkAborted(signal);
  const terms = termsOf(query);
  if (terms.length === 0) return [...items];
  const result: TimelineItemModel[] = [];
  let sliceStarted = performance.now();
  let processed = 0;
  for (let index = 0; index < items.length; index++) {
    checkAborted(signal);
    const item = items[index];
    const text = itemText(item);
    if (terms.every(term => text.includes(term))) result.push(item);
    processed++;
    const duration = performance.now() - sliceStarted;
    if (duration < Math.max(0, budgetMs) && index + 1 < items.length) continue;
    onSlice?.(duration, processed);
    processed = 0;
    if (index + 1 < items.length) {
      await yieldControl();
      checkAborted(signal);
      sliceStarted = performance.now();
    }
  }
  return result;
}

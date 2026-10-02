import type {Changed} from '../ipc';
import type {StoredEvent} from '../protocol';
import type {EventStore, RecoveredChange} from '../store';

/** Batch both newly accepted events and rehydrated state through the same UI notification path. */
export function subscribeStoreChanges(store: EventStore, send: (change: Changed) => void, delayMs = 50): () => void {
  let timer: NodeJS.Timeout | undefined;
  const runIds = new Set<string>();
  const queue = (ids: readonly string[]) => {
    for (const id of ids) runIds.add(id);
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      const change: Changed = {cursor: store.cursor, runIds: [...runIds]};
      runIds.clear();
      send(change);
    }, delayMs);
  };
  const onEvent = (event: StoredEvent) => queue([event.run_id]);
  const onRecovered = (change: RecoveredChange) => queue(change.runIds);
  store.on('event', onEvent);
  store.on('recovered', onRecovered);
  return () => {
    store.off('event', onEvent);
    store.off('recovered', onRecovered);
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    runIds.clear();
  };
}

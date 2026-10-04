import {useCallback, useEffect, useRef, useState} from 'react';
import type {MonitorBridge, ReceiverStatus, Snapshot} from '../ipc';

export interface MonitorState {
  snapshot?: Snapshot;
  status?: ReceiverStatus;
  statusError?: string;
  snapshotError?: string;
  retrying: boolean;
  retry(): void;
  now: number;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Keep global fields when the loaded snapshot was fetched for a different run. */
export function projectSnapshot(
  snapshot: Snapshot | undefined,
  fetchedFor: string | undefined,
  runId: string | undefined,
): Snapshot | undefined {
  if (!snapshot || fetchedFor === runId) return snapshot;
  return {...snapshot, run: undefined, events: []};
}

export function useMonitor(runId?: string, bridge: MonitorBridge = window.monitor): MonitorState {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [fetchedFor, setFetchedFor] = useState<string | undefined>();
  const [status, setStatus] = useState<ReceiverStatus>();
  const [statusError, setStatusError] = useState<string>();
  const [snapshotError, setSnapshotError] = useState<string>();
  const [now, setNow] = useState(() => Date.now());
  const [retrying, setRetrying] = useState(false);
  const retryPending = useRef(false);
  const retryEpoch = useRef(0);
  const mounted = useRef(false);
  const readStatus = useRef<() => Promise<void>>(() => Promise.resolve());
  const readSnapshot = useRef<() => Promise<void>>(() => Promise.resolve());

  const retry = useCallback(() => {
    if (retryPending.current) return;
    retryPending.current = true;
    const epoch = ++retryEpoch.current;
    setRetrying(true);
    void Promise.all([readStatus.current(), readSnapshot.current()]).finally(() => {
      if (retryEpoch.current !== epoch) return;
      retryPending.current = false;
      if (mounted.current) setRetrying(false);
    });
  }, []);

  useEffect(() => {
    retryEpoch.current += 1;
    retryPending.current = false;
    setRetrying(false);
  }, [runId, bridge]);

  useEffect(() => {
    mounted.current = true;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let stopped = false;
    let inFlight: Promise<void> | undefined;
    const load = () => {
      if (inFlight) return inFlight;
      inFlight = bridge
        .status()
        .then(next => {
          if (stopped) return;
          setStatus(next);
          setStatusError(undefined);
        })
        .catch(reason => {
          if (!stopped) setStatusError(message(reason));
        })
        .finally(() => {
          inFlight = undefined;
        });
      return inFlight;
    };
    readStatus.current = load;
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      stopped = true;
      clearInterval(timer);
      if (readStatus.current === load) readStatus.current = () => Promise.resolve();
    };
  }, [bridge]);

  useEffect(() => {
    let stopped = false;
    let inFlight: Promise<void> | undefined;
    let pending = false;
    let lastStart = 0;
    let delayTimer: ReturnType<typeof setTimeout> | undefined;

    const start = (immediate = false): Promise<void> => {
      if (stopped) return Promise.resolve();
      if (inFlight) {
        if (!immediate) pending = true;
        return inFlight;
      }
      const elapsed = Date.now() - lastStart;
      if (!immediate && lastStart !== 0 && elapsed < 100) {
        pending = true;
        if (!delayTimer) {
          delayTimer = setTimeout(() => {
            delayTimer = undefined;
            if (!pending) return;
            pending = false;
            start();
          }, 100 - elapsed);
        }
        return Promise.resolve();
      }
      pending = false;
      lastStart = Date.now();
      const requested = runId;
      inFlight = bridge
        .snapshot(requested)
        .then(next => {
          if (stopped) return;
          setSnapshot(next);
          setFetchedFor(requested);
          setSnapshotError(undefined);
        })
        .catch(reason => {
          if (!stopped) setSnapshotError(message(reason));
        })
        .finally(() => {
          inFlight = undefined;
          if (stopped || !pending) return;
          pending = false;
          start();
        });
      return inFlight;
    };

    const refresh = () => start(true);
    readSnapshot.current = refresh;
    void start();
    const unsubscribe = bridge.onChanged(() => {
      void start();
    });
    return () => {
      stopped = true;
      if (delayTimer) clearTimeout(delayTimer);
      unsubscribe();
      if (readSnapshot.current === refresh) readSnapshot.current = () => Promise.resolve();
    };
  }, [runId, bridge]);

  return {
    snapshot: projectSnapshot(snapshot, fetchedFor, runId),
    status,
    statusError,
    snapshotError,
    retrying,
    retry,
    now,
  };
}

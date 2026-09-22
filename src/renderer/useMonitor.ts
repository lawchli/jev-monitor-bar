import {useEffect, useState} from 'react';
import type {ReceiverStatus, Snapshot} from '../ipc';

export interface MonitorState {
  snapshot?: Snapshot;
  status?: ReceiverStatus;
  statusError?: string;
  snapshotError?: string;
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

export function useMonitor(runId?: string): MonitorState {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [fetchedFor, setFetchedFor] = useState<string | undefined>();
  const [status, setStatus] = useState<ReceiverStatus>();
  const [statusError, setStatusError] = useState<string>();
  const [snapshotError, setSnapshotError] = useState<string>();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let stopped = false;
    const load = () => {
      window.monitor
        .status()
        .then(next => {
          if (stopped) return;
          setStatus(next);
          setStatusError(undefined);
        })
        .catch(reason => {
          if (!stopped) setStatusError(message(reason));
        });
    };
    load();
    const timer = setInterval(load, 5000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let stopped = false;
    let inFlight = false;
    let pending = false;
    let lastStart = 0;
    let delayTimer: ReturnType<typeof setTimeout> | undefined;

    const start = () => {
      if (stopped) return;
      if (inFlight) {
        pending = true;
        return;
      }
      const elapsed = Date.now() - lastStart;
      if (lastStart !== 0 && elapsed < 100) {
        pending = true;
        if (!delayTimer) {
          delayTimer = setTimeout(() => {
            delayTimer = undefined;
            if (!pending) return;
            pending = false;
            start();
          }, 100 - elapsed);
        }
        return;
      }
      inFlight = true;
      pending = false;
      lastStart = Date.now();
      const requested = runId;
      window.monitor
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
          inFlight = false;
          if (stopped || !pending) return;
          pending = false;
          start();
        });
    };

    start();
    const unsubscribe = window.monitor.onChanged(() => start());
    return () => {
      stopped = true;
      if (delayTimer) clearTimeout(delayTimer);
      unsubscribe();
    };
  }, [runId]);

  return {snapshot: projectSnapshot(snapshot, fetchedFor, runId), status, statusError, snapshotError, now};
}

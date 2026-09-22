import {useEffect, useState} from 'react';
import type {ReceiverStatus, Snapshot} from '../ipc';

export interface MonitorState {
  snapshot?: Snapshot;
  status?: ReceiverStatus;
  error?: string;
  now: number;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useMonitor(runId?: string): MonitorState {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [status, setStatus] = useState<ReceiverStatus>();
  const [error, setError] = useState<string>();
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
          if (!stopped) setStatus(next);
        })
        .catch(reason => {
          if (!stopped) setError(message(reason));
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
      window.monitor
        .snapshot(runId)
        .then(next => {
          if (!stopped) setSnapshot(next);
        })
        .catch(reason => {
          if (!stopped) setError(message(reason));
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

  return {snapshot, status, error, now};
}

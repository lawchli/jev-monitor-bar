import {useEffect, useRef, useState} from 'react';
import type {MonitorBridge, WindowMode} from '../ipc';
import {CompactView} from './compact/CompactView';
import {ExpandedView} from './expanded/ExpandedView';
import type {ViewProps} from './types';
import {useMonitor} from './useMonitor';
import {pickDefaultRun} from './view-model/common';

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function App({bridge}: {bridge: MonitorBridge}) {
  const [explicitRunId, setExplicitRunId] = useState<string | undefined>();
  const [autoRunId, setAutoRunId] = useState<string | undefined>();
  const [mode, setMode] = useState<WindowMode>('compact');
  const [pinned, setPinned] = useState(true);
  const [commandError, setCommandError] = useState<string>();
  const commandPending = useRef(false);
  const commandEpoch = useRef(0);
  const selectedRunId = explicitRunId ?? autoRunId;
  const {snapshot, status, statusError, snapshotError, now} = useMonitor(selectedRunId);

  useEffect(() => {
    if (explicitRunId !== undefined) return;
    setAutoRunId(pickDefaultRun(snapshot?.runs ?? [])?.id);
  }, [explicitRunId, snapshot]);

  useEffect(() => {
    if (!status || commandPending.current) return;
    setMode(status.mode);
    setPinned(status.pinned);
  }, [status]);

  const applyCommand = <T,>(
    optimistic: () => void,
    invoke: () => Promise<T>,
    adopt: (value: T) => void,
    restore: () => void,
  ) => {
    const epoch = ++commandEpoch.current;
    commandPending.current = true;
    optimistic();
    void invoke()
      .then(value => {
        if (commandEpoch.current !== epoch) return;
        adopt(value);
        setCommandError(undefined);
      })
      .catch(async (reason: unknown) => {
        if (commandEpoch.current !== epoch) return;
        setCommandError(message(reason));
        try {
          const fresh = await bridge.status();
          if (commandEpoch.current !== epoch) return;
          setMode(fresh.mode);
          setPinned(fresh.pinned);
        } catch {
          if (commandEpoch.current === epoch) restore();
        }
      })
      .finally(() => {
        if (commandEpoch.current === epoch) commandPending.current = false;
      });
  };

  const props: ViewProps = {
    snapshot,
    status,
    now,
    selectedRunId,
    onSelectRun: setExplicitRunId,
    mode,
    onSetMode: next => {
      const previous = mode;
      applyCommand(
        () => setMode(next),
        () => bridge.setMode(next),
        applied => setMode(applied),
        () => setMode(previous),
      );
    },
    pinned,
    onTogglePinned: () => {
      const previous = pinned;
      const next = !pinned;
      applyCommand(
        () => setPinned(next),
        () => bridge.setPinned(next),
        applied => setPinned(applied),
        () => setPinned(previous),
      );
    },
    bridge,
  };

  const notices = [
    ['status', statusError],
    ['snapshot', snapshotError],
    ['command', commandError],
  ] as const;

  return (
    <div id="app-root" data-cursor={snapshot?.cursor ?? 0} data-mode={mode}>
      {notices.map(([key, text]) =>
        text ? (
          <p key={key} className="line tone-danger">
            {text}
          </p>
        ) : null,
      )}
      {mode === 'expanded' ? <ExpandedView {...props} /> : <CompactView {...props} />}
    </div>
  );
}

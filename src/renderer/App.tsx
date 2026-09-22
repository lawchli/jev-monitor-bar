import {useEffect, useState} from 'react';
import type {MonitorBridge, WindowMode} from '../ipc';
import {CompactView} from './compact/CompactView';
import {ExpandedView} from './expanded/ExpandedView';
import type {ViewProps} from './types';
import {useMonitor} from './useMonitor';
import {pickDefaultRun} from './view-model/common';

export function App({bridge}: {bridge: MonitorBridge}) {
  const [explicitRunId, setExplicitRunId] = useState<string | undefined>();
  const [fallbackRunId, setFallbackRunId] = useState<string | undefined>();
  const [mode, setMode] = useState<WindowMode>('compact');
  const [pinned, setPinned] = useState(true);
  const selectedRunId = explicitRunId ?? fallbackRunId;
  const {snapshot, status, error, now} = useMonitor(selectedRunId);

  useEffect(() => {
    if (explicitRunId) return;
    setFallbackRunId(pickDefaultRun(snapshot?.runs ?? [])?.id);
  }, [explicitRunId, snapshot]);

  useEffect(() => {
    if (!status) return;
    setMode(status.mode);
    setPinned(status.pinned);
  }, [status]);

  const props: ViewProps = {
    snapshot,
    status,
    now,
    selectedRunId: explicitRunId ?? pickDefaultRun(snapshot?.runs ?? [])?.id,
    onSelectRun: setExplicitRunId,
    mode,
    onSetMode: next => {
      setMode(next);
      void bridge.setMode(next);
    },
    pinned,
    onTogglePinned: () => {
      const next = !pinned;
      setPinned(next);
      void bridge.setPinned(next);
    },
    bridge,
  };

  return (
    <div id="app-root" data-cursor={snapshot?.cursor ?? 0} data-mode={mode}>
      {error ? <p className="line tone-danger">{error}</p> : null}
      {mode === 'expanded' ? <ExpandedView {...props} /> : <CompactView {...props} />}
    </div>
  );
}

import {useEffect, useRef, useState} from 'react';
import type {MonitorBridge, ReplayData, WindowMode} from '../ipc';
import {fileBase} from '../replay';
import {CompactView} from './compact/CompactView';
import {ExpandedView} from './expanded/ExpandedView';
import {ReplayView} from './replay/ReplayView';
import './replay/replay.css';
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
  const [exportNote, setExportNote] = useState<string>();
  const [replay, setReplay] = useState<ReplayData | null>(null);
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
    onExport: () => {
      void bridge
        .exportEvents()
        .then(result => {
          if (result.saved) {
            const name = result.path ? fileBase(result.path) : '文件';
            const skipped = result.skipped ? `，跳过 ${result.skipped} 行` : '';
            const unreadable = result.unreadable ? `，${result.unreadable} 个段文件读不了` : '';
            setExportNote(`已导出 ${name}（${result.bytes ?? 0} 字节${skipped}${unreadable}）`);
          } else {
            setExportNote('已取消导出');
          }
          setCommandError(undefined);
        })
        .catch((reason: unknown) => setCommandError(message(reason)));
    },
    onOpenReplay: () => {
      void bridge
        .openReplay()
        .then(data => {
          if (data) setReplay(data);
          setCommandError(undefined);
        })
        .catch((reason: unknown) => setCommandError(message(reason)));
    },
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
      {exportNote ? <p className="line">{exportNote}</p> : null}
      {replay ? (
        <ReplayView replay={replay} now={now} onExit={() => setReplay(null)} />
      ) : mode === 'expanded' ? (
        <ExpandedView {...props} />
      ) : (
        <CompactView {...props} />
      )}
    </div>
  );
}

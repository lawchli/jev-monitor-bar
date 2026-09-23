import type {MonitorBridge, ReceiverStatus, Snapshot, WindowMode} from '../ipc';

export interface ViewProps {
  snapshot?: Snapshot;
  status?: ReceiverStatus;
  now: number;
  selectedRunId?: string;
  onSelectRun(id: string): void;
  mode: WindowMode;
  onSetMode(mode: WindowMode): void;
  pinned: boolean;
  onTogglePinned(): void;
  bridge: MonitorBridge;
}

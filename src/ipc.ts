import type {StoredEvent} from './protocol';
import type {RunState} from './state';

export const IPC = {
  snapshot: 'monitor:snapshot',
  page: 'monitor:page',
  status: 'monitor:status',
  changed: 'monitor:changed',
  setMode: 'monitor:set-mode',
  setPinned: 'monitor:set-pinned',
} as const;

export type WindowMode = 'compact' | 'expanded';
export type RunSummary = Omit<RunState, 'decisions' | 'attempts'>;

export interface Snapshot {
  cursor: number;
  runs: RunSummary[];
  run?: RunState;
  events: StoredEvent[];
  corruptLines: number;
}

export interface PageQuery {
  runId?: string;
  beforeCursor?: number;
  limit?: number;
}

export interface EventPage {
  events: StoredEvent[];
  /** True when nothing older remains in memory because earlier events were dropped. */
  truncated: boolean;
}

export interface PlatformInfo {
  os: 'windows' | 'macos' | 'linux-x11' | 'linux-wayland' | 'other';
  arch: string;
  tier: 1 | 2 | 3;
  alwaysOnTopSupported: boolean;
  notes: string[];
}

export interface ReceiverStatus {
  listening: boolean;
  url?: string;
  dataDir: string;
  corruptLines: number;
  storageError?: string;
  platform: PlatformInfo;
  mode: WindowMode;
  pinned: boolean;
  startedAt: string;
}

export interface Changed {
  cursor: number;
  runIds: string[];
}

export interface MonitorBridge {
  snapshot(runId?: string): Promise<Snapshot>;
  page(query: PageQuery): Promise<EventPage>;
  status(): Promise<ReceiverStatus>;
  onChanged(listener: (change: Changed) => void): () => void;
  setMode(mode: WindowMode): Promise<WindowMode>;
  setPinned(pinned: boolean): Promise<boolean>;
}

import type {StoredEvent} from './protocol';
import type {RunState} from './state';

export const IPC = {
  snapshot: 'monitor:snapshot',
  page: 'monitor:page',
  status: 'monitor:status',
  changed: 'monitor:changed',
  setMode: 'monitor:set-mode',
  setPinned: 'monitor:set-pinned',
  exportEvents: 'monitor:export',
  openReplay: 'monitor:open-replay',
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

export interface ExportResult {
  saved: boolean;
  path?: string;
  bytes?: number;
  skipped?: number;
  /** 读不了而略过的段文件数。 */
  unreadable?: number;
}

export interface ReplayData {
  file: string;
  events: StoredEvent[];
  invalidLines: number;
  truncated: boolean;
  /** 超过条数上限时，只保留最近的事件；这里是略过的更早有效事件数。 */
  omitted?: number;
}

export interface MonitorBridge {
  snapshot(runId?: string): Promise<Snapshot>;
  page(query: PageQuery): Promise<EventPage>;
  status(): Promise<ReceiverStatus>;
  onChanged(listener: (change: Changed) => void): () => void;
  setMode(mode: WindowMode): Promise<WindowMode>;
  setPinned(pinned: boolean): Promise<boolean>;
  exportEvents(): Promise<ExportResult>;
  openReplay(): Promise<ReplayData | null>;
}

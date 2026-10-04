import type {EventPage, ExportResult, PageQuery, ReceiverStatus, ReplayData, Snapshot, WindowMode} from '../ipc';
import {validateEvent} from '../protocol';
import {parseReplay} from '../replay';
import {sanitizeEvent} from '../redact';
import type {EventStore} from '../store';
import {suggestedExportFileName} from './export-name';

export interface ReplayFileIO {
  saveDialog(defaultPath: string): Promise<string | undefined>;
  openDialog(): Promise<string | undefined>;
  readBounded(file: string): ReplayReadResult;
  write(file: string, contents: string): void;
}

export type ReplayReadResult =
  {ok: true; text: string} | {ok: false; reason: 'too-large'} | {ok: false; reason: 'read-error'; message: string};

export interface IpcSender {
  sender: unknown;
  senderFrame?: {url: string} | null;
}

/** Structural stand-in for the monitor `webContents`. Tests never import Electron. */
export interface RendererContents {
  mainFrame: unknown;
}

export interface WindowControls {
  setMode(mode: WindowMode): WindowMode;
  setPinned(pinned: boolean): boolean;
}

export interface MonitorHandlerOptions {
  store?: EventStore;
  controller: WindowControls;
  getStatus: () => ReceiverStatus;
  rendererUrl: string;
  contents: RendererContents;
}

const emptySnapshot = (): Snapshot => ({cursor: 0, runs: [], events: [], corruptLines: 0});

function assertRenderer(event: IpcSender, contents: RendererContents, rendererUrl: string) {
  const frame = event.senderFrame;
  const accepted =
    event.sender === contents && frame != null && frame === contents.mainFrame && frame.url === rendererUrl;
  if (!accepted) throw new Error(`Rejected IPC sender: ${frame?.url ?? 'none'}`);
}

function optionalRunId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 160) throw new Error('Invalid runId');
  return value;
}

function nonNegativeInt(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error(`Invalid ${name}`);
  return value;
}

function parseMode(value: unknown): WindowMode {
  if (value !== 'compact' && value !== 'expanded') throw new Error('Invalid mode');
  return value;
}

function parsePage(query: unknown): PageQuery {
  if (query == null) return {};
  if (typeof query !== 'object' || Array.isArray(query)) throw new Error('Invalid page query');
  const page = query as PageQuery;
  return {
    runId: optionalRunId(page.runId),
    beforeCursor: nonNegativeInt(page.beforeCursor, 'beforeCursor'),
    limit: nonNegativeInt(page.limit, 'limit'),
  };
}

export function createMonitorHandlers(opts: MonitorHandlerOptions) {
  const guard = (event: IpcSender) => assertRenderer(event, opts.contents, opts.rendererUrl);
  return {
    snapshot(event: IpcSender, runId?: unknown): Snapshot {
      guard(event);
      const id = optionalRunId(runId);
      return opts.store ? opts.store.snapshot(id) : emptySnapshot();
    },
    page(event: IpcSender, query?: unknown): EventPage {
      guard(event);
      const parsed = parsePage(query);
      if (!opts.store) return {events: [], truncated: false};
      const events = opts.store.page(parsed);
      return {events, truncated: events.length === 0 && opts.store.historyTruncated(parsed)};
    },
    status(event: IpcSender): ReceiverStatus {
      guard(event);
      const status = opts.getStatus();
      return {
        listening: status.listening,
        url: status.url,
        dataDir: status.dataDir,
        corruptLines: status.corruptLines,
        storageError: status.storageError,
        platform: status.platform,
        mode: status.mode,
        pinned: status.pinned,
        startedAt: status.startedAt,
      };
    },
    setMode(event: IpcSender, mode: unknown): WindowMode {
      guard(event);
      return opts.controller.setMode(parseMode(mode));
    },
    setPinned(event: IpcSender, pinned: unknown): boolean {
      guard(event);
      if (typeof pinned !== 'boolean') throw new Error('Invalid pinned');
      return opts.controller.setPinned(pinned);
    },
    async exportEvents(event: IpcSender, files: ReplayFileIO): Promise<ExportResult> {
      guard(event);
      const runs = opts.store?.snapshot().runs ?? [];
      const selected = await files.saveDialog(suggestedExportFileName(new Date(), runs));
      if (!selected) return {saved: false};
      const exported = opts.store ? opts.store.exportLines() : {text: '', skipped: 0};
      files.write(selected, exported.text);
      return {
        saved: true,
        path: selected,
        bytes: Buffer.byteLength(exported.text),
        skipped: exported.skipped,
      };
    },
    async openReplay(event: IpcSender, files: ReplayFileIO): Promise<ReplayData | null> {
      guard(event);
      const selected = await files.openDialog();
      if (!selected) return null;
      const read = files.readBounded(selected);
      if (!read.ok) {
        if (read.reason === 'too-large') throw new Error('回放文件超过 50 MiB');
        throw new Error(read.message);
      }
      const parsed = parseReplay(read.text, {validateEvent, sanitizeEvent});
      return {file: selected, ...parsed};
    },
  };
}

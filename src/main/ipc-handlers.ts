import {ipcMain, type IpcMainInvokeEvent} from 'electron';
import {IPC, type PageQuery, type ReceiverStatus, type WindowMode} from '../ipc';
import type {EventStore} from '../store';
import type {MonitorWindowController} from './window';

export interface RegisterIpcOptions {
  store: EventStore;
  controller: MonitorWindowController;
  getStatus: () => ReceiverStatus;
  rendererUrl: string;
}

function assertRenderer(event: IpcMainInvokeEvent, rendererUrl: string) {
  if (event.senderFrame?.url !== rendererUrl) {
    throw new Error(`Rejected IPC sender: ${event.senderFrame?.url ?? 'none'}`);
  }
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

export function registerIpc(opts: RegisterIpcOptions) {
  const guard = (event: IpcMainInvokeEvent) => assertRenderer(event, opts.rendererUrl);
  ipcMain.handle(IPC.snapshot, (event, runId: unknown) => {
    guard(event);
    return opts.store.snapshot(optionalRunId(runId));
  });
  ipcMain.handle(IPC.page, (event, query: unknown) => {
    guard(event);
    if (query == null) return opts.store.page();
    if (typeof query !== 'object' || Array.isArray(query)) throw new Error('Invalid page query');
    const page = query as PageQuery;
    return opts.store.page({
      runId: optionalRunId(page.runId),
      beforeCursor: nonNegativeInt(page.beforeCursor, 'beforeCursor'),
      limit: nonNegativeInt(page.limit, 'limit'),
    });
  });
  ipcMain.handle(IPC.status, event => {
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
  });
  ipcMain.handle(IPC.setMode, (event, mode: unknown) => {
    guard(event);
    return opts.controller.setMode(parseMode(mode));
  });
  ipcMain.handle(IPC.setPinned, (event, pinned: unknown) => {
    guard(event);
    if (typeof pinned !== 'boolean') throw new Error('Invalid pinned');
    return opts.controller.setPinned(pinned);
  });
}

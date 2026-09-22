import {ipcMain} from 'electron';
import {IPC} from '../ipc';
import {createMonitorHandlers, type MonitorHandlerOptions} from './ipc-api';

export function registerIpc(opts: MonitorHandlerOptions) {
  const handlers = createMonitorHandlers(opts);
  ipcMain.handle(IPC.snapshot, (event, runId: unknown) => handlers.snapshot(event, runId));
  ipcMain.handle(IPC.page, (event, query: unknown) => handlers.page(event, query));
  ipcMain.handle(IPC.status, event => handlers.status(event));
  ipcMain.handle(IPC.setMode, (event, mode: unknown) => handlers.setMode(event, mode));
  ipcMain.handle(IPC.setPinned, (event, pinned: unknown) => handlers.setPinned(event, pinned));
}

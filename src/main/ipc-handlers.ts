import fs from 'node:fs';
import {BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent} from 'electron';
import {IPC} from '../ipc';
import {REPLAY_MAX_BYTES} from '../replay';
import {createMonitorHandlers, type MonitorHandlerOptions, type ReplayFileIO, type ReplayReadResult} from './ipc-api';

function parentWindow(event: IpcMainInvokeEvent): BrowserWindow | undefined {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return undefined;
  return win;
}

function readBounded(file: string): ReplayReadResult {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return {ok: false, reason: 'read-error', message: '不是文件'};
    if (stat.size > REPLAY_MAX_BYTES) return {ok: false, reason: 'too-large'};
    return {ok: true, text: fs.readFileSync(file, 'utf8')};
  } catch (error) {
    return {ok: false, reason: 'read-error', message: error instanceof Error ? error.message : String(error)};
  }
}

function replayFiles(event: IpcMainInvokeEvent): ReplayFileIO {
  const filters = [{name: 'JSONL', extensions: ['jsonl']}];
  return {
    async saveDialog(defaultPath) {
      const options = {defaultPath, filters};
      const win = parentWindow(event);
      const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return undefined;
      return result.filePath;
    },
    async openDialog() {
      const options = {filters, properties: ['openFile'] as 'openFile'[]};
      const win = parentWindow(event);
      const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      if (result.canceled || result.filePaths.length === 0) return undefined;
      return result.filePaths[0];
    },
    readBounded,
    write(file, contents) {
      fs.writeFileSync(file, contents);
    },
  };
}

export function registerIpc(opts: MonitorHandlerOptions) {
  const handlers = createMonitorHandlers(opts);
  ipcMain.handle(IPC.snapshot, (event, runId: unknown) => handlers.snapshot(event, runId));
  ipcMain.handle(IPC.page, (event, query: unknown) => handlers.page(event, query));
  ipcMain.handle(IPC.status, event => handlers.status(event));
  ipcMain.handle(IPC.setMode, (event, mode: unknown) => handlers.setMode(event, mode));
  ipcMain.handle(IPC.setPinned, (event, pinned: unknown) => handlers.setPinned(event, pinned));
  ipcMain.handle(IPC.exportEvents, event => handlers.exportEvents(event, replayFiles(event)));
  ipcMain.handle(IPC.openReplay, event => handlers.openReplay(event, replayFiles(event)));
}

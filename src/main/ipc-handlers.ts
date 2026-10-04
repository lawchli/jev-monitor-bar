import fs from 'node:fs';
import {BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent} from 'electron';
import {IPC} from '../ipc';
import {createMonitorHandlers, type MonitorHandlerOptions, type ReplayFileIO} from './ipc-api';
import {readReplayFile} from './replay-files';

function parentWindow(event: IpcMainInvokeEvent): BrowserWindow | undefined {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return undefined;
  return win;
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
    readBounded: readReplayFile,
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

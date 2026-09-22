import path from 'node:path';
import {app, BrowserWindow} from 'electron';
import type {WindowMode} from '../ipc';

const sizes: Record<WindowMode, {width: number; height: number}> = {
  compact: {width: 400, height: 132},
  expanded: {width: 440, height: 640},
};

export interface MonitorWindowController {
  getMode(): WindowMode;
  setMode(mode: WindowMode): WindowMode;
  getPinned(): boolean;
  setPinned(pinned: boolean): boolean;
}

export interface MonitorWindowOptions {
  preload: string;
}

export function createMonitorWindow(opts: MonitorWindowOptions): {
  win: BrowserWindow;
  controller: MonitorWindowController;
} {
  let mode: WindowMode = 'compact';
  let pinned = true;
  const win = new BrowserWindow({
    width: sizes.compact.width,
    height: sizes.compact.height,
    show: false,
    alwaysOnTop: true,
    frame: true,
    title: 'JEV Monitor Bar',
    webPreferences: {
      preload: opts.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  win.once('ready-to-show', () => {
    win.showInactive();
  });
  win.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  win.webContents.on('will-navigate', event => {
    event.preventDefault();
  });
  const controller: MonitorWindowController = {
    getMode: () => mode,
    setMode(next) {
      mode = next;
      const size = sizes[next];
      win.setSize(size.width, size.height);
      return mode;
    },
    getPinned: () => pinned,
    setPinned(next) {
      pinned = next;
      win.setAlwaysOnTop(next);
      return pinned;
    },
  };
  return {win, controller};
}

/** Load only after IPC handlers for this window are registered. */
export function loadMonitorWindow(win: BrowserWindow) {
  void win.loadFile(path.join(__dirname, 'renderer/index.html'));
}

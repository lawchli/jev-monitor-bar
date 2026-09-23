import path from 'node:path';
import {app, BrowserWindow, screen} from 'electron';
import type {WindowMode} from '../ipc';
import {detectPlatform, platformProfile} from './platform';
import {
  boundsEcho,
  defaultWindowState,
  fitToDisplays,
  loadWindowState,
  rememberMove,
  rememberResize,
  saveWindowState,
  switchMode,
  type DisplayWorkArea,
  type Rect,
  type SavedWindowState,
} from './window-state';

const sizes: Record<WindowMode, {width: number; height: number; minWidth: number; minHeight: number}> = {
  compact: {width: 400, height: 132, minWidth: 360, minHeight: 96},
  expanded: {width: 440, height: 640, minWidth: 360, minHeight: 320},
};

const SAVE_DELAY_MS = 500;
// After show, remeasure getBounds minus the rect we applied. This does not drop user input.
// Linux X11 may report the offset only after the window is mapped. Windows and macOS usually
// report it inside setBounds, which `applying` already ignores.
const ECHO_MEASURE_DELAY_MS = 250;
const OFFSCREEN = -1_000_000;

export interface MonitorWindowController {
  getMode(): WindowMode;
  setMode(mode: WindowMode): WindowMode;
  getPinned(): boolean;
  setPinned(pinned: boolean): boolean;
}

export interface MonitorWindowOptions {
  preload: string;
  stateFile: string;
}

function readDisplays(): DisplayWorkArea[] {
  return screen.getAllDisplays().map(display => ({
    id: display.id,
    workArea: display.workArea,
    scaleFactor: display.scaleFactor,
  }));
}

function withMinimum(rect: Rect, mode: WindowMode): Rect {
  const size = sizes[mode];
  return {
    x: rect.x,
    y: rect.y,
    width: Math.max(rect.width, size.minWidth),
    height: Math.max(rect.height, size.minHeight),
  };
}

function place(saved: SavedWindowState | undefined): SavedWindowState {
  const displays = readDisplays();
  const primaryId = screen.getPrimaryDisplay().id;
  const base =
    saved ??
    defaultWindowState({
      compact: {x: 0, y: 0, width: sizes.compact.width, height: sizes.compact.height},
      expanded: {x: 0, y: 0, width: sizes.expanded.width, height: sizes.expanded.height},
    });
  const fit = (rect: Rect) => fitToDisplays(saved ? rect : {...rect, x: OFFSCREEN, y: OFFSCREEN}, displays, primaryId);
  return {
    ...base,
    bounds: {
      compact: fit(base.bounds.compact),
      expanded: fit(base.bounds.expanded),
    },
  };
}

export function createMonitorWindow(opts: MonitorWindowOptions): {
  win: BrowserWindow;
  controller: MonitorWindowController;
} {
  let state = place(loadWindowState(opts.stateFile));
  let mode = state.mode;
  let pinned = state.pinned;
  const initial = withMinimum(state.bounds[mode], mode);
  state = {...state, bounds: {...state.bounds, [mode]: initial}};
  const win = new BrowserWindow({
    x: initial.x,
    y: initial.y,
    width: initial.width,
    height: initial.height,
    minWidth: sizes[mode].minWidth,
    minHeight: sizes[mode].minHeight,
    show: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: pinned,
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

  // macOS：未实机验证。setVisibleOnAllWorkspaces 会切换进程类型并短暂隐藏窗口和 Dock，只在置顶真正变化时调用。
  let workspacesPinned: boolean | undefined;
  const applyPinned = () => {
    const profile = platformProfile(detectPlatform());
    if (pinned) win.setAlwaysOnTop(true, profile.alwaysOnTopLevel);
    else win.setAlwaysOnTop(false);
    if (!profile.visibleOnAllWorkspaces || workspacesPinned === pinned) return;
    workspacesPinned = pinned;
    if (pinned) win.setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: profile.visibleOnFullScreen});
    else win.setVisibleOnAllWorkspaces(false);
  };

  let applying = false;
  let shown = false;
  let requested = initial;
  let echo: Rect = {x: 0, y: 0, width: 0, height: 0};
  let applyToken = 0;

  const noteDisplay = () => {
    const display = screen.getDisplayMatching(state.bounds[mode]);
    state = {...state, mode, pinned, displayId: display.id, scaleFactor: display.scaleFactor};
  };

  const abnormal = () => win.isMinimized() || win.isMaximized() || win.isFullScreen();

  const persist = () => {
    if (win.isDestroyed()) return;
    try {
      if (abnormal()) {
        const normal = rememberResize(win.getNormalBounds(), echo);
        state = {...state, bounds: {...state.bounds, [mode]: normal}};
      }
      noteDisplay();
      saveWindowState(opts.stateFile, state);
    } catch (error) {
      console.error('Failed to save window state:', error instanceof Error ? error.message : error);
    }
  };

  let saveTimer: NodeJS.Timeout | undefined;
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      persist();
    }, SAVE_DELAY_MS);
  };
  const flushSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = undefined;
    persist();
  };

  const sameRect = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

  const measureEcho = () => {
    if (win.isDestroyed() || abnormal()) return;
    echo = boundsEcho(win.getBounds(), requested);
  };

  const remember = (kind: 'move' | 'resize') => {
    if (!shown || applying || win.isDestroyed() || abnormal()) return;
    const stored = state.bounds[mode];
    const next = kind === 'move' ? rememberMove(stored, win.getBounds(), echo) : rememberResize(win.getBounds(), echo);
    if (sameRect(next, stored)) return;
    state = {...state, bounds: {...state.bounds, [mode]: next}};
    scheduleSave();
  };

  const applyBounds = (rect: Rect) => {
    const token = ++applyToken;
    applying = true;
    try {
      win.setMinimumSize(sizes[mode].minWidth, sizes[mode].minHeight);
      win.setBounds(rect);
    } finally {
      applying = false;
    }
    requested = rect;
    state = {...state, bounds: {...state.bounds, [mode]: rect}};
    measureEcho();
    setTimeout(() => {
      if (token !== applyToken || win.isDestroyed() || !sameRect(state.bounds[mode], rect)) return;
      measureEcho();
    }, ECHO_MEASURE_DELAY_MS);
  };

  const refit = () => {
    if (win.isDestroyed()) return;
    const current = state.bounds[mode];
    const fitted = withMinimum(fitToDisplays(current, readDisplays(), screen.getPrimaryDisplay().id), mode);
    if (sameRect(fitted, current)) return;
    applyBounds(fitted);
    scheduleSave();
  };

  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;
    applyPinned();
    win.showInactive();
    measureEcho();
    shown = true;
    const token = ++applyToken;
    setTimeout(() => {
      if (token !== applyToken || win.isDestroyed() || !sameRect(state.bounds[mode], requested)) return;
      measureEcho();
      scheduleSave();
    }, ECHO_MEASURE_DELAY_MS);
  });
  win.on('move', () => remember('move'));
  win.on('resize', () => remember('resize'));
  win.on('close', flushSave);
  screen.on('display-removed', refit);
  screen.on('display-metrics-changed', refit);
  win.on('closed', () => {
    screen.removeListener('display-removed', refit);
    screen.removeListener('display-metrics-changed', refit);
  });
  win.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  win.webContents.on('will-navigate', event => {
    event.preventDefault();
  });
  const controller: MonitorWindowController = {
    getMode: () => mode,
    setMode(next) {
      if (next === mode) return mode;
      state = switchMode(state, next, state.bounds[mode]);
      mode = state.mode;
      const target = withMinimum(
        fitToDisplays(state.bounds[mode], readDisplays(), screen.getPrimaryDisplay().id),
        mode,
      );
      applyBounds(target);
      scheduleSave();
      return mode;
    },
    getPinned: () => pinned,
    setPinned(next) {
      if (next === pinned) return pinned;
      pinned = next;
      state = {...state, pinned};
      applyPinned();
      scheduleSave();
      return pinned;
    },
  };
  return {win, controller};
}

/** Load only after IPC handlers for this window are registered. */
export function loadMonitorWindow(win: BrowserWindow) {
  void win.loadFile(path.join(__dirname, 'renderer/index.html'));
}

import path from 'node:path';
import {app, BrowserWindow, screen} from 'electron';
import type {WindowMode} from '../ipc';
import {detectPlatform, platformProfile} from './platform';
import {
  defaultWindowState,
  fitToDisplays,
  loadWindowState,
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
// The WM reports an adjusted size just after show. Ignore that echo so a fractional
// scale factor cannot compound the saved rect on every launch.
const SHOW_SETTLE_MS = 250;
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

  const applyPinned = () => {
    const profile = platformProfile(detectPlatform());
    if (pinned) {
      win.setAlwaysOnTop(true, profile.alwaysOnTopLevel);
      // macOS：未实机验证。其他平台 profile.visibleOnAllWorkspaces 为 false，不会调用。
      if (profile.visibleOnAllWorkspaces) {
        win.setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: profile.visibleOnFullScreen});
      }
      return;
    }
    win.setAlwaysOnTop(false);
    if (profile.visibleOnAllWorkspaces) win.setVisibleOnAllWorkspaces(false);
  };

  // Linux X11 on this VM reports a fractional scale. setBounds(getBounds()) grows the
  // window, so geometry events caused by our own setBounds are ignored and the saved
  // rect stays the one we asked for. User moves still record getBounds.
  let applying = false;
  let shown = false;
  let ignoreGeometryUntil = 0;

  const noteDisplay = () => {
    const display = screen.getDisplayMatching(state.bounds[mode]);
    state = {...state, mode, pinned, displayId: display.id, scaleFactor: display.scaleFactor};
  };

  const persist = () => {
    if (win.isDestroyed()) return;
    try {
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

  const rememberUserBounds = () => {
    if (!shown || applying || Date.now() < ignoreGeometryUntil || win.isDestroyed()) return;
    const bounds = win.getBounds();
    state = {...state, bounds: {...state.bounds, [mode]: bounds}};
    scheduleSave();
  };

  const applyBounds = (rect: Rect) => {
    applying = true;
    ignoreGeometryUntil = Date.now() + SHOW_SETTLE_MS;
    try {
      win.setMinimumSize(sizes[mode].minWidth, sizes[mode].minHeight);
      win.setBounds(rect);
    } finally {
      applying = false;
    }
    state = {...state, bounds: {...state.bounds, [mode]: rect}};
  };

  const refit = () => {
    if (win.isDestroyed()) return;
    const fitted = withMinimum(fitToDisplays(win.getBounds(), readDisplays(), screen.getPrimaryDisplay().id), mode);
    applyBounds(fitted);
    scheduleSave();
  };

  applyPinned();
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;
    applyPinned();
    win.showInactive();
    setTimeout(() => {
      if (win.isDestroyed()) return;
      shown = true;
      scheduleSave();
    }, SHOW_SETTLE_MS);
  });
  win.on('move', rememberUserBounds);
  win.on('resize', rememberUserBounds);
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

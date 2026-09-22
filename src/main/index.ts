import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {app, session, type BrowserWindow} from 'electron';
import {resolveMonitorPaths} from '../paths';
import {EventStore} from '../store';
import {startServer} from '../server';
import {IPC, type Changed, type ReceiverStatus} from '../ipc';
import type {StoredEvent} from '../protocol';
import {detectPlatform} from './platform';
import {createMonitorWindow, type MonitorWindowController} from './window';
import {registerIpc} from './ipc-handlers';

const paths = resolveMonitorPaths();
app.setPath('userData', paths.electronProfileDir);

let win: BrowserWindow | undefined;
let closeServer: (() => Promise<void>) | undefined;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) win.showInactive();
  });
  app.on('window-all-closed', () => {
    app.quit();
  });
  app.on('before-quit', () => {
    void closeServer?.();
  });

  const startedAt = new Date().toISOString();
  void app.whenReady().then(async () => {
    let storageError: string | undefined;
    let listening = false;
    let url: string | undefined;
    let store: EventStore | undefined;
    try {
      store = new EventStore(paths.eventsDir);
    } catch (error) {
      storageError = error instanceof Error ? error.message : String(error);
    }
    if (store) {
      try {
        const started = await startServer(store, paths.sessionFile);
        closeServer = started.close;
        listening = true;
        url = started.session.url;
      } catch (error) {
        storageError = error instanceof Error ? error.message : String(error);
      }
    }
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false);
    });
    const created = createMonitorWindow({preload: path.join(__dirname, 'preload.cjs')});
    win = created.win;
    const controller: MonitorWindowController = created.controller;
    const getStatus = (): ReceiverStatus => ({
      listening,
      url,
      dataDir: paths.home,
      corruptLines: store?.corruptLines ?? 0,
      storageError,
      platform: detectPlatform(),
      mode: controller.getMode(),
      pinned: controller.getPinned(),
      startedAt,
    });
    if (!store) return;
    registerIpc({
      store,
      controller,
      getStatus,
      rendererUrl: pathToFileURL(path.join(__dirname, 'renderer/index.html')).href,
    });
    let timer: NodeJS.Timeout | undefined;
    let cursor = store.cursor;
    const runIds = new Set<string>();
    const flush = () => {
      timer = undefined;
      const change: Changed = {cursor, runIds: [...runIds]};
      runIds.clear();
      if (win && !win.isDestroyed()) win.webContents.send(IPC.changed, change);
    };
    store.on('event', (event: StoredEvent) => {
      cursor = event.cursor;
      runIds.add(event.run_id);
      if (timer) return;
      timer = setTimeout(flush, 50);
    });
  });
}

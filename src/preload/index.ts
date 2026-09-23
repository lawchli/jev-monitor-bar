import {contextBridge, ipcRenderer, type IpcRendererEvent} from 'electron';
import {IPC, type Changed, type MonitorBridge, type PageQuery, type WindowMode} from '../ipc';

const bridge = {
  snapshot: (runId?: string) => ipcRenderer.invoke(IPC.snapshot, runId),
  page: (query: PageQuery) => ipcRenderer.invoke(IPC.page, query),
  status: () => ipcRenderer.invoke(IPC.status),
  onChanged: (listener: (change: Changed) => void) => {
    const wrapped = (_event: IpcRendererEvent, change: Changed) => listener(change);
    ipcRenderer.on(IPC.changed, wrapped);
    return () => ipcRenderer.removeListener(IPC.changed, wrapped);
  },
  setMode: (mode: WindowMode) => ipcRenderer.invoke(IPC.setMode, mode),
  setPinned: (pinned: boolean) => ipcRenderer.invoke(IPC.setPinned, pinned),
} satisfies MonitorBridge;

contextBridge.exposeInMainWorld('monitor', bridge);

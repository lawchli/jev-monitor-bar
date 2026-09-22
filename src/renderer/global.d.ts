import type {MonitorBridge} from '../ipc';

declare global {
  interface Window {
    monitor: MonitorBridge;
  }
}

export {};

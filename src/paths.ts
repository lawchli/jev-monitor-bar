import os from 'node:os';
import path from 'node:path';

export interface MonitorPaths {
  home: string;
  eventsDir: string;
  sessionFile: string;
  windowStateFile: string;
  electronProfileDir: string;
}

export interface ResolveMonitorPathsOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  /** Injected so tests can resolve relative paths without the host process cwd. Defaults to `process.cwd()`. */
  cwd?: string;
}

const APP_DIR = 'jev-monitor-bar';

type PathApi = typeof path.posix;

function pathApiFor(platform: NodeJS.Platform): PathApi {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** Drop a trailing `pathApi.sep` so the result matches Python `normpath` (Node's `normalize` keeps it). */
function canonicalize(pathApi: PathApi, value: string): string {
  const normalized = pathApi.normalize(value);
  const root = pathApi.parse(normalized).root;
  let end = normalized;
  while (end.length > root.length && end.endsWith(pathApi.sep)) end = end.slice(0, -1);
  return end;
}

/** Join a relative input onto cwd. Avoid `path.resolve`, which would consult the host process cwd. */
function resolveInput(pathApi: PathApi, cwd: string, value: string): string {
  return canonicalize(pathApi, pathApi.isAbsolute(value) ? value : pathApi.join(cwd, value));
}

function nonEmpty(value: string | undefined): value is string {
  return Boolean(value);
}

export function resolveMonitorPaths(opts: ResolveMonitorPathsOptions = {}): MonitorPaths {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const homedir = opts.homedir ?? os.homedir();
  const cwd = opts.cwd ?? process.cwd();
  const pathApi = pathApiFor(platform);
  const home = resolveHome(pathApi, platform, env, homedir, cwd);
  const sessionFile = nonEmpty(env.JEV_MONITOR_SESSION)
    ? resolveInput(pathApi, cwd, env.JEV_MONITOR_SESSION)
    : canonicalize(pathApi, pathApi.join(home, 'session.json'));
  return {
    home,
    eventsDir: canonicalize(pathApi, pathApi.join(home, 'events')),
    sessionFile,
    windowStateFile: canonicalize(pathApi, pathApi.join(home, 'window-state.json')),
    electronProfileDir: canonicalize(pathApi, pathApi.join(home, 'electron-profile')),
  };
}

function resolveHome(
  pathApi: PathApi,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  homedir: string,
  cwd: string,
): string {
  if (nonEmpty(env.JEV_MONITOR_HOME)) return resolveInput(pathApi, cwd, env.JEV_MONITOR_HOME);
  // Windows：未实机验证
  if (platform === 'win32') {
    if (nonEmpty(env.LOCALAPPDATA)) return canonicalize(pathApi, pathApi.join(env.LOCALAPPDATA, APP_DIR));
    return canonicalize(pathApi, pathApi.join(homedir, 'AppData', 'Local', APP_DIR));
  }
  // macOS：未实机验证
  if (platform === 'darwin') {
    return canonicalize(pathApi, pathApi.join(homedir, 'Library', 'Application Support', APP_DIR));
  }
  // Linux 及其他：未实机验证。XDG_STATE_HOME 只在非空绝对路径时采用。
  if (nonEmpty(env.XDG_STATE_HOME) && pathApi.isAbsolute(env.XDG_STATE_HOME)) {
    return canonicalize(pathApi, pathApi.join(env.XDG_STATE_HOME, APP_DIR));
  }
  return canonicalize(pathApi, pathApi.join(homedir, '.local', 'state', APP_DIR));
}

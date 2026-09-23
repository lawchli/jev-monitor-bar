import fs from 'node:fs';
import path from 'node:path';
import {deleteFreshRuntime} from './fresh-runtime.mjs';

const DEV_RELATIVE = path.join('.runtime', 'dev');
const DEMO_RELATIVE = path.join('.runtime', 'demo');

function isAllowedRelative(relative) {
  if (process.platform === 'win32') {
    const folded = relative.toLowerCase();
    return folded === DEV_RELATIVE.toLowerCase() || folded === DEMO_RELATIVE.toLowerCase();
  }
  return relative === DEV_RELATIVE || relative === DEMO_RELATIVE;
}

function samePath(left, right) {
  return path.relative(path.resolve(left), path.resolve(right)) === '';
}

function linkStat(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

export function runtimeDirs(repoRoot) {
  const root = path.resolve(repoRoot);
  return {
    dev: path.resolve(root, DEV_RELATIVE),
    demo: path.resolve(root, DEMO_RELATIVE),
  };
}

export function applyLaunchEnv(env, {demo, repoRoot}) {
  const next = {...env};
  const dirs = runtimeDirs(repoRoot);
  if (demo) {
    next.JEV_MONITOR_HOME = dirs.demo;
    next.JEV_MONITOR_SESSION = path.join(dirs.demo, 'session.json');
    return next;
  }
  if (!next.JEV_MONITOR_HOME) next.JEV_MONITOR_HOME = dirs.dev;
  return next;
}

export function freshRuntimeTarget(env, {demo, repoRoot}) {
  const dirs = runtimeDirs(repoRoot);
  const target = demo ? dirs.demo : dirs.dev;
  const home = env.JEV_MONITOR_HOME ?? '';
  if (!samePath(target, home)) throw new Error(`refusing to delete ${home || '(empty home)'}`);
  return target;
}

export function removeFreshRuntime(repoRoot, target) {
  const root = path.resolve(repoRoot);
  const resolved = path.resolve(target);
  const relative = path.relative(root, resolved);
  if (!isAllowedRelative(relative)) throw new Error(`refusing to delete ${resolved}`);

  let cursor = root;
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    const stat = linkStat(cursor);
    if (!stat) return;
    if (stat.isSymbolicLink()) throw new Error(`refusing to delete through symlink ${cursor}`);
  }

  const realRoot = fs.realpathSync(root);
  const realTarget = fs.realpathSync(resolved);
  const expectedReal = path.resolve(realRoot, ...relative.split(path.sep));
  if (!samePath(expectedReal, realTarget)) throw new Error(`refusing to delete ${realTarget}`);

  deleteFreshRuntime(resolved, root);
}

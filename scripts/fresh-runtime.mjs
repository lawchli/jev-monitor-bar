import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(scriptDir, '..');

const RUNTIME_NAMES = ['dev', 'demo'];

function errorCode(error) {
  return error && typeof error === 'object' && 'code' in error ? error.code : undefined;
}

function refuse(candidate) {
  return new Error(`--fresh refuses to delete ${path.resolve(candidate)}`);
}

function stripTrailingSep(value) {
  const normalized = path.normalize(value);
  const root = path.parse(normalized).root;
  let end = normalized;
  while (end.length > root.length && end.endsWith(path.sep)) end = end.slice(0, -1);
  return end;
}

function samePath(left, right) {
  const a = stripTrailingSep(left);
  const b = stripTrailingSep(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function samePart(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export function launchHome(env, cwd = process.cwd()) {
  if (env.JEV_MONITOR_HOME) return path.resolve(cwd, env.JEV_MONITOR_HOME);
  return path.resolve(cwd, '.runtime', 'dev');
}

/** Lexical path under the repo. Parents may be realpath'd; `.runtime` itself is not followed. */
function runtimeTail(candidate, rootReal) {
  let current = path.resolve(candidate);
  const tail = [];
  const seen = new Set();
  while (!seen.has(current)) {
    seen.add(current);
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    tail.unshift(path.basename(current));
    try {
      if (samePath(fs.realpathSync(parent), rootReal)) return tail;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') return undefined;
    }
    current = parent;
  }
  return undefined;
}

function runtimeName(tail) {
  if (!tail || tail.length !== 2 || !samePart(tail[0], '.runtime')) return undefined;
  return RUNTIME_NAMES.find(name => samePart(tail[1], name));
}

/** True when `.runtime/<name>` is missing or is a real directory, and no component is a link. */
function staysOnRealPath(rootReal, name) {
  const parts = ['.runtime', name];
  let current = rootReal;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      return errorCode(error) === 'ENOENT';
    }
    if (stat.isSymbolicLink()) return false;
    try {
      if (!samePath(fs.realpathSync(current), current)) return false;
    } catch {
      return false;
    }
    if (index < parts.length - 1 && !stat.isDirectory()) return false;
  }
  return true;
}

/** Directory `--fresh` may delete: this repo's `.runtime/dev` or `.runtime/demo`, with no symlink in between. */
export function resolveFreshTarget(candidate, root = repoRoot) {
  let rootReal;
  try {
    rootReal = fs.realpathSync(root);
  } catch {
    throw refuse(candidate);
  }
  const name = runtimeName(runtimeTail(candidate, rootReal));
  if (!name || !staysOnRealPath(rootReal, name)) throw refuse(candidate);
  return path.join(rootReal, '.runtime', name);
}

export function deleteFreshRuntime(candidate, root = repoRoot) {
  const target = resolveFreshTarget(candidate, root);
  let rootReal;
  try {
    rootReal = fs.realpathSync(root);
  } catch {
    throw refuse(candidate);
  }
  const allowed = RUNTIME_NAMES.map(name => path.join(rootReal, '.runtime', name));
  if (!allowed.some(item => samePath(item, target))) throw refuse(candidate);
  fs.rmSync(target, {recursive: true, force: true});
  return target;
}

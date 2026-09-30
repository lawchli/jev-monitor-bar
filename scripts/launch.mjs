import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import path from 'node:path';
import {deleteFreshRuntime} from './fresh-runtime.mjs';
import {applyLaunchEnv, freshRuntimeTarget} from './runtime-fresh.mjs';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const demo = args.includes('--demo');
const fresh = args.includes('--fresh');
const repoRoot = path.resolve(import.meta.dirname, '..');

await import('./build.mjs');

const env = applyLaunchEnv(process.env, {demo, repoRoot});
const home = env.JEV_MONITOR_HOME;
if (fresh) {
  try {
    // Custom homes are refused before the single delete. That delete rejects
    // symlinks on the path, then checks realpath against this repo's dev/demo runtime.
    freshRuntimeTarget(env, {demo, repoRoot});
    deleteFreshRuntime(home, repoRoot);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

const electron = spawn(require('electron'), ['.'], {stdio: 'inherit', env});
let host;
if (demo) {
  host = spawn(process.execPath, [path.join(import.meta.dirname, 'demo-host.mjs')], {
    stdio: 'inherit',
    env,
  });
  host.on('exit', (code, signal) => {
    if (code || signal) electron.kill();
  });
}

electron.on('exit', (code, signal) => {
  if (host && host.exitCode === null) host.kill();
  if (signal) process.exit(1);
  process.exit(code ?? 1);
});

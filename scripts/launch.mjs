import {spawn} from 'node:child_process';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const demo = args.includes('--demo');
const fresh = args.includes('--fresh');

await import('./build.mjs');

const env = {...process.env};
if (demo) env.JEV_MONITOR_HOME = path.resolve('.runtime/demo');
else if (!env.JEV_MONITOR_HOME) env.JEV_MONITOR_HOME = path.resolve('.runtime/dev');
if (fresh) fs.rmSync(env.JEV_MONITOR_HOME, {recursive: true, force: true});

const electron = spawn(require('electron'), ['.'], {stdio: 'inherit', env});
let host;
if (demo) {
  host = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'demo-host.mjs')], {
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

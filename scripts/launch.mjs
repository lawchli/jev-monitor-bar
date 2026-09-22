import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
await import('./build.mjs');

const env = {...process.env};
if (!env.JEV_MONITOR_HOME) env.JEV_MONITOR_HOME = path.resolve('.runtime/dev');

const child = spawn(require('electron'), ['.'], {stdio: 'inherit', env});
child.on('exit', (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 1);
});

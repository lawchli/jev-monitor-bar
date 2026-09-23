import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {deleteFreshRuntime, launchHome, repoRoot} from './fresh-runtime.mjs';

const require = createRequire(import.meta.url);
const env = {...process.env};
const home = launchHome(env);
if (!env.JEV_MONITOR_HOME) env.JEV_MONITOR_HOME = home;
if (process.argv.slice(2).includes('--fresh')) {
  try {
    deleteFreshRuntime(home, repoRoot);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

await import('./build.mjs');

const child = spawn(require('electron'), ['.'], {stdio: 'inherit', env});
child.on('exit', (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 1);
});

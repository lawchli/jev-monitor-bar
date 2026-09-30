// 在当前主机上实际启动 release/ 里的发布包，确认 fuses 与 asar 完整性在运行时生效：
// ELECTRON_RUN_AS_NODE、NODE_OPTIONS、--inspect 都不起作用；改动 app.asar 里 main.cjs 的一个字节后应用拒绝启动。
// 只能测与主机同平台的包（先 pnpm package）。用法：pnpm package:runtime [--platform p] [--arch a]
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {getRawHeader, statFile} from '@electron/asar';
import {parseTarget, releaseNames} from './package-config.mjs';

const root = path.resolve(import.meta.dirname, '..');
const target = parseTarget(process.argv.slice(2));
if (target.platform !== process.platform) {
  console.error(`package:runtime 只能在同平台主机上跑：目标 ${target.platform}，主机 ${process.platform}`);
  process.exit(2);
}
const {version} = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const names = releaseNames({version, ...target});
const releaseDir = path.join(root, 'release', names.dirName);
if (!fs.existsSync(path.join(releaseDir, names.executable))) {
  console.error(`没有找到 ${path.relative(root, path.join(releaseDir, names.executable))}，先运行 pnpm package`);
  process.exit(2);
}
// 只清理仓库内自己的目录。
const work = path.join(root, '.runtime', 'package-runtime', `${target.platform}-${target.arch}`);
fs.rmSync(work, {recursive: true, force: true});
fs.mkdirSync(work, {recursive: true});

const READY_MS = 20000;
const results = [];
const record = (name, ok, detail) => {
  results.push({name, ok, detail});
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
};

function launch(dir, name, {args = [], env = {}} = {}) {
  const home = path.join(work, name, 'home');
  fs.mkdirSync(home, {recursive: true});
  const child = spawn(path.join(dir, names.executable), args, {
    env: {...process.env, JEV_MONITOR_HOME: home, JEV_MONITOR_SESSION: '', ...env},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => (output += chunk));
  child.stderr.on('data', chunk => (output += chunk));
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({code, signal})));
  child.once('error', error => (output += `\nspawn error: ${error.message}`));
  return {child, exited, home, sessionFile: path.join(home, 'session.json'), output: () => output};
}

async function waitFor(predicate, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return predicate();
}

async function stop(app) {
  if (app.child.exitCode !== null || app.child.signalCode !== null) return;
  app.child.kill();
  const done = await Promise.race([app.exited, new Promise(resolve => setTimeout(() => resolve(null), 5000))]);
  if (!done) app.child.kill('SIGKILL');
  await app.exited;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const {port} = server.address();
      server.close(() => resolve(port));
    });
  });
}

function canConnect(port) {
  return new Promise(resolve => {
    const socket = net.connect({host: '127.0.0.1', port});
    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}

/** 打开 fuse 时，这个进程会作为 Node 执行 -e 并写 marker；关掉时照常启动应用、写出会话文件。 */
async function checkRunAsNode() {
  const marker = path.join(work, 'run-as-node.marker');
  const app = launch(releaseDir, 'run-as-node', {
    args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`],
    env: {ELECTRON_RUN_AS_NODE: '1'},
  });
  const ready = await waitFor(() => fs.existsSync(app.sessionFile), READY_MS);
  await stop(app);
  const ran = fs.existsSync(marker);
  record('ELECTRON_RUN_AS_NODE ignored', ready && !ran, ran ? 'ran -e as Node' : ready ? '' : 'app did not start');
}

async function checkNodeOptions() {
  const marker = path.join(work, 'node-options.marker');
  const script = path.join(work, 'node-options.cjs');
  fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x');\n`);
  const app = launch(releaseDir, 'node-options', {env: {NODE_OPTIONS: `--require ${JSON.stringify(script)}`}});
  const ready = await waitFor(() => fs.existsSync(app.sessionFile), READY_MS);
  await stop(app);
  const ran = fs.existsSync(marker);
  record('NODE_OPTIONS ignored', ready && !ran, ran ? 'NODE_OPTIONS --require ran' : ready ? '' : 'app did not start');
}

async function checkInspect() {
  const port = await freePort();
  const app = launch(releaseDir, 'inspect', {args: [`--inspect=127.0.0.1:${port}`]});
  const ready = await waitFor(() => fs.existsSync(app.sessionFile), READY_MS);
  const open = ready && (await canConnect(port));
  await stop(app);
  const listening = /Debugger listening/.test(app.output());
  record(
    '--inspect ignored',
    ready && !open && !listening,
    open || listening ? `inspector on ${port}` : ready ? '' : 'app did not start',
  );
}

/** 改 main.cjs 中间的一个字节。启用 asar 完整性校验时，应用应在接收端起来之前退出。 */
async function checkAsarTamper() {
  const copy = path.join(work, 'tampered', names.dirName);
  fs.cpSync(releaseDir, copy, {recursive: true, verbatimSymlinks: true});
  const asarPath = path.join(copy, names.resources, 'app.asar');
  const {headerSize} = getRawHeader(asarPath);
  const entry = statFile(asarPath, 'dist/main.cjs');
  const position = 8 + headerSize + Number(entry.offset) + Math.floor(entry.size / 2);
  const fd = fs.openSync(asarPath, 'r+');
  try {
    const byte = Buffer.alloc(1);
    fs.readSync(fd, byte, 0, 1, position);
    byte[0] ^= 0x20;
    fs.writeSync(fd, byte, 0, 1, position);
  } finally {
    fs.closeSync(fd);
  }
  const app = launch(copy, 'tampered');
  const exited = await Promise.race([app.exited, new Promise(resolve => setTimeout(() => resolve(null), READY_MS))]);
  const started = fs.existsSync(app.sessionFile);
  await stop(app);
  record(
    'tampered app.asar refused',
    Boolean(exited) && !started,
    started ? 'receiver started' : exited ? `exit ${exited.code ?? exited.signal}` : 'still running',
  );
}

console.log(`package:runtime ${names.dirName}（主机 ${process.platform}-${process.arch}）`);
await checkRunAsNode();
await checkNodeOptions();
await checkInspect();
await checkAsarTamper();
fs.writeFileSync(path.join(work, 'report.json'), `${JSON.stringify({target, version, results}, null, 2)}\n`);
const failed = results.filter(result => !result.ok);
console.log(failed.length ? `\n${failed.length} 项失败` : `\n全部 ${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);

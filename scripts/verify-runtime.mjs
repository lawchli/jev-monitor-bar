// 在当前主机上实际启动 release/ 里的发布包，确认 fuses 与 asar 完整性在运行时生效：
// ELECTRON_RUN_AS_NODE、NODE_OPTIONS、--inspect 都不起作用；app:// 正常渲染且 file:// 无法读取 ASAR；
// 改动 app.asar 里 main.cjs 的一个字节后应用拒绝启动。
// 只能测与主机同平台的包（先 pnpm package）。用法：pnpm package:runtime [--platform p] [--arch a]
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {getRawHeader, statFile} from '@electron/asar';
import {chromium} from 'playwright';
import {parseTarget, releaseNames} from './package-config.mjs';
import {RENDERER_URL} from './smoke-lib.mjs';
import {harmlessMainTamper, integrityRejected, supportsAsarIntegrity} from './runtime-integrity.mjs';

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
const skip = (name, detail) => {
  results.push({name, ok: null, skipped: true, detail});
  console.log(`  skip ${name} (${detail})`);
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

/** Verify the release renderer works while the disabled file:// privilege no longer reads inside ASAR. */
async function checkFileProtocol() {
  const app = launch(releaseDir, 'file-protocol', {args: ['--remote-debugging-port=0']});
  const endpointPattern = /DevTools listening on (ws:\/\/\S+)/;
  let browser;
  let ok = false;
  let detail = '';
  try {
    if (!(await waitFor(() => endpointPattern.test(app.output()), READY_MS))) throw new Error('no DevTools endpoint');
    browser = await chromium.connectOverCDP(endpointPattern.exec(app.output())[1], {timeout: READY_MS});
    const context = browser.contexts()[0];
    let page;
    await waitFor(() => (page = context.pages().find(item => item.url() === RENDERER_URL)), READY_MS);
    if (!page) throw new Error(`renderer is not at ${RENDERER_URL}: ${context.pages().map(item => item.url())}`);
    await page.locator('#app-root').waitFor({timeout: READY_MS});
    const asarIndex = pathToFileURL(
      path.join(releaseDir, names.resources, 'app.asar', 'dist', 'renderer', 'index.html'),
    );
    try {
      await page.goto(asarIndex.href, {timeout: 10_000});
      detail = `file:// loaded ${page.url()}`;
    } catch (error) {
      const reason = (error instanceof Error ? error.message : String(error)).split('\n')[0];
      ok = reason.includes('ERR_FILE_NOT_FOUND');
      detail = ok ? `renderer at ${RENDERER_URL}; file:// into app.asar: ERR_FILE_NOT_FOUND` : reason;
    }
  } catch (error) {
    detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
  } finally {
    await browser?.close().catch(() => {});
    await stop(app);
  }
  record('renderer on app://, file:// cannot read app.asar', ok, detail);
}

/** 只改 main.cjs 注释中的合法字母，并要求明确的完整性错误；不能把语法错误算作校验生效。 */
async function checkAsarTamper() {
  if (!supportsAsarIntegrity(target.platform)) {
    skip('tampered app.asar refused', 'Electron ASAR integrity is supported on Windows/macOS, not Linux');
    return;
  }
  const copy = path.join(work, 'tampered', names.dirName);
  fs.cpSync(releaseDir, copy, {recursive: true, verbatimSymlinks: true});
  const asarPath = path.join(copy, names.resources, 'app.asar');
  const {headerSize} = getRawHeader(asarPath);
  const entry = statFile(asarPath, 'dist/main.cjs');
  const start = 8 + headerSize + Number(entry.offset);
  const fd = fs.openSync(asarPath, 'r+');
  try {
    const source = Buffer.alloc(entry.size);
    let read = 0;
    while (read < source.length) {
      const count = fs.readSync(fd, source, read, source.length - read, start + read);
      if (count <= 0) throw new Error('Incomplete main.cjs read for integrity probe');
      read += count;
    }
    const tamper = harmlessMainTamper(source);
    fs.writeSync(fd, Buffer.from([tamper.after]), 0, 1, start + tamper.offset);
  } finally {
    fs.closeSync(fd);
  }
  const app = launch(copy, 'tampered');
  const exited = await Promise.race([app.exited, new Promise(resolve => setTimeout(() => resolve(null), READY_MS))]);
  const started = fs.existsSync(app.sessionFile);
  await stop(app);
  record(
    'tampered app.asar refused',
    integrityRejected({exited, started, output: app.output()}),
    started
      ? 'receiver started'
      : exited
        ? `exit ${exited.code ?? exited.signal}; ${app.output().slice(-1500)}`
        : 'still running',
  );
}

console.log(`package:runtime ${names.dirName}（主机 ${process.platform}-${process.arch}）`);
await checkRunAsNode();
await checkNodeOptions();
await checkInspect();
await checkFileProtocol();
await checkAsarTamper();
fs.writeFileSync(path.join(work, 'report.json'), `${JSON.stringify({target, version, results}, null, 2)}\n`);
const failed = results.filter(result => result.ok === false);
const passed = results.filter(result => result.ok === true).length;
const skipped = results.filter(result => result.skipped).length;
console.log(failed.length ? `\n${failed.length} 项失败` : `\n通过 ${passed} 项，跳过 ${skipped} 项`);
process.exit(failed.length ? 1 : 0);

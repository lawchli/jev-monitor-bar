// 桌面冒烟测试：启动真实窗口，经 HTTP 写入事件，检查紧凑条、展开视图、导出回放、窗口属性与可见延迟。
// 用法见 `pnpm smoke --help`。结果写到 .runtime/smoke/<platform>-<arch>/report.json，任一断言失败时退出码非零。
// 这里的截屏、系统探针只在测试进程里执行；应用本身不含这些代码。
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {_electron, chromium} from 'playwright';
import * as lib from './smoke-lib.mjs';
import * as native from './smoke-native.mjs';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const message = error => (error instanceof Error ? error.message : String(error));

let options;
try {
  options = lib.parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(message(error));
  console.error(lib.helpText());
  process.exit(2);
}
if (options.help) {
  console.log(lib.helpText());
  process.exit(0);
}

const tag = lib.platformTag(process.platform, process.arch);
const outDir = freshOutDir(tag);
const home = path.join(outDir, 'home');
const sessionFile = path.join(home, 'session.json');
const exportFile = path.join(outDir, 'export.jsonl');
const appLog = [];
const assertions = [];
const screenshots = [];
const nativeResults = {requested: options.native, supported: native.nativeSupported()};
const startedAt = new Date().toISOString();
/** run() 边走边填，失败时报告里仍有已经拿到的部分。 */
const collected = {};
let activeDriver;

function freshOutDir(name) {
  const base = path.join(repoRoot, '.runtime', 'smoke');
  for (const dir of [path.join(repoRoot, '.runtime'), base, path.join(base, name)]) {
    try {
      if (fs.lstatSync(dir).isSymbolicLink()) throw new Error(`${dir} 是符号链接，拒绝清理`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const out = path.join(base, name);
  fs.rmSync(out, {recursive: true, force: true});
  fs.mkdirSync(out, {recursive: true});
  return out;
}

function log(line) {
  console.log(`[smoke] ${line}`);
}

function record(item) {
  assertions.push(item);
  const mark = item.status === 'passed' ? 'ok  ' : item.status === 'skipped' ? 'skip' : 'FAIL';
  let extra = '';
  if (item.status === 'skipped') extra = ` （${item.reason}）`;
  else if (item.status === 'failed' && item.details !== undefined)
    extra = ` ${item.details.error ?? JSON.stringify(item.details).slice(0, 600)}`;
  log(`${mark} ${item.name}${extra}`);
  return item.status === 'passed';
}

function check(name, ok, details) {
  return record(lib.assertion(name, Boolean(ok), details));
}

function skip(name, reason) {
  record(lib.skipped(name, reason));
}

/** 一步失败只记这一步，后面不依赖它的步骤照常执行。 */
async function step(name, fn) {
  try {
    return await fn();
  } catch (error) {
    record(lib.assertion(name, false, {error: message(error)}));
    return undefined;
  }
}

async function poll(fn, what, timeout = 10_000, interval = 50) {
  const deadline = Date.now() + timeout;
  let lastError;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() > deadline) throw new Error(`等待超时：${what}${lastError ? `（${message(lastError)}）` : ''}`);
    await sleep(interval);
  }
}

function appEnv() {
  const env = {...process.env, JEV_MONITOR_HOME: home, JEV_MONITOR_SESSION: sessionFile};
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  return env;
}

function resolveExecutable(appPath) {
  const full = path.resolve(appPath);
  const stat = fs.statSync(full);
  if (stat.isDirectory() && full.endsWith('.app')) {
    const dir = path.join(full, 'Contents', 'MacOS');
    const entries = fs.readdirSync(dir);
    if (entries.length !== 1) throw new Error(`${dir} 里应只有一个可执行文件`);
    return path.join(dir, entries[0]);
  }
  if (!stat.isFile()) throw new Error(`${full} 不是可执行文件`);
  return full;
}

function captureOutput(stream) {
  stream?.setEncoding('utf8');
  stream?.on('data', chunk => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line) continue;
      appLog.push(line);
      if (appLog.length > 2000) appLog.shift();
    }
  });
}

async function launchElectron(executablePath, args) {
  const app = await _electron.launch({executablePath, args, env: appEnv(), cwd: repoRoot, timeout: 30_000});
  captureOutput(app.process().stdout);
  captureOutput(app.process().stderr);
  const page = await app.firstWindow({timeout: 30_000});
  const mainPid = await app.evaluate(() => process.pid);
  return {
    kind: 'electron',
    app,
    page,
    mainPid,
    async close() {
      await app.close();
    },
    kill() {
      app.process().kill();
    },
  };
}

async function launchCdp(executablePath, args) {
  // Linux 上与 Playwright 的 _electron 一致，加 --no-sandbox（CI 容器通常不允许 Chromium 沙箱）。
  const extra = process.platform === 'linux' ? ['--no-sandbox'] : [];
  const child = spawn(executablePath, [...extra, ...args, '--remote-debugging-port=0'], {
    env: appEnv(),
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  captureOutput(child.stdout);
  captureOutput(child.stderr);
  let browser;
  let page;
  try {
    const endpoint = await poll(
      () => {
        if (child.exitCode !== null) throw new Error(`应用提前退出，退出码 ${child.exitCode}`);
        for (const line of appLog) {
          const match = line.match(/DevTools listening on (ws:\/\/\S+)/);
          if (match) return match[1];
        }
        return undefined;
      },
      'DevTools 端口',
      30_000,
    );
    browser = await chromium.connectOverCDP(endpoint, {timeout: 30_000});
    const context = browser.contexts()[0];
    page = await poll(() => context.pages().find(item => item.url().startsWith('file:')), '渲染页面', 30_000);
  } catch (error) {
    child.kill();
    throw error;
  }
  return {
    kind: 'cdp',
    browser,
    page,
    child,
    // 直接启动、不经 shell，子进程就是主进程。
    mainPid: child.pid,
    async close() {
      // 关掉唯一的窗口后应用按 window-all-closed 正常退出，会话文件由应用自己删除。
      await page.evaluate(() => window.close()).catch(() => {});
      const exited = await poll(() => child.exitCode !== null, '应用退出', 10_000).catch(() => false);
      if (!exited) child.kill();
      await browser.close().catch(() => {});
    },
    kill() {
      child.kill();
    },
  };
}

/** macOS 的 fuse 在 Electron Framework 里，Windows / Linux 在可执行文件本身。 */
function fuseFile(executable) {
  const framework = path.join(
    path.dirname(path.dirname(executable)),
    'Frameworks',
    'Electron Framework.framework',
    'Electron Framework',
  );
  if (path.basename(path.dirname(executable)) === 'MacOS' && fs.existsSync(framework)) return framework;
  return executable;
}

/** 分块查找 fuse 标记，不把整个二进制读进内存。 */
function readFuses(executable) {
  const file = fuseFile(executable);
  const fd = fs.openSync(file, 'r');
  try {
    const size = 8 * 1024 * 1024;
    let carry = Buffer.alloc(0);
    let position = 0;
    for (;;) {
      const buffer = Buffer.alloc(size);
      const read = fs.readSync(fd, buffer, 0, size, position);
      if (read === 0) return {file, found: false};
      position += read;
      const window = Buffer.concat([carry, buffer.subarray(0, read)]);
      const parsed = lib.parseFuseWire(window);
      if (parsed) return {file, found: true, ...parsed};
      carry = window.subarray(Math.max(0, window.length - 64));
    }
  } finally {
    fs.closeSync(fd);
  }
}

// Playwright 的 _electron.launch 超时后，内部还有几个等待输出的 promise 没人接，会变成 unhandledRejection。
// 只在尝试 _electron 失败、改用 CDP 的那段时间里忽略这些 TimeoutError。
let ignoreLaunchTimeouts = false;
process.on('unhandledRejection', error => {
  if (ignoreLaunchTimeouts && error instanceof Error && error.name === 'TimeoutError') return;
  record(lib.assertion('unhandledRejection', false, {error: message(error)}));
});

let fuses;
async function launch() {
  if (!options.app) {
    if (options.build) await import('./build.mjs');
    if (!fs.existsSync(path.join(repoRoot, 'dist', 'main.cjs'))) throw new Error('缺少 dist/main.cjs，请先 pnpm build');
    const electronPath = require('electron');
    if (options.driver === 'cdp') return launchCdp(electronPath, [repoRoot]);
    return launchElectron(electronPath, [repoRoot]);
  }
  const executable = resolveExecutable(options.app);
  try {
    fuses = readFuses(executable);
  } catch (error) {
    fuses = {error: message(error)};
  }
  if (options.driver === 'cdp') return launchCdp(executable, []);
  if (options.driver === 'electron') return launchElectron(executable, []);
  // 发布包用 fuses 关掉 --inspect 后，Playwright 连不上主进程，只能改用 CDP 连渲染进程。
  if (fuses?.fuses?.enableNodeCliInspectArguments === false) {
    log('发布包已关闭 --inspect（fuse），改用 CDP 连渲染进程');
    return launchCdp(executable, []);
  }
  ignoreLaunchTimeouts = true;
  try {
    return await launchElectron(executable, []);
  } catch (error) {
    log(`Playwright _electron 启动失败，改用 CDP：${message(error).split('\n')[0]}`);
    await sleep(1000);
    return await launchCdp(executable, []);
  } finally {
    ignoreLaunchTimeouts = false;
  }
}

async function mainWindowInfo(driver) {
  if (driver.kind !== 'electron') return undefined;
  return driver.app.evaluate(({BrowserWindow, screen}) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win || win.isDestroyed()) return undefined;
    const prefs = win.webContents.getLastWebPreferences() ?? {};
    return {
      visible: win.isVisible(),
      focused: win.isFocused(),
      anyWindowFocused: BrowserWindow.getFocusedWindow() !== null,
      alwaysOnTop: win.isAlwaysOnTop(),
      resizable: win.isResizable(),
      visibleOnAllWorkspaces: win.isVisibleOnAllWorkspaces(),
      title: win.getTitle(),
      bounds: win.getBounds(),
      contentBounds: win.getContentBounds(),
      minimumSize: win.getMinimumSize(),
      webPreferences: {
        contextIsolation: prefs.contextIsolation,
        sandbox: prefs.sandbox,
        nodeIntegration: prefs.nodeIntegration,
        nodeIntegrationInWorker: prefs.nodeIntegrationInWorker,
        webSecurity: prefs.webSecurity,
      },
      displays: screen.getAllDisplays().map(display => ({
        id: display.id,
        bounds: display.bounds,
        workArea: display.workArea,
        scaleFactor: display.scaleFactor,
      })),
      primaryDisplayId: screen.getPrimaryDisplay().id,
    };
  });
}

/** 渲染进程能看到的窗口信息；CDP 模式只能靠它。 */
async function rendererWindowInfo(page) {
  return page.evaluate(() => ({
    bounds: {x: window.screenX, y: window.screenY, width: window.outerWidth, height: window.outerHeight},
    workArea: {x: screen.availLeft, y: screen.availTop, width: screen.availWidth, height: screen.availHeight},
    devicePixelRatio: window.devicePixelRatio,
    requireType: typeof globalThis.require,
    processType: typeof globalThis.process,
    bridge: typeof window.monitor === 'object' && window.monitor !== null,
    mode: document.getElementById('app-root')?.dataset.mode,
  }));
}

async function windowBounds(driver) {
  const info = await mainWindowInfo(driver);
  if (info) return {bounds: info.bounds, displays: info.displays};
  const renderer = await rendererWindowInfo(driver.page);
  return {bounds: renderer.bounds, displays: [{id: 0, workArea: renderer.workArea}]};
}

async function nativeSnapshot(driver, expected) {
  if (!options.native || !nativeResults.supported) return undefined;
  let hwnd;
  if (process.platform === 'win32' && driver.kind === 'electron') {
    hwnd = await driver.app.evaluate(({BrowserWindow}) => {
      const handle = BrowserWindow.getAllWindows()[0]?.getNativeWindowHandle();
      if (!handle) return undefined;
      return handle.length >= 8 ? handle.readBigUInt64LE(0).toString() : String(handle.readUInt32LE(0));
    });
  }
  return native.probe({pid: driver.mainPid, hwnd, expected});
}

function readSession() {
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    const url = new URL(parsed.url);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || typeof parsed.token !== 'string') return undefined;
    return {url: url.origin, token: parsed.token};
  } catch {
    return undefined;
  }
}

async function waitSession() {
  return poll(
    async () => {
      const session = readSession();
      if (!session) return undefined;
      const response = await fetch(`${session.url}/health`, {
        headers: {authorization: `Bearer ${session.token}`},
        redirect: 'manual',
        signal: AbortSignal.timeout(2000),
      });
      await response.body?.cancel();
      return response.ok ? session : undefined;
    },
    '会话文件与 /health',
    30_000,
    100,
  );
}

async function post(session, event) {
  const response = await fetch(`${session.url}/events`, {
    method: 'POST',
    headers: {'content-type': 'application/json', authorization: `Bearer ${session.token}`},
    body: JSON.stringify(event),
    redirect: 'manual',
    signal: AbortSignal.timeout(5000),
  });
  let body;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return {status: response.status, accepted: response.status === 200 && body?.accepted === true, cursor: body?.cursor};
}

async function postAll(session, events) {
  const results = [];
  for (const event of events) results.push(await post(session, event));
  const rejected = results.filter(result => !result.accepted);
  if (rejected.length > 0) throw new Error(`${rejected.length} 条事件未被接收：${JSON.stringify(rejected[0])}`);
  return results;
}

function runDemoHost() {
  return new Promise(resolve => {
    const child = spawn(
      process.execPath,
      [path.join(repoRoot, 'scripts', 'demo-host.mjs'), '--once', '--fast', '--home', home],
      {env: appEnv(), cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe']},
    );
    let output = '';
    child.stdout.on('data', chunk => (output += chunk));
    child.stderr.on('data', chunk => (output += chunk));
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on('exit', code => {
      clearTimeout(timer);
      resolve({code, output: output.trim()});
    });
  });
}

function readReceivedAt() {
  const received = new Map();
  const dir = path.join(home, 'events');
  for (const name of fs.readdirSync(dir).filter(item => item.endsWith('.jsonl'))) {
    for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split(/\r?\n/)) {
      if (!line) continue;
      try {
        const row = JSON.parse(line);
        received.set(row.event_id, Date.parse(row.received_at));
      } catch {
        // 损坏行不影响延迟统计。
      }
    }
  }
  return received;
}

async function screenshot(page, name) {
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({path: file});
  screenshots.push(path.relative(repoRoot, file));
  return file;
}

function installLatencyObserver(source) {
  if (window.__smokeLatency) return;
  const pattern = new RegExp(source, 'g');
  const state = {dom: {}, visible: {}, frameFallbacks: 0};
  window.__smokeLatency = state;
  const afterFrames = marker => {
    let done = false;
    const finish = fallback => {
      if (done) return;
      done = true;
      state.visible[marker] = Date.now();
      if (fallback) state.frameFallbacks += 1;
    };
    requestAnimationFrame(() => requestAnimationFrame(() => finish(false)));
    setTimeout(() => finish(true), 1000);
  };
  const scan = () => {
    const now = Date.now();
    const text = document.body ? document.body.innerText : '';
    for (const match of text.matchAll(pattern)) {
      if (state.dom[match[0]] !== undefined) continue;
      state.dom[match[0]] = now;
      afterFrames(match[0]);
    }
  };
  new MutationObserver(scan).observe(document.body, {subtree: true, childList: true, characterData: true});
  scan();
}

async function measureLatency(page, session) {
  const runId = `smoke-latency-${Date.now().toString(36)}`;
  const event = lib.createRun(runId, `smoke-${process.pid}-latency`);
  await page.evaluate(installLatencyObserver, lib.markerSource);
  await postAll(session, [event('run.started', {name: '冒烟：可见延迟', simulated: true})]);
  await poll(
    async () => (await page.getByTestId('compact-run-name').getAttribute('title')) === '冒烟：可见延迟',
    '延迟测试 run 出现在紧凑条',
  );
  const samples = [];
  let lastStart = 0;
  for (let index = 1; index <= options.latencyCount; index += 1) {
    const marker = lib.latencyMarker(index);
    const wait = lastStart + options.latencyIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    const item = event('progress.updated', {phase: marker, completed: index, total: options.latencyCount});
    const postStart = Date.now();
    lastStart = postStart;
    const result = await post(session, item);
    const postEnd = Date.now();
    samples.push({marker, eventId: item.event_id, postStart, postEnd, accepted: result.accepted});
    if (!result.accepted) continue;
    await page
      .waitForFunction(value => window.__smokeLatency.visible[value] !== undefined, marker, {
        timeout: options.latencyTimeoutMs,
        polling: 'raf',
      })
      .catch(() => {});
  }
  await postAll(session, [event('run.completed', {})]);
  const state = await page.evaluate(() => window.__smokeLatency);
  const received = readReceivedAt();
  for (const sample of samples) {
    sample.domAt = state.dom[sample.marker];
    sample.visibleAt = state.visible[sample.marker];
    sample.receivedAt = received.get(sample.eventId);
  }
  const stats = lib.latencyStats(samples);
  return {
    ...stats,
    rejected: samples.filter(sample => !sample.accepted).length,
    frameFallbacks: state.frameFallbacks,
    intervalMs: options.latencyIntervalMs,
    timeoutMs: options.latencyTimeoutMs,
    view: 'compact',
    element: '紧凑条第二行「阶段 · 进度 · 运行时长」',
    method: lib.latencyMethod,
    samples: samples.map(sample => ({
      marker: sample.marker,
      postToVisible: Number.isFinite(sample.visibleAt) ? sample.visibleAt - sample.postStart : null,
      receivedToVisible:
        Number.isFinite(sample.visibleAt) && Number.isFinite(sample.receivedAt)
          ? sample.visibleAt - sample.receivedAt
          : null,
      postToDom: Number.isFinite(sample.domAt) ? sample.domAt - sample.postStart : null,
    })),
  };
}

async function environmentInfo(driver) {
  const info = {
    platform: process.platform,
    arch: process.arch,
    osType: os.type(),
    osRelease: os.release(),
    osVersion: typeof os.version === 'function' ? os.version() : undefined,
    cpu: os.cpus()[0]?.model,
    cpuCount: os.cpus().length,
    totalMemoryMiB: Math.round(os.totalmem() / 1024 / 1024),
    node: process.version,
    playwright: require('playwright/package.json').version,
  };
  if (driver?.kind === 'electron') {
    Object.assign(
      info,
      await driver.app.evaluate(() => ({
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        systemVersion: process.getSystemVersion(),
      })),
    );
  } else if (driver) {
    info.userAgent = await driver.page.evaluate(() => navigator.userAgent);
  }
  return info;
}

async function selectedStatus(root) {
  return (await root.locator('.summary-bar').innerText()).split('\n')[0];
}

async function liveKeyState(root) {
  return {
    name: await root.locator('h1.run-name').getAttribute('title'),
    status: await selectedStatus(root),
    chain: await root.getByTestId('decision-chain').first().innerText(),
  };
}

async function run() {
  const fixtures = lib.fixtureExpectations(
    JSON.parse(fs.readFileSync(path.join(repoRoot, 'fixtures', 'scenarios', 'index.json'), 'utf8')),
    file => fs.readFileSync(path.join(repoRoot, 'fixtures', 'scenarios', file), 'utf8').split(/\r?\n/)[0],
  );
  const frontBefore =
    options.native && nativeResults.supported
      ? await step('native.before', async () => (await native.probe()).frontmost)
      : undefined;
  nativeResults.frontmostBefore = frontBefore;

  const driver = await launch();
  activeDriver = driver;
  collected.driver = driver.kind;
  log(`已启动（${driver.kind}），主进程 pid ${driver.mainPid}`);
  const {page} = driver;
  collected.environment = await step('environment', () => environmentInfo(driver));
  await page.locator('#app-root').waitFor({timeout: 30_000});

  // 1. 刚启动时的窗口属性。
  let launchInfo;
  if (driver.kind === 'electron') {
    launchInfo = await step('window.visible', async () => {
      await poll(async () => (await mainWindowInfo(driver))?.visible, '窗口显示', 30_000);
      // window.ts 在 show 之后 250 ms 再量一次边框偏移，等它结束。
      await sleep(600);
      return mainWindowInfo(driver);
    });
  }
  const rendererInfo = await rendererWindowInfo(page);
  collected.launchInfo = launchInfo;
  collected.rendererInfo = rendererInfo;
  if (launchInfo) {
    check('window.visible', launchInfo.visible);
    check('window.alwaysOnTop', launchInfo.alwaysOnTop, {value: launchInfo.alwaysOnTop});
    check('window.notFocusedAfterLaunch', !launchInfo.focused && !launchInfo.anyWindowFocused, {
      focused: launchInfo.focused,
      anyWindowFocused: launchInfo.anyWindowFocused,
    });
    check('window.insideWorkArea', lib.insideSomeWorkArea(launchInfo.bounds, launchInfo.displays), {
      bounds: launchInfo.bounds,
      displays: launchInfo.displays,
    });
    const prefs = launchInfo.webPreferences;
    check(
      'window.webPreferences',
      prefs.contextIsolation === true && prefs.sandbox === true && prefs.nodeIntegration === false,
      {webPreferences: prefs},
    );
    check('window.resizable', launchInfo.resizable);
    check(
      'window.compactWidth',
      launchInfo.bounds.width >= lib.COMPACT_WIDTH.min && launchInfo.bounds.width <= lib.COMPACT_WIDTH.max,
      {width: launchInfo.bounds.width},
    );
    check('window.title', launchInfo.title === 'JEV Monitor Bar', {title: launchInfo.title});
  } else if (driver.kind === 'cdp') {
    for (const name of ['window.alwaysOnTop', 'window.notFocusedAfterLaunch', 'window.resizable']) {
      skip(name, 'CDP 模式读不到主进程窗口状态');
    }
    check('window.insideWorkArea', lib.rectInside(rendererInfo.bounds, rendererInfo.workArea, 8), {
      bounds: rendererInfo.bounds,
      workArea: rendererInfo.workArea,
      source: 'renderer',
    });
    check(
      'window.compactWidth',
      rendererInfo.bounds.width >= lib.COMPACT_WIDTH.min && rendererInfo.bounds.width <= lib.COMPACT_WIDTH.max,
      {width: rendererInfo.bounds.width, source: 'renderer'},
    );
  }
  check(
    'renderer.noNodeGlobals',
    rendererInfo.requireType === 'undefined' && rendererInfo.processType === 'undefined',
    {
      require: rendererInfo.requireType,
      process: rendererInfo.processType,
    },
  );
  check('renderer.bridge', rendererInfo.bridge);

  if (options.native) {
    if (!nativeResults.supported) skip('native', `${process.platform} 暂未实现系统层探针`);
    else {
      await step('native.launch', async () => {
        const snap = await nativeSnapshot(driver, launchInfo?.bounds ?? rendererInfo.bounds);
        nativeResults.afterLaunch = snap;
        // 前台应用不能变成本应用。前后是否同一个应用只作参考：人在测试期间切换应用也会让它变化。
        check('native.foregroundNotTaken', snap.frontmost.pid !== driver.mainPid, {
          mainPid: driver.mainPid,
          before: frontBefore,
          after: snap.frontmost,
          unchanged: frontBefore ? snap.frontmost.pid === frontBefore.pid : undefined,
        });
        if (!snap.window) {
          skip('native.onTop', '当前驱动拿不到原生窗口句柄');
          return;
        }
        check('native.windowFound', snap.window.found, {window: snap.window.raw});
        if (!snap.window.found) return;
        check('native.onTop', snap.window.onTop, {window: snap.window.raw});
        if (snap.window.aboveOverlapping === null) skip('native.aboveOtherAppWindow', '没有可比较的其他应用重叠窗口');
        else check('native.aboveOtherAppWindow', snap.window.aboveOverlapping, {window: snap.window.raw});
      });
    }
  }

  // 2. 接收端就绪。
  const session = await step('session.ready', async () => {
    const value = await waitSession();
    check('session.ready', true, {url: value.url});
    return value;
  });
  if (!session) throw new Error('接收端未就绪，后续步骤无法进行');

  await step('compact.waitingHost', async () => {
    const root = page.getByTestId('compact-root');
    await poll(async () => (await root.getAttribute('data-empty')) === 'true', '紧凑条空状态');
    await poll(async () => (await root.innerText()).includes('还没有运行记录'), '本地记录读取完成');
    check('compact.waitingHost', (await root.innerText()).includes('任务发来事件后，会显示在这里'));
  });
  await step('screenshot.compactEmpty', () => screenshot(page, 'compact-empty'));

  // 3. 可见延迟：此时只有这一个 run，紧凑条自动跟随它。
  const latency = await step('latency', () => measureLatency(page, session));
  collected.latency = latency;
  if (latency) {
    const main = latency.postToVisible;
    log(
      `可见延迟 n=${latency.n} 可见=${latency.seen} p50=${main.p50}ms p95=${main.p95}ms max=${main.max}ms（阈值 ${latency.thresholdMs}ms）`,
    );
    check('latency.allVisible', latency.missing === 0 && latency.rejected === 0, {
      missing: latency.missing,
      rejected: latency.rejected,
    });
    check('latency.p95', latency.pass, {p95: main.p95, thresholdMs: latency.thresholdMs});
  }

  // 4. 固定场景经 demo-host 的真实 HTTP 发送；再发两条闭环 run。
  const demo = await step('fixtures.posted', async () => {
    const result = await runDemoHost();
    check('fixtures.posted', result.code === 0, {exitCode: result.code, output: result.output.slice(-2000)});
    return result;
  });
  const producer = `smoke-${process.pid}-${Date.now().toString(36)}`;
  const unverifiedRun = `smoke-unverified-${Date.now().toString(36)}`;
  const selectOnlyRun = `smoke-select-only-${Date.now().toString(36)}`;
  const unverifiedEvent = lib.createRun(unverifiedRun, `${producer}-a`);
  const closedLoop = await step('closedLoop.posted', async () => {
    await postAll(session, lib.completedUnverifiedEvents(unverifiedEvent));
    await postAll(session, lib.selectOnlyEvents(lib.createRun(selectOnlyRun, `${producer}-b`)));
    check('closedLoop.posted', true);
    return true;
  });

  // 5. 紧凑条：自动跟随最新的「只选择」run。
  const compact = page.getByTestId('compact-root');
  let compactName;
  if (closedLoop) {
    await step('compact.selectOnly', async () => {
      await poll(
        async () => (await page.getByTestId('compact-run-name').getAttribute('title')) === '闭环：只选择',
        '紧凑条显示「闭环：只选择」',
      );
      await poll(async () => (await page.getByTestId('compact-action').innerText()).includes('B'), '紧凑条动作 B');
      compactName = await page.getByTestId('compact-run-name').getAttribute('title');
      const runStatus = (await page.getByTestId('compact-status').innerText()).trim();
      const execStatus = (await page.getByTestId('compact-exec-status').innerText()).trim();
      const text = await compact.innerText();
      const hits = lib.forbiddenHits(text, lib.executedWords);
      check(
        'compact.selectOnlyNotExecuted',
        runStatus === lib.statusLabels.selected && execStatus === lib.statusLabels.selected && hits.length === 0,
        {runStatus, execStatus, forbidden: hits, text},
      );
    });
  }
  await step('screenshot.compact', () => screenshot(page, 'compact'));

  // 6. 展开：窗口尺寸切换，并显示同一个 run。
  const compactBounds = (await windowBounds(driver)).bounds;
  const expanded = page.getByTestId('expanded-root');
  const liveState = {};
  await step('mode.expand', async () => {
    await page.getByTestId('compact-expand').click();
    await expanded.waitFor();
    const after = await poll(async () => {
      const current = await windowBounds(driver);
      return current.bounds.height >= lib.EXPANDED_MIN_HEIGHT ? current : undefined;
    }, '窗口切到展开尺寸');
    check(
      'mode.expand',
      after.bounds.height > compactBounds.height && lib.insideSomeWorkArea(after.bounds, after.displays),
      {compact: compactBounds, expanded: after.bounds},
    );
  });
  if (closedLoop) {
    await step('expanded.sameRun', async () => {
      await poll(
        async () => (await expanded.locator('h1.run-name').getAttribute('title')) === compactName,
        '展开视图 run',
      );
      const pickerValue = await expanded.getByLabel('运行').inputValue();
      check('expanded.sameRunAsCompact', pickerValue === selectOnlyRun, {name: compactName, runId: pickerValue});
      await poll(async () => (await expanded.getByTestId('decision-chain').count()) > 0, '决策链');
      const state = await liveKeyState(expanded);
      liveState.selectOnly = state;
      const hits = lib.forbiddenHits(`${state.status}\n${state.chain}`, lib.executedWords);
      check(
        'expanded.selectOnlyNotExecuted',
        state.status === `状态 ${lib.statusLabels.selected}` &&
          state.chain.includes('JEV 选择 A') &&
          state.chain.includes('待执行 B') &&
          hits.length === 0,
        {...state, forbidden: hits},
      );
    });
  }
  await step('screenshot.expanded', () => screenshot(page, 'expanded'));
  if (demo?.code === 0) {
    await step('fixtures.listed', async () => {
      const picker = expanded.getByLabel('运行');
      const texts = await poll(async () => {
        const values = await picker.locator('option').allInnerTexts();
        return fixtures.every(item => values.some(text => lib.optionMatches(text, item))) ? values : undefined;
      }, '运行列表里有全部固定场景');
      check('fixtures.listed', true, {
        fixtures: fixtures.map(item => `${item.name} · ${item.label}`),
        options: texts,
      });
    });
  }

  // 7. 完成未验证：只能是「已执行待验证」，不显示验证成功；输入摘要里的密码已脱敏。
  if (closedLoop) {
    await step('expanded.unverified', async () => {
      await expanded.getByLabel('运行').selectOption(unverifiedRun);
      await poll(
        async () => (await expanded.locator('h1.run-name').getAttribute('title')) === '闭环：完成未验证',
        '切到「闭环：完成未验证」',
      );
      await poll(async () => (await expanded.getByTestId('decision-chain').count()) > 0, '决策链');
      const state = await liveKeyState(expanded);
      liveState.unverified = state;
      const summary = await expanded.locator('.summary-bar').innerText();
      const hits = lib.forbiddenHits(state.chain, lib.successWords);
      check(
        'expanded.unverifiedNoSuccess',
        state.status === `状态 ${lib.statusLabels.unverified}` &&
          state.chain.includes(`${lib.statusLabels.unverified} go`) &&
          summary.includes('验证成功 0') &&
          summary.includes('未验证 1') &&
          hits.length === 0,
        {...state, summary, forbidden: hits},
      );
      const pageText = await page.locator('body').innerText();
      check('expanded.secretRedacted', !pageText.includes(lib.SECRET) && pageText.includes('[REDACTED]'));
    });

    // 8. 暂停跟随不停止接收。
    await step('timeline.pauseKeepsIngest', async () => {
      await expanded.getByTestId('tab-timeline').click();
      const items = expanded.getByTestId('timeline-item');
      await poll(async () => (await items.count()) >= 40, '时间线至少 40 条');
      const list = expanded.locator('.timeline-list');
      await poll(async () => (await list.evaluate(el => el.scrollHeight - el.clientHeight)) > 20, '时间线可以滚动');
      await list.evaluate(el => {
        el.scrollTop = 0;
        el.dispatchEvent(new Event('scroll'));
      });
      const resume = expanded.getByTestId('timeline-resume');
      const newCount = async () => lib.pausedNewCount(await resume.innerText());
      await poll(async () => (await newCount()) === 0, '已暂停跟随 · 0 条新事件');
      const firstBefore = await items.first().getAttribute('data-cursor');
      const results = await postAll(
        session,
        Array.from({length: 5}, () => unverifiedEvent('heartbeat')),
      );
      // 只断言「至少 5 条」：暂停期间计数的口径（是否含其他到达）由展开视图决定，这里只关心接收没有停。
      const after = await poll(async () => {
        const count = await newCount();
        return count !== undefined && count >= 5 ? count : undefined;
      }, '已暂停跟随 · 至少 5 条新事件');
      const firstAfter = await items.first().getAttribute('data-cursor');
      const scrollTop = await list.evaluate(el => el.scrollTop);
      check('timeline.pauseKeepsIngest', after >= 5 && firstBefore === firstAfter && scrollTop < 5, {
        resumeText: await resume.innerText(),
        cursors: results.map(result => result.cursor),
        firstBefore,
        firstAfter,
        scrollTop,
      });
      await resume.click();
      await expanded.locator('.follow-note').waitFor();
      await expanded.getByTestId('tab-decisions').click();
    });
  }

  // 9. 导出后回放，关键状态一致；回放期间继续接收；退出回放看到实时数据。
  let exported;
  if (driver.kind !== 'electron') {
    for (const name of ['export', 'replay.matchesLive', 'replay.ingestContinues', 'replay.exitShowsLive'])
      skip(name, 'CDP 模式不能替换原生文件对话框');
  } else if (closedLoop) {
    exported = await step('export', async () => {
      await driver.app.evaluate(({dialog}, file) => {
        dialog.showSaveDialog = async () => ({canceled: false, filePath: file});
        dialog.showOpenDialog = async () => ({canceled: false, filePaths: [file]});
      }, exportFile);
      await expanded.getByTestId('export-events').click();
      await poll(
        async () => (await page.locator('p.line').allInnerTexts()).some(text => text.includes('已导出')),
        '已导出提示',
      );
      const text = fs.readFileSync(exportFile, 'utf8');
      const lines = text.split('\n').filter(Boolean);
      const ids = new Set(lines.map(line => JSON.parse(line).run_id));
      check(
        'export',
        lines.length > 0 && ids.has(unverifiedRun) && ids.has(selectOnlyRun) && !text.includes(lib.SECRET),
        {file: path.relative(repoRoot, exportFile), lines: lines.length, bytes: Buffer.byteLength(text)},
      );
      return {lines: lines.length};
    });
  }
  if (exported) {
    await step('replay', async () => {
      await expanded.getByTestId('open-replay').click();
      const replay = page.getByTestId('replay-root');
      await replay.waitFor();
      const banner = await page.getByTestId('replay-banner').innerText();
      const position = await page.getByTestId('replay-position').innerText();
      const matches = {};
      for (const [key, runId] of [
        ['unverified', unverifiedRun],
        ['selectOnly', selectOnlyRun],
      ]) {
        await page.getByTestId('replay-run-picker').selectOption(runId);
        await poll(
          async () => (await replay.locator('h1.run-name').getAttribute('title')) === liveState[key]?.name,
          `回放切到 ${runId}`,
        );
        await poll(async () => (await replay.getByTestId('decision-chain').count()) > 0, '回放决策链');
        const state = await liveKeyState(replay);
        matches[key] = {live: liveState[key], replay: state};
      }
      const same = Object.values(matches).every(
        item => item.live && item.live.status === item.replay.status && item.live.chain === item.replay.chain,
      );
      check(
        'replay.matchesLive',
        same && banner.includes('export.jsonl') && position.includes(`第 ${exported.lines} / ${exported.lines} 条`),
        {banner, position, matches},
      );
      const duringRun = `smoke-during-replay-${Date.now().toString(36)}`;
      const during = lib.createRun(duringRun, `${producer}-c`);
      const results = await postAll(session, [
        during('run.started', {name: '闭环：回放期间仍在接收', simulated: true}),
        during('heartbeat'),
      ]);
      check('replay.ingestContinues', await replay.isVisible(), {cursors: results.map(result => result.cursor)});
      await page.getByTestId('replay-exit').click();
      await expanded.waitFor();
      const liveOptions = await poll(async () => {
        const values = await expanded.getByLabel('运行').locator('option').allInnerTexts();
        return values.some(text => text.startsWith('闭环：回放期间仍在接收')) ? values : undefined;
      }, '退出回放后看到回放期间接收的 run');
      check('replay.exitShowsLive', true, {runs: liveOptions.length});
    });
  }

  // 10. 收起：回到紧凑尺寸，紧凑条与展开视图看的是同一个 run。
  await step('mode.collapse', async () => {
    await expanded.locator('header.expanded-header').getByRole('button', {name: '收起', exact: true}).click();
    await compact.waitFor();
    const after = await poll(async () => {
      const current = await windowBounds(driver);
      return current.bounds.height < lib.EXPANDED_MIN_HEIGHT ? current : undefined;
    }, '窗口切回紧凑尺寸');
    check(
      'mode.collapse',
      after.bounds.width >= lib.COMPACT_WIDTH.min &&
        after.bounds.width <= lib.COMPACT_WIDTH.max &&
        lib.insideSomeWorkArea(after.bounds, after.displays),
      {bounds: after.bounds},
    );
    if (closedLoop) {
      await poll(
        async () => (await page.getByTestId('compact-run-name').getAttribute('title')) === '闭环：完成未验证',
        '紧凑条跟随所选 run',
      );
      const execStatus = (await page.getByTestId('compact-exec-status').innerText()).trim();
      const hits = lib.forbiddenHits(await compact.innerText(), lib.successWords);
      check('compact.unverifiedNoSuccess', execStatus === lib.statusLabels.unverified && hits.length === 0, {
        execStatus,
        forbidden: hits,
      });
    }
  });
  await step('screenshot.compactAfter', () => screenshot(page, 'compact-after'));

  // 11. 置顶开关。
  if (driver.kind === 'electron') {
    await step('window.pinToggle', async () => {
      const pin = page.getByTestId('compact-pin');
      await pin.click();
      await poll(async () => (await mainWindowInfo(driver)).alwaysOnTop === false, '取消置顶');
      const unpinned = await nativeSnapshot(driver, (await mainWindowInfo(driver)).bounds);
      await pin.click();
      await poll(async () => (await mainWindowInfo(driver)).alwaysOnTop === true, '恢复置顶');
      await sleep(300);
      const repinned = await nativeSnapshot(driver, (await mainWindowInfo(driver)).bounds);
      check('window.pinToggle', true);
      if (unpinned?.window && repinned?.window) {
        nativeResults.pinToggle = {unpinned, repinned};
        check('native.pinToggle', unpinned.window.onTop === false && repinned.window.onTop === true, {
          unpinned: unpinned.window.raw,
          repinned: repinned.window.raw,
        });
      }
    });
  } else skip('window.pinToggle', 'CDP 模式读不到主进程窗口状态');

  if (options.native && nativeResults.supported) {
    await step('native.end', async () => {
      nativeResults.frontmostEnd = (await native.probe()).frontmost;
      nativeResults.screenCaptureAllowed = await native.screenCaptureAllowed();
      // Playwright 的点击经 CDP 注入，不是系统输入事件，所以这一项只说明脚本操作没有让本应用到前台。
      nativeResults.foregroundNotTakenAfterScriptedClicks = nativeResults.frontmostEnd.pid !== driver.mainPid;
    });
  }

  // 12. 整屏截图（只作附件，不是断言）。macOS 未授予屏幕录制时跳过，不触发授权提示。
  if (driver.kind === 'electron') {
    await step('screenshot.desktop', async () => {
      const allowed =
        process.platform !== 'darwin' ||
        (await driver.app.evaluate(({systemPreferences}) => systemPreferences.getMediaAccessStatus('screen'))) ===
          'granted';
      if (!allowed) {
        nativeResults.desktopScreenshot = '跳过：未授予屏幕录制权限';
        return;
      }
      const png = await driver.app.evaluate(async ({desktopCapturer, screen}) => {
        const display = screen.getPrimaryDisplay();
        const thumbnailSize = {
          width: Math.round(display.size.width * display.scaleFactor),
          height: Math.round(display.size.height * display.scaleFactor),
        };
        const sources = await desktopCapturer.getSources({types: ['screen'], thumbnailSize});
        const source = sources.find(item => item.display_id === String(display.id)) ?? sources[0];
        return source ? source.thumbnail.toPNG().toString('base64') : undefined;
      });
      if (!png) return;
      const file = path.join(outDir, 'desktop.png');
      fs.writeFileSync(file, Buffer.from(png, 'base64'));
      screenshots.push(path.relative(repoRoot, file));
    });
  }

  if (options.holdMs > 0) {
    log(`保持窗口 ${options.holdMs} ms`);
    await sleep(options.holdMs);
  }

  await step('app.close', async () => {
    await driver.close();
    driver.closed = true;
    const removed = await poll(() => !fs.existsSync(sessionFile), '退出后删除会话文件', 10_000).catch(() => false);
    check('app.closeRemovesSession', removed);
  });
}

// 总超时：Playwright 的 evaluate 没有默认超时，卡住时也要写出报告并结束应用进程。
const watchdog = setTimeout(() => {
  record(lib.assertion('watchdog', false, {error: `超过 ${options.timeoutMs} ms 仍未完成`}));
  try {
    activeDriver?.kill();
  } catch {
    // 进程可能已经退出。
  }
  writeReport('watchdog');
  process.exit(1);
}, options.timeoutMs);

function writeReport(fatal) {
  const status = lib.overallStatus(assertions);
  const report = {
    schema: 1,
    ok: status.ok,
    failed: status.failed,
    startedAt,
    finishedAt: new Date().toISOString(),
    tag,
    mode: options.app ? 'packaged' : 'build',
    app: options.app ? path.resolve(options.app) : undefined,
    driver: collected.driver,
    fuses,
    options,
    environment: collected.environment,
    home: path.relative(repoRoot, home),
    window: {launch: collected.launchInfo, renderer: collected.rendererInfo},
    latency: collected.latency,
    native: nativeResults,
    screenshots,
    assertions,
    fatal,
  };
  fs.writeFileSync(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, 'app.log'), `${appLog.join('\n')}\n`);
  const counts = assertions.reduce((acc, item) => ({...acc, [item.status]: (acc[item.status] ?? 0) + 1}), {});
  log(`断言：通过 ${counts.passed ?? 0}，失败 ${counts.failed ?? 0}，跳过 ${counts.skipped ?? 0}`);
  log(`报告：${path.relative(repoRoot, path.join(outDir, 'report.json'))}`);
  return status.ok;
}

let fatal;
try {
  await run();
} catch (error) {
  fatal = message(error);
  record(lib.assertion('fatal', false, {error: fatal}));
}
if (activeDriver && !activeDriver.closed) {
  await Promise.race([activeDriver.close().catch(() => {}), sleep(15_000)]);
  try {
    activeDriver.kill();
  } catch {
    // 已经退出。
  }
}
clearTimeout(watchdog);
process.exit(writeReport(fatal) ? 0 : 1);

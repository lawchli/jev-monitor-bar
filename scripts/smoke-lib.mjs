// 桌面冒烟测试的纯函数：参数、统计、断言、报告与事件构造。不启动 Electron，单元测试直接导入。

export const LATENCY_THRESHOLD_MS = 500;
export const COMPACT_WIDTH = {min: 360, max: 440};
export const EXPANDED_MIN_HEIGHT = 320;
// Windows 的 getBounds 含不可见的缩放边框，贴边时会超出 workArea 几个像素。
export const WORK_AREA_TOLERANCE_PX = 8;

/** 与 src/state.ts 的 labels 一致；tests/smoke-lib.test.ts 会核对。 */
export const statusLabels = {
  selected: '已选择',
  executing: '执行中',
  unverified: '已执行待验证',
  passed: '验证成功',
  failed: '失败',
  verification_failed: '验证失败',
  completed: '任务结束',
};

/** 只选择、完成未验证两种状态下都不应出现的字样。 */
export const executedWords = ['已执行', '执行中', '实际执行', '验证成功'];
export const successWords = ['验证成功'];

const usage = `用法：pnpm smoke [选项]
  --app <路径>              测试打包后的可执行文件（macOS 可给 .app 目录）；默认启动仓库内 pnpm build 的产物
  --no-build                默认模式下跳过 pnpm build
  --driver <auto|electron|cdp>
                            electron 用 Playwright _electron（可读主进程窗口状态）；cdp 只连渲染进程。
                            auto：仓库产物用 electron；--app 先试 electron，失败后改用 cdp
  --latency-count <N>       可见延迟的事件数，默认 200
  --latency-interval <ms>   相邻两条延迟事件的最小间隔，默认 100
  --latency-timeout <ms>    单条事件等待可见的上限，默认 5000
  --native                  额外做系统层检查：前台应用、窗口是否在最上层（macOS 与 Windows；Windows 部分未实机验证）
  --hold <ms>               断言完成后保持窗口若干毫秒再关闭，便于人工查看
  --timeout <ms>            整个冒烟测试的上限，默认 600000；超时写出报告、结束应用并以非零退出
  --help                    显示本说明`;

export function helpText() {
  return usage;
}

function intOption(name, raw, min, max) {
  if (raw === undefined || raw.startsWith('--')) throw new Error(`${name} 缺少取值`);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} 须为 ${min}–${max} 的整数`);
  return value;
}

export function parseArgs(argv) {
  const options = {
    app: undefined,
    build: true,
    driver: 'auto',
    latencyCount: 200,
    latencyIntervalMs: 100,
    latencyTimeoutMs: 5000,
    native: false,
    holdMs: 0,
    timeoutMs: 600_000,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      return argv[index];
    };
    // `pnpm smoke -- --native` 会把单独的 -- 也传进来。
    if (arg === '--') continue;
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--no-build') options.build = false;
    else if (arg === '--native') options.native = true;
    else if (arg === '--app') {
      const value = next();
      if (!value || value.startsWith('--')) throw new Error('--app 缺少路径');
      options.app = value;
    } else if (arg === '--driver') {
      const value = next();
      if (!['auto', 'electron', 'cdp'].includes(value)) throw new Error('--driver 只能是 auto、electron 或 cdp');
      options.driver = value;
    } else if (arg === '--latency-count') options.latencyCount = intOption(arg, next(), 1, 100_000);
    else if (arg === '--latency-interval') options.latencyIntervalMs = intOption(arg, next(), 0, 60_000);
    else if (arg === '--latency-timeout') options.latencyTimeoutMs = intOption(arg, next(), 100, 120_000);
    else if (arg === '--hold') options.holdMs = intOption(arg, next(), 0, 3_600_000);
    else if (arg === '--timeout') options.timeoutMs = intOption(arg, next(), 10_000, 7_200_000);
    else throw new Error(`未知参数 ${arg}`);
  }
  if (options.app) options.build = false;
  return options;
}

export function platformTag(platform, arch) {
  return `${platform}-${arch}`;
}

/** 最近秩（nearest-rank）百分位：排序后取第 ceil(p/100 × n) 个值。空数组返回 undefined。 */
export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return undefined;
  if (!(p > 0 && p <= 100)) throw new Error('p 须在 (0, 100] 内');
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

export function summarize(values) {
  const finite = values.filter(value => Number.isFinite(value));
  if (finite.length === 0) return {n: 0};
  const sum = finite.reduce((total, value) => total + value, 0);
  return {
    n: finite.length,
    min: Math.min(...finite),
    p50: percentile(finite, 50),
    p95: percentile(finite, 95),
    max: Math.max(...finite),
    mean: Math.round((sum / finite.length) * 10) / 10,
  };
}

export function latencyMarker(index) {
  return `LAT#${String(index).padStart(6, '0')}#`;
}

export const markerSource = 'LAT#\\d{6}#';

/**
 * samples：每条事件一项，{marker, postStart, postEnd?, receivedAt?, domAt?, visibleAt?}，时间都是同一台机器的 Date.now() 毫秒。
 * 主口径为 POST 开始 → 标记出现在渲染层 DOM 后的第二个动画帧（该帧已提交）。
 */
export function latencyStats(samples, thresholdMs = LATENCY_THRESHOLD_MS) {
  const seen = samples.filter(sample => Number.isFinite(sample.visibleAt));
  const postToVisible = seen.map(sample => sample.visibleAt - sample.postStart);
  const postToDom = samples.filter(s => Number.isFinite(s.domAt)).map(s => s.domAt - s.postStart);
  const receivedToVisible = seen.filter(s => Number.isFinite(s.receivedAt)).map(s => s.visibleAt - s.receivedAt);
  const postRoundTrip = samples.filter(s => Number.isFinite(s.postEnd)).map(s => s.postEnd - s.postStart);
  const main = summarize(postToVisible);
  const missing = samples.length - seen.length;
  return {
    n: samples.length,
    seen: seen.length,
    missing,
    thresholdMs,
    postToVisible: main,
    postToDom: summarize(postToDom),
    receivedToVisible: summarize(receivedToVisible),
    postRoundTrip: summarize(postRoundTrip),
    pass: samples.length > 0 && missing === 0 && main.p95 !== undefined && main.p95 <= thresholdMs,
  };
}

export function rectInside(rect, area, tolerance = 0) {
  return (
    rect.x >= area.x - tolerance &&
    rect.y >= area.y - tolerance &&
    rect.x + rect.width <= area.x + area.width + tolerance &&
    rect.y + rect.height <= area.y + area.height + tolerance
  );
}

export function insideSomeWorkArea(rect, displays, tolerance = WORK_AREA_TOLERANCE_PX) {
  return displays.some(display => rectInside(rect, display.workArea, tolerance));
}

export function overlapArea(a, b) {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

/** 不含任一禁用词。返回命中的词，空数组表示通过。 */
export function forbiddenHits(text, words) {
  return words.filter(word => text.includes(word));
}

/** details 单独放一层，避免其中的 name / status 覆盖断言本身的字段。 */
export function assertion(name, ok, details) {
  const item = {name, status: ok ? 'passed' : 'failed'};
  if (details !== undefined) item.details = details;
  return item;
}

export function skipped(name, reason) {
  return {name, status: 'skipped', reason};
}

/**
 * macOS CGWindowListCopyWindowInfo 的窗口数组（从前到后）。找出本进程最接近期望尺寸的窗口，
 * 以及与它重叠的其他应用普通窗口（layer 0），判断本窗口是否在它们之上。
 */
export function analyzeWindowStack(windows, pid, expected) {
  let ours;
  let oursIndex = -1;
  let bestScore = Number.POSITIVE_INFINITY;
  windows.forEach((win, index) => {
    if (win.pid !== pid) return;
    const score = expected
      ? Math.abs(win.bounds.width - expected.width) +
        Math.abs(win.bounds.height - expected.height) +
        Math.abs(win.bounds.x - expected.x) +
        Math.abs(win.bounds.y - expected.y)
      : index;
    if (score < bestScore) {
      bestScore = score;
      ours = win;
      oursIndex = index;
    }
  });
  if (!ours) return {found: false};
  const overlapping = [];
  windows.forEach((win, index) => {
    if (win.pid === pid || win.layer !== 0) return;
    if (overlapArea(win.bounds, ours.bounds) === 0) return;
    overlapping.push({owner: win.owner, pid: win.pid, index, above: index < oursIndex});
  });
  return {
    found: true,
    layer: ours.layer,
    index: oursIndex,
    bounds: ours.bounds,
    overlapping,
    aboveOverlapping: overlapping.length === 0 ? null : overlapping.every(item => !item.above),
  };
}

let clock = Date.now();
/** occurred_at 递增，避免同毫秒事件靠 event_id 排序。 */
export function nextIso(now = Date.now()) {
  clock = Math.max(clock + 1, now);
  return new Date(clock).toISOString();
}

/** 构造一个 run 的事件序列；sequence 与 event_id 在同一 producer 内递增。 */
export function createRun(runId, producerId) {
  let sequence = 0;
  return function event(type, payload = {}, ids = {}) {
    sequence += 1;
    return {
      schema_version: 1,
      event_id: `${runId}-${sequence}`,
      run_id: runId,
      producer_id: producerId,
      sequence,
      occurred_at: nextIso(),
      type,
      ...ids,
      payload,
    };
  };
}

export const SECRET = 'smoke-hunter2-do-not-show';

/** 只有 JEV 选择与应用改选，没有执行：不能出现「已执行 / 成功」。 */
export function selectOnlyEvents(event) {
  const ids = {decision_id: 'd1', request_id: 'req-1', question_id: 'next'};
  const act = {action_id: 'act-1', attempt_id: 't1', decision_id: 'd1'};
  return [
    event('run.started', {name: '闭环：只选择', simulated: true}),
    event('decision.started', {kind: 'choice', question: '走哪条路？', candidates: {A: '左', B: '右'}}, ids),
    event(
      'decision.resolved',
      {kind: 'choice', choice: 'A', probabilities: {A: 0.7, B: 0.3}, model: 'typesafe', latency_ms: 30},
      ids,
    ),
    event('action.selected', {action: 'B', source: 'application'}, act),
  ];
}

/** 动作完成但没有验证：只能是「已执行待验证」，不能出现验证成功。前面垫 padding 条心跳让时间线可滚动。 */
export function completedUnverifiedEvents(event, padding = 40) {
  const ids = {decision_id: 'd1', request_id: 'req-1', question_id: 'next'};
  const act = {action_id: 'act-1', attempt_id: 't1', decision_id: 'd1'};
  const heartbeats = Array.from({length: padding}, () => event('heartbeat'));
  return [
    event('run.started', {name: '闭环：完成未验证', simulated: true}),
    ...heartbeats,
    event(
      'decision.started',
      {kind: 'choice', question: '下一步？', summary: `password=${SECRET}`, candidates: {go: '前进', stay: '停留'}},
      ids,
    ),
    event('decision.resolved', {kind: 'choice', choice: 'go', probabilities: {go: 0.8, stay: 0.2}}, ids),
    event('action.selected', {action: 'go', source: 'model'}, act),
    event('action.started', {}, act),
    event('action.completed', {}, act),
  ];
}

// Electron fuses：可执行文件里在这段标记之后依次是版本字节、长度字节，再每个 fuse 一个 ASCII 字节。
export const FUSE_SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';
const fuseNames = [
  'runAsNode',
  'enableCookieEncryption',
  'enableNodeOptionsEnvironmentVariable',
  'enableNodeCliInspectArguments',
  'enableEmbeddedAsarIntegrityValidation',
  'onlyLoadAppFromAsar',
  'loadBrowserProcessSpecificV8Snapshot',
  'grantFileProtocolExtraPrivileges',
  'wasmTrapHandlers',
];
const fuseValues = {48: false, 49: true, 114: 'removed', 144: 'inherit'};

/** 从包含 fuse 标记的字节里读出各开关；找不到标记返回 undefined。 */
export function parseFuseWire(bytes) {
  const sentinel = Buffer.from(FUSE_SENTINEL, 'latin1');
  const at = bytes.indexOf(sentinel);
  if (at < 0) return undefined;
  const base = at + sentinel.length;
  if (base + 2 > bytes.length) return undefined;
  const version = bytes[base];
  const length = bytes[base + 1];
  if (base + 2 + length > bytes.length) return undefined;
  const fuses = {};
  for (let index = 0; index < length; index += 1) {
    const raw = bytes[base + 2 + index];
    fuses[fuseNames[index] ?? `fuse${index}`] = fuseValues[raw] ?? `unknown(${raw})`;
  }
  return {version, fuses};
}

/** 「已暂停跟随 · N 条新事件 · 回到最新」里的 N；不是这个格式返回 undefined。 */
export function pausedNewCount(text) {
  const match = /已暂停跟随 · (\d+) 条新事件/.exec(text ?? '');
  return match ? Number(match[1]) : undefined;
}

export function truncateLabel(text, max) {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max))}…`;
}

/** 固定场景：run.started 的名称与期望的状态文字。 */
export function fixtureExpectations(catalog, readFirstLine) {
  return catalog.scenarios.map(scenario => {
    const first = JSON.parse(readFirstLine(scenario.file));
    const status = scenario.expect?.run_status;
    return {
      id: scenario.id,
      name: first.payload?.name ?? scenario.id,
      label: statusLabels[status] ?? status,
    };
  });
}

/** 运行选择框的选项文字形如「名称（截断到 24 字）· 状态 · 模拟」。 */
export function optionMatches(optionText, expectation) {
  return optionText.startsWith(truncateLabel(expectation.name, 24)) && optionText.includes(`· ${expectation.label}`);
}

export function overallStatus(assertions, latency) {
  const failed = assertions.filter(item => item.status === 'failed').map(item => item.name);
  if (latency && !latency.pass) failed.push('latency.p95');
  return {ok: failed.length === 0, failed};
}

export const latencyMethod = [
  '在紧凑条模式下，经真实 HTTP（127.0.0.1 + 会话令牌）逐条 POST progress.updated，payload.phase 为唯一标记 LAT#nnnnnn#。',
  '紧凑条第二行显示当前 run 的阶段，因此每条事件都会让该行文字变化。',
  '渲染进程主世界里装 MutationObserver（subtree、childList、characterData），每次变更读 document.body.innerText（只含已渲染、未隐藏的文字），首次出现某标记时记 domAt，',
  '再等两个 requestAnimationFrame 记 visibleAt（第一帧把变更画出，第二帧开始时该帧已提交）；若 1 秒内没有动画帧则以超时时刻记并计数。',
  '主口径 = visibleAt − POST 开始时刻；同时给出接收端写入的 received_at → visibleAt、POST 开始 → domAt 与 POST 往返。所有时间都取本机 Date.now()。',
  '发送节奏：上一条可见（或超时）后，且距上一条 POST 开始不少于 --latency-interval 毫秒，才发下一条，所以每条都能单独测到、不会被后一条覆盖。',
  '百分位用最近秩法。没有计入模型响应耗时；未出现的标记记为缺失，任何缺失都算不通过。',
].join('');

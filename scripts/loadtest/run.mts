// `pnpm loadtest`：合成负载。父进程产生事件并经 HTTP 投递，接收端跑在单独的子进程里。
// 只写仓库内 .runtime/loadtest/<时间戳>/，不碰真实数据目录。开发脚本，可以启动子进程。
import {execFileSync, fork, type ChildProcess} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {build} from 'esbuild';
import type {MonitorEvent} from '../../src/protocol';
import {
  BODY_LIMIT,
  LoadGenerator,
  conflictOf,
  heavyDecisionPair,
  invalidBody,
  malformedBody,
  mulberry32,
  oversizeBody,
  rejectKinds,
  type RejectKind,
} from './generator';
import {parseDuration, slope, summarize, type Summary} from './stats';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const {values: flags} = parseArgs({
  options: {
    duration: {type: 'string', default: '30m'},
    events: {type: 'string'},
    rate: {type: 'string', default: '20'},
    runs: {type: 'string'},
    out: {type: 'string', default: '.runtime/loadtest'},
    concurrency: {type: 'string', default: '4'},
    sample: {type: 'string', default: '10s'},
    'gc-every': {type: 'string', default: '60s'},
    'burst-every': {type: 'string', default: '5m'},
    'burst-size': {type: 'string', default: '400'},
    'reject-ratio': {type: 'string', default: '0.03'},
    'heavy-ratio': {type: 'string', default: '0.02'},
    marathons: {type: 'string', default: '1'},
    'marathon-share': {type: 'string', default: '0.3'},
    follow: {type: 'string', default: 'marathon'},
    runtime: {type: 'string', default: 'node'},
    seed: {type: 'string', default: '1'},
    'no-probe': {type: 'boolean', default: false},
    'probe-runs': {type: 'string', default: '4'},
    'probe-decisions': {type: 'string', default: '520'},
    'probe-rate': {type: 'string', default: '100'},
    'export-during': {type: 'string', default: '0.75'},
    'no-recovery': {type: 'boolean', default: false},
    help: {type: 'boolean', default: false},
  },
});

if (flags.help) {
  console.log(`pnpm loadtest [--duration 30m] [--events N | --rate 20] [--runs N] [--out .runtime/loadtest]
  [--concurrency 4] [--sample 10s] [--gc-every 60s] [--burst-every 5m] [--burst-size 400]
  [--reject-ratio 0.03] [--heavy-ratio 0.02] [--marathons 1] [--marathon-share 0.3]
  [--follow marathon|auto] [--runtime node|electron] [--seed 1]
  [--no-probe] [--probe-runs 4] [--probe-decisions 520] [--probe-rate 100] [--no-recovery]
  [--export-during 0.75]   负载进行到这个比例时导出一次（0 关闭），看同步导出对接收的影响`);
  process.exit(0);
}

const num = (value: string | undefined, name: string) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`--${name} 必须是非负数：${value}`);
  return parsed;
};

const durationMs = parseDuration(flags.duration!);
const events = flags.events
  ? Math.round(num(flags.events, 'events'))
  : Math.round((num(flags.rate, 'rate') * durationMs) / 1000);
const options = {
  durationMs,
  events,
  rate: events / (durationMs / 1000),
  runs: flags.runs ? Math.round(num(flags.runs, 'runs')) : Math.max(250, Math.round(events / 60)),
  concurrency: Math.max(1, Math.round(num(flags.concurrency, 'concurrency'))),
  sampleMs: parseDuration(flags.sample!),
  gcEveryMs: parseDuration(flags['gc-every']!),
  burstEveryMs: parseDuration(flags['burst-every']!),
  burstSize: Math.round(num(flags['burst-size'], 'burst-size')),
  rejectRatio: num(flags['reject-ratio'], 'reject-ratio'),
  heavyRatio: num(flags['heavy-ratio'], 'heavy-ratio'),
  marathons: Math.round(num(flags.marathons, 'marathons')),
  marathonShare: num(flags['marathon-share'], 'marathon-share'),
  follow: flags.follow!,
  runtime: flags.runtime!,
  seed: Math.round(num(flags.seed, 'seed')),
  probe: !flags['no-probe'],
  probeRuns: Math.round(num(flags['probe-runs'], 'probe-runs')),
  probeDecisions: Math.round(num(flags['probe-decisions'], 'probe-decisions')),
  probeRate: num(flags['probe-rate'], 'probe-rate'),
  exportDuring: num(flags['export-during'], 'export-during'),
  recovery: !flags['no-recovery'],
};
if (!['node', 'electron'].includes(options.runtime)) throw new Error('--runtime 只能是 node 或 electron');
if (!['marathon', 'auto'].includes(options.follow)) throw new Error('--follow 只能是 marathon 或 auto');
if (options.follow === 'marathon' && options.marathons === 0) options.follow = 'auto';

const pad = (n: number) => String(n).padStart(2, '0');
const stampOf = (d: Date) =>
  `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const startedAt = new Date();
const outDir = path.resolve(root, flags.out!, `${stampOf(startedAt)}-${options.runtime}`);
fs.mkdirSync(outDir, {recursive: true});
const log = (line: string) => {
  console.log(line);
  fs.appendFileSync(path.join(outDir, 'progress.log'), `${line}\n`);
};

// ---------- 机器信息
function macVersion() {
  try {
    const plist = fs.readFileSync('/System/Library/CoreServices/SystemVersion.plist', 'utf8');
    const read = (key: string) => new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`).exec(plist)?.[1];
    return `macOS ${read('ProductVersion')} (${read('ProductBuildVersion')})`;
  } catch {
    return undefined;
  }
}
function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim();
  } catch {
    return undefined;
  }
}
const machine = {
  os: macVersion() ?? `${os.type()} ${os.release()}`,
  kernel: `${os.type()} ${os.release()}`,
  osVersion: os.version(),
  arch: os.arch(),
  cpu: os.cpus()[0]?.model,
  cores: os.cpus().length,
  ramGB: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
  node: process.version,
  commit: gitCommit(),
};

// ---------- 打包接收端子进程
const receiverFile = path.join(outDir, 'receiver.cjs');
await build({
  entryPoints: [path.join(root, 'scripts/loadtest/receiver.ts')],
  outfile: receiverFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  logLevel: 'warning',
});

function electronBinary() {
  const pkg = path.join(root, 'node_modules/electron');
  const relative = fs.readFileSync(path.join(pkg, 'path.txt'), 'utf8').trim();
  const binary = path.join(pkg, 'dist', relative);
  if (!fs.existsSync(binary)) throw new Error(`Electron 二进制不存在：${binary}。改用 --runtime node。`);
  return binary;
}

interface Receiver {
  child: ChildProcess;
  call<T = any>(type: string, extra?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  ready: Promise<any>;
  exited: Promise<number | null>;
}

function spawnReceiver(args: string[]): Receiver {
  const env: NodeJS.ProcessEnv = {...process.env};
  delete env.NODE_OPTIONS;
  if (options.runtime === 'electron') env.ELECTRON_RUN_AS_NODE = '1';
  const child = fork(receiverFile, args, {
    execPath: options.runtime === 'electron' ? electronBinary() : process.execPath,
    execArgv: [],
    env,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  let nextId = 1;
  const waiting = new Map<number, {resolve: (v: any) => void; reject: (e: Error) => void}>();
  let readyResolve: (value: any) => void;
  let readyReject: (error: Error) => void;
  const ready = new Promise<any>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  child.on('message', (raw: any) => {
    if (raw.type === 'ready' || raw.type === 'recovered') readyResolve(raw);
    else if (raw.type === 'reply') {
      const entry = waiting.get(raw.id);
      waiting.delete(raw.id);
      if (!entry) return;
      if (raw.error) entry.reject(new Error(raw.error));
      else entry.resolve(raw.data);
    }
  });
  const exited = new Promise<number | null>(resolve =>
    child.on('exit', code => {
      readyReject(new Error(`receiver exited early (${code})`));
      for (const entry of waiting.values()) entry.reject(new Error(`receiver exited (${code})`));
      waiting.clear();
      resolve(code);
    }),
  );
  return {
    child,
    ready,
    exited,
    call(type, extra = {}, timeoutMs = 120_000) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(new Error(`receiver ${type} timed out`));
        }, timeoutMs);
        waiting.set(id, {
          resolve: value => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: error => {
            clearTimeout(timer);
            reject(error);
          },
        });
        child.send({type, id, ...extra});
      });
    },
  };
}

// ---------- HTTP 投递
interface PostResult {
  status: number;
  ms: number;
  text?: string;
  error?: string;
}

function post(
  session: {url: string; token: string},
  agent: http.Agent,
  body: string,
  opts: {token?: string; chunked?: boolean} = {},
): Promise<PostResult> {
  return new Promise(resolve => {
    const started = performance.now();
    const headers: Record<string, string | number> = {
      'content-type': 'application/json',
      authorization: `Bearer ${opts.token ?? session.token}`,
    };
    if (!opts.chunked) headers['content-length'] = Buffer.byteLength(body);
    const req = http.request(`${session.url}/events`, {method: 'POST', headers, agent, timeout: 15_000}, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          ms: performance.now() - started,
          text: Buffer.concat(chunks).toString('utf8'),
        }),
      );
      res.on('error', error =>
        resolve({status: 0, ms: performance.now() - started, error: (error as NodeJS.ErrnoException).code}),
      );
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), {code: 'ETIMEDOUT'})));
    req.on('error', error =>
      resolve({status: 0, ms: performance.now() - started, error: (error as NodeJS.ErrnoException).code ?? 'error'}),
    );
    if (opts.chunked) {
      for (let i = 0; i < body.length; i += 16_384) req.write(body.slice(i, i + 16_384));
      req.end();
    } else req.end(body);
  });
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function diskStats(home: string) {
  const dir = path.join(home, 'events');
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter(f => /^events-\d{8}\.jsonl$/.test(f));
  } catch {}
  const numbers = files.map(f => Number(f.slice(7, 15)));
  const bytes = files.reduce((sum, f) => {
    try {
      return sum + fs.statSync(path.join(dir, f)).size;
    } catch {
      return sum;
    }
  }, 0);
  return {
    bytes,
    segments: files.length,
    firstSegment: numbers.length ? Math.min(...numbers) : 0,
    lastSegment: numbers.length ? Math.max(...numbers) : 0,
  };
}

// ---------- 主负载
type Kind = 'valid' | RejectKind;
interface Job {
  kind: Kind;
  at: number;
}

const expected: Record<RejectKind, number[]> = {
  oversize: [413],
  'oversize-chunked': [413],
  malformed: [400],
  invalid: [400],
  unauthorized: [401],
  duplicate: [200],
  conflict: [409],
};

const mainHome = path.join(outDir, 'data');
log(`输出目录 ${path.relative(root, outDir)}`);
log(
  `参数：${Math.round(durationMs / 1000)} s，${events} 条有效事件（${options.rate.toFixed(2)}/s），并发 ${options.concurrency}，` +
    `runs≈${options.runs}，长 run ${options.marathons}，heavy ${options.heavyRatio}，拒绝 ${options.rejectRatio}，运行时 ${options.runtime}`,
);

const receiver = spawnReceiver(['--home', mainHome, '--follow', 'auto']);
const ready = await receiver.ready;
const session = ready.session;
const generator = new LoadGenerator({
  seed: options.seed,
  events,
  runs: options.runs,
  marathons: options.marathons,
  marathonShare: options.marathonShare,
  heavyRatio: options.heavyRatio,
});
const followRun = options.follow === 'marathon' ? generator.marathonIds[0] : 'auto';
await receiver.call('follow', {runId: followRun});

const agent = new http.Agent({keepAlive: true, maxSockets: options.concurrency});
const mix = mulberry32(options.seed ^ 0x5eed);
const start = performance.now();
const bursts =
  options.burstEveryMs > 0 && options.burstSize > 0
    ? Math.max(0, Math.floor((durationMs - 1) / options.burstEveryMs))
    : 0;
const burstTotal = Math.min(events, bursts * options.burstSize);
const baseCount = events - burstTotal;
const interval = baseCount > 0 ? durationMs / baseCount : 0;
let baseIndex = 0;
let burstIndex = 0;
let burstLeft = 0;
let scheduled = 0;
const pendingRejects: Job[] = [];

function nextJob(): Job | undefined {
  if (pendingRejects.length > 0) return pendingRejects.shift();
  if (scheduled >= events) return undefined;
  const baseAt = start + baseIndex * interval;
  const burstAt = start + (burstIndex + 1) * options.burstEveryMs;
  let at: number;
  if (burstLeft > 0 || (burstIndex < bursts && burstAt <= baseAt) || baseIndex >= baseCount) {
    if (burstLeft === 0) burstLeft = options.burstSize;
    burstLeft -= 1;
    at = burstAt;
    if (burstLeft === 0) burstIndex += 1;
  } else {
    at = baseAt;
    baseIndex += 1;
  }
  scheduled += 1;
  if (mix() < options.rejectRatio) {
    pendingRejects.push({kind: rejectKinds[Math.floor(mix() * rejectKinds.length)], at});
  }
  return {kind: 'valid', at};
}

const ring: MonitorEvent[] = [];
let rejectSequence = 0;
let variant = 0;
function rejectBase(): MonitorEvent {
  rejectSequence += 1;
  return {
    schema_version: 1,
    event_id: `lt-rejects:${rejectSequence}`,
    run_id: 'lt-rejects',
    producer_id: 'lt-rejects',
    sequence: rejectSequence,
    occurred_at: new Date().toISOString(),
    type: 'heartbeat',
    payload: {},
  };
}

interface WindowStats {
  latency: number[];
  rejectLatency: number[];
  lag: number[];
  accepted: number;
  heavyBytes: number;
  bodyBytes: number;
  errors: number;
}
const newWindow = (): WindowStats => ({
  latency: [],
  rejectLatency: [],
  lag: [],
  accepted: 0,
  heavyBytes: 0,
  bodyBytes: 0,
  errors: 0,
});
let producerWindow = newWindow();
const allLatency: number[] = [];
const allRejectLatency: number[] = [];
const allLag: number[] = [];
let exportWatch: {start: number; end?: number; latencies: number[]} | undefined;
const counts = {
  over500ms: 0,
  over2000ms: 0,
  accepted: 0,
  validFailed: 0,
  validRetries: 0,
  unexpected: [] as {kind: Kind; status: number; text?: string; error?: string}[],
  heavy: 0,
  requests: {} as Record<string, Record<string, number>>,
  bytesSent: 0,
};
const tally = (kind: Kind, result: PostResult) => {
  const key = result.status === 0 ? `error:${result.error}` : String(result.status);
  const row = (counts.requests[kind] ??= {});
  row[key] = (row[key] ?? 0) + 1;
};

async function sendValid(job: Job) {
  const event = generator.next();
  const body = JSON.stringify(event);
  const size = Buffer.byteLength(body);
  if (size > BODY_LIMIT) throw new Error(`generator produced ${size} bytes`);
  if (size >= 59_000) {
    counts.heavy += 1;
    producerWindow.heavyBytes += size;
  }
  producerWindow.bodyBytes += size;
  counts.bytesSent += size;
  for (let attempt = 0; ; attempt++) {
    const lag = performance.now() - job.at;
    const result = await post(session, agent, body);
    tally('valid', result);
    if (result.ms > 500) counts.over500ms += 1;
    if (result.ms > 2000) counts.over2000ms += 1;
    if (exportWatch && (exportWatch.end === undefined || performance.now() <= exportWatch.end + 500)) {
      exportWatch.latencies.push(result.ms);
    }
    if (result.status === 200 && result.text?.includes('"accepted":true')) {
      producerWindow.latency.push(result.ms);
      producerWindow.lag.push(Math.max(0, lag));
      producerWindow.accepted += 1;
      counts.accepted += 1;
      ring.push(event);
      if (ring.length > 256) ring.shift();
      return;
    }
    if (result.status === 0 && attempt < 5) {
      producerWindow.errors += 1;
      counts.validRetries += 1;
      await sleep(200);
      continue;
    }
    counts.validFailed += 1;
    if (counts.unexpected.length < 50) counts.unexpected.push({kind: 'valid', ...result});
    return;
  }
}

async function sendReject(kind: RejectKind) {
  let result: PostResult;
  if (kind === 'duplicate' || kind === 'conflict') {
    if (ring.length === 0) return;
    const event = ring[Math.floor(mix() * ring.length)];
    const body = JSON.stringify(kind === 'duplicate' ? event : conflictOf(event, ++variant));
    result = await post(session, agent, body);
    if (kind === 'duplicate' && result.status === 200 && !result.text?.includes('"accepted":false')) result.status = -1;
  } else if (kind === 'unauthorized') {
    result = await post(session, agent, JSON.stringify(rejectBase()), {token: 'f'.repeat(64)});
  } else if (kind === 'malformed') {
    result = await post(session, agent, malformedBody(rejectBase()));
  } else if (kind === 'invalid') {
    result = await post(session, agent, invalidBody(rejectBase(), variant++));
  } else {
    result = await post(session, agent, oversizeBody(rejectBase()), {chunked: kind === 'oversize-chunked'});
  }
  tally(kind, result);
  producerWindow.rejectLatency.push(result.ms);
  // 服务端回 413 后关连接，客户端可能先看到连接被重置；这也算被拒绝，不算异常。
  const reset = kind.startsWith('oversize') && result.status === 0;
  if (!expected[kind].includes(result.status) && !reset && counts.unexpected.length < 50) {
    counts.unexpected.push({kind, status: result.status, text: result.text?.slice(0, 200), error: result.error});
  }
}

async function worker() {
  for (;;) {
    const job = nextJob();
    if (!job) return;
    const wait = job.at - performance.now();
    if (wait > 0) await sleep(wait);
    if (job.kind === 'valid') await sendValid(job);
    else await sendReject(job.kind);
  }
}

const samples: any[] = [];
const rawAll = {
  ingest: [] as number[],
  append: [] as number[],
  write: [] as number[],
  open: [] as number[],
  readdir: [] as number[],
  snapshotBuild: [] as number[],
  snapshotSerialize: [] as number[],
  snapshotBytes: [] as number[],
  updateLatency: [] as number[],
  page: [] as number[],
};
let lastGcAt = start;

function windowSummary(raw: Record<string, number[] | number>) {
  const out: Record<string, Summary | number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (Array.isArray(value)) {
      out[key] = summarize(value);
      const all = (rawAll as Record<string, number[]>)[key];
      if (all) for (const v of value) all.push(v);
    } else out[key] = value;
  }
  return out;
}

async function takeSample(receiverRef: Receiver, home: string, opts: {gc?: boolean; deep?: boolean; phase: string}) {
  const child = await receiverRef.call<any>('sample', {gc: opts.gc, deep: opts.deep});
  const producer = producerWindow;
  producerWindow = newWindow();
  for (const v of producer.latency) allLatency.push(v);
  for (const v of producer.rejectLatency) allRejectLatency.push(v);
  for (const v of producer.lag) allLag.push(v);
  const {raw, ...rest} = child;
  const entry = {
    phase: opts.phase,
    t: Math.round((performance.now() - start) / 100) / 10,
    accepted: counts.accepted,
    loadavg1: Math.round(os.loadavg()[0] * 100) / 100,
    freeMemMB: Math.round(os.freemem() / 1048576),
    producer: {
      accepted: producer.accepted,
      errors: producer.errors,
      bodyBytes: producer.bodyBytes,
      heavyBytes: producer.heavyBytes,
      latency: summarize(producer.latency),
      rejectLatency: summarize(producer.rejectLatency),
      lag: summarize(producer.lag),
    },
    receiver: {...rest, timing: windowSummary(raw)},
    disk: diskStats(home),
  };
  samples.push(entry);
  return entry;
}

const fmt = (n: number, digits = 1) => (Number.isFinite(n) ? n.toFixed(digits) : '-');
function progressLine(s: any) {
  const r = s.receiver;
  const m = r.memoryAfterGc ?? r.memory;
  const mm = Math.floor(s.t / 60);
  const ss = Math.floor(s.t % 60);
  return (
    `[${pad(mm)}:${pad(ss)}] ok ${s.accepted}/${events} rss ${fmt(r.memory.rssMB)}MB heap ${fmt(r.memory.heapUsedMB)}` +
    `${r.memoryAfterGc ? `(gc ${fmt(m.heapUsedMB)}/rss ${fmt(m.rssMB)})` : ''}MB | store ${r.store.events} ev ` +
    `${fmt(r.store.bytes / 1048576)}MB runs ${r.state.runs} dec ${r.state.decisions} | http p95 ${fmt(s.producer.latency.p95, 2)} ` +
    `p99 ${fmt(s.producer.latency.p99, 2)}ms | ingest p99 ${fmt(r.timing.ingest.p99, 2)}ms | eld p99 ${fmt(r.eld.p99)} ` +
    `max ${fmt(r.eld.max)}ms | snap p95 ${fmt(r.timing.snapshotBuild.p95 + r.timing.snapshotSerialize.p95, 2)}ms ` +
    `${fmt(r.timing.snapshotBytes.max / 1024, 0)}KB | disk ${fmt(s.disk.bytes / 1048576)}MB ${s.disk.segments} seg ` +
    `#${s.disk.lastSegment} | load ${s.loadavg1}`
  );
}

let sampling = true;
async function sampler() {
  let next = start + options.sampleMs;
  while (sampling) {
    const wait = next - performance.now();
    if (wait > 0) await sleep(Math.min(wait, 500));
    if (!sampling) break;
    if (performance.now() < next) continue;
    next += options.sampleMs;
    const doGc = options.gcEveryMs > 0 && performance.now() - lastGcAt >= options.gcEveryMs - 1;
    if (doGc) lastGcAt = performance.now();
    try {
      log(progressLine(await takeSample(receiver, mainHome, {gc: doGc, phase: 'load'})));
    } catch (error) {
      log(`sample failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

log(
  `接收端 pid ${ready.runtime.pid}（${options.runtime} ${ready.runtime.electron ?? ready.runtime.node}），跟随 ${followRun}`,
);
const baseline = await takeSample(receiver, mainHome, {gc: true, phase: 'baseline'});
log(progressLine(baseline));
const samplerDone = sampler();
let exportDuring: any;
const exportDuringTimer =
  options.exportDuring > 0 && options.exportDuring < 1
    ? setTimeout(async () => {
        exportWatch = {start: performance.now(), latencies: []};
        try {
          exportDuring = await receiver.call<any>(
            'export',
            {file: path.join(outDir, 'export-during-load.jsonl')},
            600_000,
          );
          exportWatch.end = performance.now();
          exportDuring.atS = Math.round((exportWatch.start - start) / 100) / 10;
          await sleep(600);
          exportDuring.httpDuring = summarize(exportWatch.latencies);
          log(
            `负载中导出：${fmt(exportDuring.ms)} ms，${fmt(exportDuring.bytes / 1048576, 2)} MB；期间 HTTP ` +
              `max ${fmt(exportDuring.httpDuring.max)} ms（${exportDuring.httpDuring.count} 个请求）`,
          );
        } catch (error) {
          log(`负载中导出失败：${error instanceof Error ? error.message : String(error)}`);
        }
        exportWatch = undefined;
      }, durationMs * options.exportDuring)
    : undefined;
await Promise.all(Array.from({length: options.concurrency}, () => worker()));
if (exportDuringTimer) clearTimeout(exportDuringTimer);
const loadMs = performance.now() - start;
sampling = false;
await samplerDone;
await sleep(300);
const final = await takeSample(receiver, mainHome, {gc: true, deep: true, phase: 'final'});
log(progressLine(final));
log(
  `负载结束：${fmt(loadMs / 1000)} s，接受 ${counts.accepted} 条，失败 ${counts.validFailed}，异常响应 ${counts.unexpected.length}`,
);

const exportFile = path.join(outDir, 'export.jsonl');
const exported = await receiver.call<any>('export', {file: exportFile}, 600_000);
log(`导出：${fmt(exported.ms)} ms，${fmt(exported.bytes / 1048576, 2)} MB，跳过 ${exported.skipped}`);
const replayed = await receiver.call<any>(
  'replay',
  {file: exportFile, runId: followRun === 'auto' ? undefined : followRun},
  600_000,
);
log(
  `回放：解析 ${fmt(replayed.parseMs)} ms，${replayed.events} 条，IPC ${fmt(replayed.ipcBytes / 1048576, 2)} MB / ` +
    `${fmt(replayed.serializeMs)} ms，replaySnapshot 全量 ${fmt(replayed.replaySnapshotFullMs)} ms，` +
    `ReplayTimeline 首次 ${fmt(replayed.timelineFirstMs)} ms / 跳到一半 ${fmt(replayed.timelineMidMs, 2)} ms`,
);
const afterEnd = await takeSample(receiver, mainHome, {gc: true, phase: 'after-export'});
await receiver.call('exit');
await receiver.exited;
agent.destroy();

let recovery: any;
if (options.recovery) {
  const recover = spawnReceiver(['--recover', path.join(mainHome, 'events')]);
  recovery = (await recover.ready).data;
  await recover.exited;
  log(
    `重启恢复：${fmt(recovery.ms)} ms，${recovery.events} 条 / ${fmt(recovery.bytes / 1048576, 2)} MB，` +
      `损坏行 ${recovery.corruptLines}，RSS ${fmt(recovery.afterGc.rssMB)} MB`,
  );
}

// ---------- 最坏情况探针：几个 run，每个决策的 started 都接近 64 KiB。
let probe: any;
if (options.probe && options.probeRuns > 0 && options.probeDecisions > 0) {
  const probeHome = path.join(outDir, 'probe');
  const target = spawnReceiver(['--home', probeHome, '--follow', 'lt-probe-1']);
  const probeReady = await target.ready;
  const probeAgent = new http.Agent({keepAlive: true, maxSockets: options.concurrency});
  const probeBaseline = await target.call<any>('sample', {gc: true});
  const probeLatency: number[] = [];
  const jobs: string[] = [];
  for (let d = 0; d < options.probeDecisions; d++) {
    for (let r = 1; r <= options.probeRuns; r++) {
      const [startedEvent, resolvedEvent] = heavyDecisionPair(
        `lt-probe-${r}`,
        `lt-probe-host-${r}`,
        d,
        new Date().toISOString(),
      );
      jobs.push(JSON.stringify(startedEvent), JSON.stringify(resolvedEvent));
    }
  }
  const probeStart = performance.now();
  const probeInterval = options.probeRate > 0 ? 1000 / options.probeRate : 0;
  let cursor = 0;
  let probeBytes = 0;
  let probeRejected = 0;
  await Promise.all(
    Array.from({length: options.concurrency}, async () => {
      while (cursor < jobs.length) {
        const index = cursor++;
        const body = jobs[index];
        const wait = probeStart + index * probeInterval - performance.now();
        if (wait > 0) await sleep(wait);
        probeBytes += Buffer.byteLength(body);
        const result = await post(probeReady.session, probeAgent, body);
        probeLatency.push(result.ms);
        if (result.status !== 200) probeRejected += 1;
      }
    }),
  );
  const probeMs = performance.now() - probeStart;
  await sleep(300);
  const probeFinal = await target.call<any>('sample', {gc: true, deep: true});
  await target.call('exit');
  await target.exited;
  probeAgent.destroy();
  const {raw, ...rest} = probeFinal;
  probe = {
    runs: options.probeRuns,
    decisionsPerRun: options.probeDecisions,
    events: jobs.length,
    bytesSent: probeBytes,
    rejected: probeRejected,
    ms: probeMs,
    httpLatency: summarize(probeLatency),
    baseline: probeBaseline.memoryAfterGc,
    final: {
      ...rest,
      timing: Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? summarize(v) : v])),
    },
    disk: diskStats(probeHome),
  };
  log(
    `探针：${probe.events} 条 / ${fmt(probeBytes / 1048576)} MB，${fmt(probeMs / 1000)} s；store ${rest.store.events} 条 ` +
      `${fmt(rest.store.bytes / 1048576)} MB；聚合 ${rest.state.decisions} 决策，窗口外引用 ${rest.state.refsOutsideWindow} 条 ` +
      `${fmt((rest.state.outsideWindowBytes ?? 0) / 1048576)} MB；GC 后 heap ${fmt(rest.memoryAfterGc.heapUsedMB)} MB rss ` +
      `${fmt(rest.memoryAfterGc.rssMB)} MB；快照 ${fmt((rest.snapshotV8Bytes ?? 0) / 1048576, 2)} MB`,
  );
}

// ---------- 汇总
const loadSamples = samples.filter(s => s.phase === 'load' || s.phase === 'final');
const gcSeries = loadSamples
  .filter(s => s.receiver.memoryAfterGc)
  .map(s => ({t: s.t, heap: s.receiver.memoryAfterGc.heapUsedMB, rss: s.receiver.memoryAfterGc.rssMB}));
const thirds = (series: {t: number; v: number}[]) => {
  const n = series.length;
  const avg = (xs: {v: number}[]) => (xs.length ? xs.reduce((a, b) => a + b.v, 0) / xs.length : 0);
  return {
    first: avg(series.slice(0, Math.floor(n / 3))),
    middle: avg(series.slice(Math.floor(n / 3), Math.floor((2 * n) / 3))),
    last: avg(series.slice(Math.floor((2 * n) / 3))),
  };
};
const secondHalf = <T extends {t: number}>(series: T[]) => series.filter(s => s.t >= loadMs / 2000);
const heapSeries = gcSeries.map(s => ({t: s.t, v: s.heap}));
const rssSeries = loadSamples.map(s => ({t: s.t, v: s.receiver.memory.rssMB}));
const diskSeries = loadSamples.map(s => ({t: s.t, v: s.disk.bytes / 1048576}));
const perMinute = (series: {t: number; v: number}[]) =>
  Math.round(slope(secondHalf(series).map(s => ({x: s.t / 60, y: s.v}))) * 1000) / 1000;
const saturated = loadSamples.find(
  s => s.receiver.store.events >= 20000 || s.receiver.store.bytes >= 32 * 1024 * 1024 * 0.97,
);
const total = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);
const shareOfIngest = (values: readonly number[]) =>
  rawAll.ingest.length > 0 ? Math.round((total(values) / total(rawAll.ingest)) * 1000) / 1000 : 0;
const worst = (pick: (s: any) => number) => loadSamples.reduce((m, s) => Math.max(m, pick(s) || 0), 0);
const summary = {
  loadSeconds: Math.round(loadMs / 100) / 10,
  acceptedEvents: counts.accepted,
  validFailed: counts.validFailed,
  validRetries: counts.validRetries,
  heavyEvents: counts.heavy,
  generator: generator.stats,
  requests: counts.requests,
  unexpected: counts.unexpected,
  mbSent: Math.round((counts.bytesSent / 1048576) * 10) / 10,
  httpLatencyMs: summarize(allLatency),
  rejectLatencyMs: summarize(allRejectLatency),
  scheduleLagMs: summarize(allLag),
  worstWindowHttpP99Ms: worst(s => s.producer.latency.p99),
  over500ms: counts.over500ms,
  over2000ms: counts.over2000ms,
  receiver: {
    ingestMs: summarize(rawAll.ingest),
    appendFileSyncMs: summarize(rawAll.append),
    appendShareOfIngest: shareOfIngest(rawAll.append),
    writeSyncMs: summarize(rawAll.write),
    openSyncMs: summarize(rawAll.open),
    // 落盘三种调用合计占 ingest 的比例；旧写法只有 appendFileSync，新写法是 openSync + writeSync。
    diskWriteShareOfIngest: shareOfIngest([...rawAll.append, ...rawAll.write, ...rawAll.open]),
    readdirSyncMs: summarize(rawAll.readdir),
    readdirCalls: rawAll.readdir.length,
    snapshotBuildMs: summarize(rawAll.snapshotBuild),
    snapshotSerializeMs: summarize(rawAll.snapshotSerialize),
    snapshotV8Bytes: summarize(rawAll.snapshotBytes),
    snapshotsTaken: rawAll.snapshotBuild.length,
    updateLatencyMs: summarize(rawAll.updateLatency),
    pageMs: summarize(rawAll.page),
    eldP99MaxMs: worst(s => s.receiver.eld.p99),
    eldMaxMs: worst(s => s.receiver.eld.max),
    eldP50MedianMs: summarize(loadSamples.map(s => s.receiver.eld.p50)).p50,
    eluMean: summarize(loadSamples.map(s => s.receiver.elu)).mean,
    cpuPercentMean: summarize(loadSamples.map(s => s.receiver.cpuPercent)).mean,
  },
  memory: {
    baselineAfterGc: baseline.receiver.memoryAfterGc,
    finalAfterGc: final.receiver.memoryAfterGc,
    lastLoadAfterGc: [...samples].reverse().find(x => x.phase === 'load' && x.receiver.memoryAfterGc)?.receiver
      .memoryAfterGc,
    afterExportAfterGc: afterEnd.receiver.memoryAfterGc,
    peakRssMB: worst(s => s.receiver.memory.rssMB),
    peakHeapUsedMB: worst(s => s.receiver.memory.heapUsedMB),
    heapAfterGcThirdsMB: thirds(heapSeries),
    rssThirdsMB: thirds(rssSeries),
    heapAfterGcSlopeSecondHalfMBPerMin: perMinute(heapSeries),
    rssSlopeSecondHalfMBPerMin: perMinute(rssSeries),
    windowSaturatedAtS: saturated?.t,
  },
  storage: {
    finalBytes: final.disk.bytes,
    peakBytes: worst(s => s.disk.bytes),
    segments: final.disk.segments,
    segmentsCreated: final.disk.lastSegment,
    segmentsPruned: final.disk.lastSegment - final.disk.segments,
    diskSlopeSecondHalfMBPerMin: perMinute(diskSeries),
  },
  finalState: final.receiver.state,
  finalStore: final.receiver.store,
  finalSnapshotJsonBytes: final.receiver.snapshotJsonBytes,
  finalSnapshotV8Bytes: final.receiver.snapshotV8Bytes,
};

const report = {
  meta: {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    options,
    machine,
    receiverRuntime: ready.runtime,
    followRun,
  },
  summary,
  export: exported,
  exportDuringLoad: exportDuring,
  replay: replayed,
  recovery,
  probe,
  samples,
};
fs.writeFileSync(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
fs.writeFileSync(path.join(outDir, 'report.md'), markdown(report));
log(`报告：${path.relative(root, path.join(outDir, 'report.md'))}`);

function markdown(r: typeof report) {
  const s = r.summary;
  const m = s.memory;
  const rc = s.receiver;
  const ms = (x: Summary) =>
    `p50 ${fmt(x.p50, 2)} / p95 ${fmt(x.p95, 2)} / p99 ${fmt(x.p99, 2)} / max ${fmt(x.max, 2)} ms`;
  const kb = (x: Summary) =>
    `p50 ${fmt(x.p50 / 1024, 0)} / p95 ${fmt(x.p95 / 1024, 0)} / max ${fmt(x.max / 1024, 0)} KiB`;
  const rt = r.meta.receiverRuntime as Record<string, string | undefined>;
  const lines = [
    `# 合成负载报告 ${r.meta.startedAt}`,
    '',
    `- 机器：${r.meta.machine.os}，${r.meta.machine.cpu}，${r.meta.machine.cores} 核，${r.meta.machine.ramGB} GB，${r.meta.machine.arch}`,
    `- 驱动进程 Node ${r.meta.machine.node}；接收端 ${r.meta.options.runtime}（Node ${rt.node}${rt.electron ? `，Electron ${rt.electron}` : ''}）；提交 ${r.meta.machine.commit ?? '未知'}`,
    `- 参数：时长 ${fmt(r.meta.options.durationMs / 60000)} 分钟；目标 ${r.meta.options.events} 条（${fmt(r.meta.options.rate, 2)}/s，每 ${fmt(r.meta.options.burstEveryMs / 60000)} 分钟突发 ${r.meta.options.burstSize} 条）；并发 ${r.meta.options.concurrency}；约 ${r.meta.options.runs} 个普通 run + ${r.meta.options.marathons} 个长 run；heavy ${r.meta.options.heavyRatio}；拒绝请求 ${r.meta.options.rejectRatio}；渲染模拟跟随 ${r.meta.followRun}`,
    '',
    '## 结果',
    '',
    `- 实际负载 ${fmt(s.loadSeconds / 60, 2)} 分钟，接受 ${s.acceptedEvents} 条有效事件（其中近上限 ${s.heavyEvents} 条），发送 ${s.mbSent} MB；有效事件失败 ${s.validFailed}，重试 ${s.validRetries}，异常响应 ${s.unexpected.length}`,
    `- 请求状态：${Object.entries(s.requests)
      .map(([k, v]) => `${k} ${JSON.stringify(v)}`)
      .join('；')}`,
    `- 生成器：${s.generator.runsStarted} 个 run；类型 ${JSON.stringify(s.generator.byType)}`,
    `- HTTP 往返（有效事件）：${ms(s.httpLatencyMs)}；最差窗口 p99 ${fmt(s.worstWindowHttpP99Ms, 2)} ms；超过 500 ms（Python 发送端默认超时）${s.over500ms} 次，超过 2 s ${s.over2000ms} 次；被拒请求 ${ms(s.rejectLatencyMs)}；排程滞后 ${ms(s.scheduleLagMs)}`,
    `- 接收端 ingest（校验+脱敏+落盘+聚合）：${ms(rc.ingestMs)}`,
    `- 落盘：appendFileSync ${rc.appendFileSyncMs.count} 次，${ms(rc.appendFileSyncMs)}；writeSync ${rc.writeSyncMs.count} 次，${ms(rc.writeSyncMs)}；openSync ${rc.openSyncMs.count} 次；三者共占 ingest 时间 ${fmt(rc.diskWriteShareOfIngest * 100)}%`,
    `- readdirSync ${rc.readdirCalls} 次，${ms(rc.readdirSyncMs)}`,
    `- 快照（每次更新，v8.serialize 近似 IPC）：构建 ${ms(rc.snapshotBuildMs)}；序列化 ${ms(rc.snapshotSerializeMs)}；大小 ${kb(rc.snapshotV8Bytes)}；共 ${rc.snapshotsTaken} 次`,
    `- 主进程侧更新延迟（入库到快照序列化完成，含 50 ms 合并与 100 ms 节流）：${ms(rc.updateLatencyMs)}`,
    `- 分页（加载更早）：${ms(rc.pageMs)}`,
    `- 事件循环阻塞（monitorEventLoopDelay 减去 10 ms 采样间隔）：各窗口 p50 中位 ${fmt(rc.eldP50MedianMs, 2)} ms，最差窗口 p99 ${fmt(rc.eldP99MaxMs, 2)} ms，最大 ${fmt(rc.eldMaxMs, 2)} ms；ELU 平均 ${fmt(rc.eluMean * 100)}%；CPU 平均 ${fmt(rc.cpuPercentMean)}%`,
    '',
    '## 内存',
    '',
    `- 基线（GC 后）：RSS ${fmt(m.baselineAfterGc?.rssMB)} MB，heapUsed ${fmt(m.baselineAfterGc?.heapUsedMB)} MB`,
    `- 负载最后一次 GC 采样：RSS ${fmt(m.lastLoadAfterGc?.rssMB)} MB，heapUsed ${fmt(m.lastLoadAfterGc?.heapUsedMB)} MB，external ${fmt(m.lastLoadAfterGc?.externalMB)} MB`,
    `- 结束（GC 后）：RSS ${fmt(m.finalAfterGc?.rssMB)} MB，heapUsed ${fmt(m.finalAfterGc?.heapUsedMB)} MB，external ${fmt(m.finalAfterGc?.externalMB)} MB`,
    `- 峰值：RSS ${fmt(m.peakRssMB)} MB，heapUsed ${fmt(m.peakHeapUsedMB)} MB（未强制 GC 的采样）`,
    `- GC 后 heapUsed 三段均值：${fmt(m.heapAfterGcThirdsMB.first)} → ${fmt(m.heapAfterGcThirdsMB.middle)} → ${fmt(m.heapAfterGcThirdsMB.last)} MB；后半程斜率 ${m.heapAfterGcSlopeSecondHalfMBPerMin} MB/分钟`,
    `- RSS 三段均值：${fmt(m.rssThirdsMB.first)} → ${fmt(m.rssThirdsMB.middle)} → ${fmt(m.rssThirdsMB.last)} MB；后半程斜率 ${m.rssSlopeSecondHalfMBPerMin} MB/分钟`,
    `- 内存窗口（20000 条或 32 MiB）饱和于 ${m.windowSaturatedAtS === undefined ? '未饱和' : `${fmt(m.windowSaturatedAtS / 60)} 分钟`}`,
    `- 结束时 store：${s.finalStore.events} 条，${fmt(s.finalStore.bytes / 1048576, 2)} MB，ids ${s.finalStore.ids}，sequences ${s.finalStore.sequences}，droppedRuns ${s.finalStore.droppedRuns}`,
    `- 结束时聚合：${s.finalState.runs} 个 run（未结束 ${s.finalState.openRuns}，触顶 ${s.finalState.limitedRuns}），决策 ${s.finalState.decisions}（单 run 最多 ${s.finalState.maxDecisions}），尝试 ${s.finalState.attempts}（单 run 最多 ${s.finalState.maxAttempts}）；引用事件 ${s.finalState.eventRefs} 条，其中已移出内存窗口 ${s.finalState.refsOutsideWindow} 条 / ${fmt((s.finalState.outsideWindowBytes ?? 0) / 1048576, 2)} MB；聚合状态 JSON ${fmt((s.finalState.stateJsonBytes ?? 0) / 1048576, 2)} MB`,
    `- 结束时所选 run 快照：JSON ${fmt((s.finalSnapshotJsonBytes ?? 0) / 1024, 0)} KiB，v8 ${fmt((s.finalSnapshotV8Bytes ?? 0) / 1024, 0)} KiB`,
    '',
    '## 存储',
    '',
    `- 结束 ${fmt(s.storage.finalBytes / 1048576, 2)} MB，峰值 ${fmt(s.storage.peakBytes / 1048576, 2)} MB，保留 ${s.storage.segments} 段；共创建 ${s.storage.segmentsCreated} 段，删除 ${s.storage.segmentsPruned} 段；后半程斜率 ${s.storage.diskSlopeSecondHalfMBPerMin} MB/分钟`,
    '',
    '## 导出、回放、重启',
    '',
    `- 导出（UI 的导出路径，同步）：${fmt(r.export.ms)} ms，${fmt(r.export.bytes / 1048576, 2)} MB，跳过 ${r.export.skipped}；前后 RSS ${fmt(r.export.before.rssMB)} → ${fmt(r.export.after.rssMB)} MB`,
    r.exportDuringLoad
      ? `- 负载进行中导出（第 ${fmt(r.exportDuringLoad.atS / 60)} 分钟）：${fmt(r.exportDuringLoad.ms)} ms，${fmt(r.exportDuringLoad.bytes / 1048576, 2)} MB；导出期间及之后 0.5 s 内完成的有效请求 ${r.exportDuringLoad.httpDuring?.count ?? 0} 个，HTTP ${r.exportDuringLoad.httpDuring ? ms(r.exportDuringLoad.httpDuring) : '未测'}`
      : '- 负载进行中导出：未测',
    `- 回放打开：读取+解析 ${fmt(r.replay.parseMs)} ms，${r.replay.events} 条（截断 ${r.replay.truncated}，略过更早的 ${r.replay.omitted} 条，无效行 ${r.replay.invalidLines}）；IPC 一次返回 ${fmt(r.replay.ipcBytes / 1048576, 2)} MB，序列化 ${fmt(r.replay.serializeMs)} ms`,
    `- 回放拖动（渲染端）：从头重算 replaySnapshot 全量 ${fmt(r.replay.replaySnapshotFullMs)} ms，一半 ${fmt(r.replay.replaySnapshotMidMs)} ms；检查点 ReplayTimeline 首次全量 ${fmt(r.replay.timelineFirstMs)} ms，跳到一半 ${fmt(r.replay.timelineMidMs, 2)} ms，再前进一条 ${fmt(r.replay.timelineStepMs, 2)} ms；pageReplay ${fmt(r.replay.replayPageMs, 2)} ms`,
    r.recovery
      ? `- 重启恢复（新进程读保留段）：${fmt(r.recovery.ms)} ms，${r.recovery.events} 条，${fmt(r.recovery.bytes / 1048576, 2)} MB，损坏行 ${r.recovery.corruptLines}；GC 后 RSS ${fmt(r.recovery.afterGc.rssMB)} MB，heap ${fmt(r.recovery.afterGc.heapUsedMB)} MB`
      : '- 重启恢复：未测',
    '',
    '## 最坏情况探针',
    '',
    r.probe
      ? [
          `- ${r.probe.runs} 个 run × ${r.probe.decisionsPerRun} 个决策，每个 decision.started 约 60 KB；共 ${r.probe.events} 条，${fmt(r.probe.bytesSent / 1048576)} MB，${fmt(r.probe.ms / 1000)} s（${r.meta.options.probeRate}/s），拒绝 ${r.probe.rejected}`,
          `- 探针期间：快照构建 ${ms(r.probe.final.timing.snapshotBuild)}；序列化 ${ms(r.probe.final.timing.snapshotSerialize)}；大小 ${kb(r.probe.final.timing.snapshotBytes)}；ingest ${ms(r.probe.final.timing.ingest)}；主进程侧更新延迟 ${ms(r.probe.final.timing.updateLatency)}`,
          `- store 窗口 ${r.probe.final.store.events} 条 / ${fmt(r.probe.final.store.bytes / 1048576, 2)} MB；聚合保留决策 ${r.probe.final.state.decisions}，窗口外引用 ${r.probe.final.state.refsOutsideWindow} 条 / ${fmt((r.probe.final.state.outsideWindowBytes ?? 0) / 1048576, 2)} MB；聚合状态 JSON ${fmt((r.probe.final.state.stateJsonBytes ?? 0) / 1048576, 2)} MB`,
          `- GC 后内存：基线 heap ${fmt(r.probe.baseline.heapUsedMB)} / RSS ${fmt(r.probe.baseline.rssMB)} MB → heap ${fmt(r.probe.final.memoryAfterGc.heapUsedMB)} / RSS ${fmt(r.probe.final.memoryAfterGc.rssMB)} MB`,
          `- 所选 run 快照：v8 ${fmt((r.probe.final.snapshotV8Bytes ?? 0) / 1048576, 2)} MB，JSON ${fmt((r.probe.final.snapshotJsonBytes ?? 0) / 1048576, 2)} MB；HTTP ${ms(r.probe.httpLatency)}`,
        ].join('\n')
      : '- 未运行',
    '',
    '## 限制',
    '',
    '- 接收端在独立 Node/Electron-as-node 进程中运行，不含 Chromium 渲染进程与窗口；可见更新延迟（渲染与绘制）不在本报告内。',
    '- 快照 IPC 成本用 v8.serialize 近似 Electron 结构化克隆；每 60 秒强制 GC 一次测保留内存，强制 GC 与测量自身的停顿已从事件循环延迟中排除。',
    '- 生产者与接收端在同一台机器上，机器上的其他负载会进入延迟数字（见各采样的 loadavg1）。',
    '',
  ];
  return lines.join('\n');
}

// 合成负载生成器：只产生协议 v1 的事件，供 `pnpm loadtest` 与单元测试共用。
// 同一个种子产生同一串事件（occurred_at 取自传入的时钟）。
import type {MonitorEvent, Payload} from '../../src/protocol';

export const BODY_LIMIT = 65536;
/** 「接近单条上限」的事件落在这个字节区间（请求体，UTF-8）。 */
export const HEAVY_MIN_BYTES = 60_000;
export const HEAVY_MAX_BYTES = 64_500;

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface GeneratorOptions {
  seed?: number;
  /** 期望的总事件数，用来估算每个普通 run 的步数。 */
  events?: number;
  /** 普通 run 的目标个数；超过 200 才会触发聚合状态的 run 淘汰。 */
  runs?: number;
  /** 贯穿全程的长 run 个数，用来把单个 run 的决策/尝试推过 500 上限。 */
  marathons?: number;
  /** 分给长 run 的事件比例。 */
  marathonShare?: number;
  /** 同时交错的普通 run 数。 */
  concurrentRuns?: number;
  /** 接近 64 KiB 上限的事件比例（近似）。 */
  heavyRatio?: number;
  now?: () => Date;
}

type Draft = Omit<MonitorEvent, 'schema_version' | 'event_id' | 'run_id' | 'producer_id' | 'sequence' | 'occurred_at'>;

interface RunScript {
  id: string;
  producer: string;
  sequence: number;
  step: number;
  stepsLeft: number;
  queue: Draft[];
  finished: boolean;
}

export interface GeneratorStats {
  events: number;
  heavy: number;
  heavyDiagnostic: number;
  runsStarted: number;
  byType: Record<string, number>;
}

const words = ['前进', '后退', '拾取', '等待', '攻击', '绕行', 'scan', 'move', 'retry', 'probe', 'check', 'idle'];
const kinds = ['choice', 'score', 'noul'] as const;
const questions = ['next', 'danger', 'goal'] as const;

export class LoadGenerator {
  readonly stats: GeneratorStats = {events: 0, heavy: 0, heavyDiagnostic: 0, runsStarted: 0, byType: {}};
  private readonly random: () => number;
  private readonly now: () => Date;
  private readonly tag: string;
  private readonly marathons: RunScript[] = [];
  private readonly active: RunScript[] = [];
  private readonly concurrent: number;
  private readonly marathonShare: number;
  private readonly heavyRatio: number;
  private readonly stepsPerRun: number;
  private runIndex = 0;
  private marathonTurn = 0;

  constructor(options: GeneratorOptions = {}) {
    const seed = options.seed ?? 1;
    this.random = mulberry32(seed);
    this.now = options.now ?? (() => new Date());
    this.tag = (seed >>> 0).toString(16);
    this.concurrent = Math.max(1, options.concurrentRuns ?? 6);
    this.marathonShare = options.marathons === 0 ? 0 : (options.marathonShare ?? 0.3);
    this.heavyRatio = options.heavyRatio ?? 0.02;
    const events = options.events ?? 36000;
    const runs = Math.max(1, options.runs ?? 600);
    // 一步平均约 8.7 条事件，run 头尾约 3 条。
    this.stepsPerRun = Math.max(1, ((events * (1 - this.marathonShare)) / runs - 3) / 8.7);
    for (let i = 0; i < (options.marathons ?? 1); i++) {
      this.marathons.push(this.spawn(`marathon-${i + 1}`, Number.POSITIVE_INFINITY));
    }
  }

  /** 长 run 的 id，供渲染模拟显式选中。 */
  get marathonIds(): string[] {
    return this.marathons.map(run => run.id);
  }

  next(): MonitorEvent {
    const run = this.pickRun();
    const draft = run.queue.shift()!;
    run.sequence += 1;
    const event: MonitorEvent = {
      schema_version: 1,
      event_id: `${run.id}:${run.sequence}`,
      run_id: run.id,
      producer_id: run.producer,
      sequence: run.sequence,
      occurred_at: this.now().toISOString(),
      ...draft,
    };
    this.stats.events += 1;
    this.stats.byType[event.type] = (this.stats.byType[event.type] ?? 0) + 1;
    return event;
  }

  private chance(p: number) {
    return this.random() < p;
  }

  private int(min: number, max: number) {
    return min + Math.floor(this.random() * (max - min + 1));
  }

  private pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.random() * items.length)];
  }

  private text(length: number) {
    let out = '';
    while (out.length < length) out += `${this.pick(words)} `;
    return out.slice(0, length);
  }

  private spawn(label: string, steps: number): RunScript {
    this.runIndex += 1;
    this.stats.runsStarted += 1;
    const id = `lt-${this.tag}-${label}`;
    const run: RunScript = {
      id,
      producer: `lt-host-${this.tag}-${this.runIndex}`,
      sequence: 0,
      step: 0,
      stepsLeft: steps,
      queue: [],
      finished: false,
    };
    run.queue.push({type: 'run.started', payload: {name: `负载 ${label}`, simulated: true}});
    run.queue.push({
      type: 'progress.updated',
      payload: {phase: 'start', completed: 0, total: Number.isFinite(steps) ? steps : 0},
    });
    return run;
  }

  private pickRun(): RunScript {
    if (this.marathons.length > 0 && this.chance(this.marathonShare)) {
      const run = this.marathons[this.marathonTurn++ % this.marathons.length];
      if (run.queue.length === 0) this.fill(run);
      return run;
    }
    for (;;) {
      while (this.active.length < this.concurrent) {
        const steps = Math.max(1, Math.round(this.stepsPerRun * (0.5 + this.random())));
        this.active.push(this.spawn(`r${String(this.runIndex + 1).padStart(6, '0')}`, steps));
      }
      const index = Math.floor(this.random() * this.active.length);
      const run = this.active[index];
      if (run.queue.length === 0) this.fill(run);
      if (run.queue.length > 0) return run;
      this.active.splice(index, 1);
    }
  }

  private fill(run: RunScript) {
    if (run.stepsLeft > 0) {
      run.stepsLeft -= 1;
      run.step += 1;
      this.step(run);
      return;
    }
    if (run.finished) return;
    run.finished = true;
    const roll = this.random();
    // 约 8% 的 run 没有终态事件，用来检验未结束 run 的淘汰。
    if (roll < 0.8) run.queue.push({type: 'run.completed', payload: {summary: `完成 ${run.step} 步`}});
    else if (roll < 0.88) run.queue.push({type: 'run.failed', payload: {reason: '模拟失败'}});
    else if (roll < 0.92) run.queue.push({type: 'run.cancelled', payload: {reason: '模拟取消'}});
  }

  private step(run: RunScript) {
    const n = run.step;
    const request = `req-${n}`;
    const count = this.random() < 0.6 ? 1 : this.random() < 0.75 ? 2 : 3;
    const decisions: {id: string; kind: (typeof kinds)[number]; choice?: string; failed: boolean}[] = [];
    for (let q = 0; q < count; q++) {
      const kind = q === 0 ? 'choice' : this.pick(kinds);
      const ids = {decision_id: `d${n}-${q}`, request_id: request, question_id: questions[q]};
      const candidates = ['a', 'b', 'c', 'd', 'e'].slice(0, this.int(2, 5));
      const started: Payload = {kind, question: `${questions[q]}：${this.text(this.int(8, 60))}`};
      if (kind === 'choice') {
        started.candidates = Object.fromEntries(candidates.map(c => [c, this.chance(0.3) ? null : this.text(12)]));
      }
      if (kind === 'score') started.legend = {'0': '差', '1': '好'};
      run.queue.push({type: 'decision.started', ...ids, payload: this.maybeHeavyDecision(started)});
      if (this.chance(0.03)) {
        run.queue.push({type: 'decision.failed', ...ids, payload: {reason: 'timeout', latency_ms: 2000}});
        decisions.push({id: ids.decision_id, kind, failed: true});
        continue;
      }
      const resolved: Payload = {kind, model: 'typesafe-sim', latency_ms: this.int(20, 900)};
      let choice: string | undefined;
      if (kind === 'choice') {
        choice = this.pick(candidates);
        resolved.choice = choice;
        resolved.probabilities = this.distribution(candidates, choice);
        resolved.confidence = Math.round(this.random() * 1000) / 1000;
        if (this.chance(0.4)) {
          resolved.explanation = `偏好 ${choice}：${this.text(this.int(10, 120))}`;
          resolved.explanation_source = 'model';
        }
      } else if (kind === 'score') {
        resolved.score = Math.round(this.random() * 1000) / 100;
        resolved.confidence = Math.round(this.random() * 1000) / 1000;
      } else {
        resolved.noul = Math.round(this.random() * 1000) / 1000;
      }
      if (this.chance(0.05)) resolved.usage = {input_tokens: this.int(100, 3000), output_tokens: this.int(1, 50)};
      run.queue.push({type: 'decision.resolved', ...ids, payload: resolved});
      decisions.push({id: ids.decision_id, kind, choice, failed: false});
    }
    const lead = decisions[0];
    if (!lead.failed && lead.choice) this.act(run, n, lead.id, lead.choice);
    run.queue.push({
      type: 'progress.updated',
      payload: this.maybeHeavyDiagnostic({
        phase: 'step',
        completed: n,
        total: Number.isFinite(run.stepsLeft) ? n + run.stepsLeft : n,
        summary: this.chance(0.05) ? `调用 token=${this.text(4)}abc123def456 已脱敏` : `第 ${n} 步`,
      }),
    });
    if (this.chance(0.3)) run.queue.push({type: 'heartbeat', payload: {}});
    if (this.chance(0.02)) run.queue.push({type: 'telemetry.dropped', payload: {count: this.int(1, 5)}});
  }

  private act(run: RunScript, n: number, decision: string, choice: string) {
    const roll = this.random();
    const selected: Payload =
      roll < 0.7
        ? {action: choice, source: 'model'}
        : roll < 0.9
          ? {action: `${choice}-alt`, source: 'rule', rule: 'avoid-danger', rule_source: 'policy.yaml'}
          : {action: `${choice}-app`, source: 'application', reason: '应用层改选'};
    const attempt = (id: string, retry?: number) => {
      const ids = {action_id: `act-${n}`, attempt_id: id, decision_id: decision};
      run.queue.push({type: 'action.selected', ...ids, payload: retry ? {...selected, retry} : selected});
      run.queue.push({type: 'action.started', ...ids, payload: {}});
      return ids;
    };
    let ids = attempt('t1');
    const outcome = this.random();
    if (outcome < 0.12) {
      run.queue.push({type: 'action.failed', ...ids, payload: {reason: 'timeout'}});
      ids = attempt('t2', 1);
    } else if (outcome < 0.15) {
      run.queue.push({type: 'action.cancelled', ...ids, payload: {reason: '宿主取消'}});
      return;
    } else if (outcome < 0.2) {
      // 缺少完成事件：停在「执行中」。
      return;
    }
    run.queue.push({type: 'action.completed', ...ids, payload: {latency_ms: this.int(5, 400)}});
    if (this.chance(0.15)) return;
    const verdict = this.random();
    const result = verdict < 0.75 ? 'passed' : verdict < 0.9 ? 'failed' : 'unknown';
    run.queue.push({
      type: 'verification.completed',
      ...ids,
      payload: this.maybeHeavyVerification({
        result,
        checks: [{name: 'moved', observed: this.text(16), result, evidence: 'frame-diff'}],
      }),
    });
  }

  private distribution(candidates: string[], choice: string): Record<string, number> {
    const weights = candidates.map(c => (c === choice ? 3 : 0.2) + this.random());
    const sum = weights.reduce((a, b) => a + b, 0);
    const rounded = weights.map(w => Math.round((w / sum) * 1000) / 1000);
    const error = 1 - rounded.reduce((a, b) => a + b, 0);
    rounded[0] = Math.max(0, Math.round((rounded[0] + error) * 1000) / 1000);
    return Object.fromEntries(candidates.map((c, i) => [c, rounded[i]]));
  }

  private heavyTarget() {
    return HEAVY_MIN_BYTES + Math.floor(this.random() * (HEAVY_MAX_BYTES - HEAVY_MIN_BYTES));
  }

  // 大负载只放 ASCII 填充，字节数等于字符数，便于精确落在区间内。
  private filler(length: number) {
    const unit = 'observation-frame-0123456789-';
    return unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
  }

  private maybeHeavyDecision(payload: Payload): Payload {
    if (!this.chance(this.heavyRatio * 3)) return payload;
    this.stats.heavy += 1;
    const heavy: Payload = {...payload, question: `大问题：${this.filler(4000)}`};
    if (heavy.kind === 'choice') heavy.candidates = {};
    const dictionary = heavy.kind === 'choice' ? heavy.candidates! : (heavy.legend = {});
    for (let i = 0; i < 16; i++) dictionary[`c${String(i).padStart(2, '0')}`] = this.filler(4000);
    return this.fit(heavy, dictionary);
  }

  private maybeHeavyVerification(payload: Payload): Payload {
    if (!this.chance(this.heavyRatio * 3.3)) return payload;
    this.stats.heavy += 1;
    const checks = Array.from({length: 16}, (_, i) => ({
      name: `check-${i}`,
      observed: 'ok',
      result: payload.result!,
      evidence: this.filler(4000),
    }));
    const heavy: Payload = {...payload, checks};
    const envelope = 260;
    const target = this.heavyTarget() - envelope;
    let size = Buffer.byteLength(JSON.stringify(heavy));
    while (size > target && checks.length > 1) {
      const last = checks[checks.length - 1];
      const cut = Math.min(last.evidence.length, size - target);
      last.evidence = last.evidence.slice(0, last.evidence.length - cut);
      if (!last.evidence) checks.pop();
      size = Buffer.byteLength(JSON.stringify(heavy));
    }
    return heavy;
  }

  private maybeHeavyDiagnostic(payload: Payload): Payload {
    if (!this.chance(this.heavyRatio * 1.8)) return payload;
    // diagnostic 默认不入库：请求体接近上限，落盘后只剩摘要。
    this.stats.heavyDiagnostic += 1;
    return {...payload, diagnostic: {frames: this.filler(this.heavyTarget() - 600)}};
  }

  private fit(payload: Payload, dictionary: Record<string, string | null>): Payload {
    const envelope = 260;
    const target = this.heavyTarget() - envelope;
    const keys = Object.keys(dictionary);
    let size = Buffer.byteLength(JSON.stringify(payload));
    while (size > target && keys.length > 0) {
      const key = keys[keys.length - 1];
      const value = dictionary[key] ?? '';
      const cut = Math.min(value.length, size - target);
      if (cut >= value.length) {
        delete dictionary[key];
        keys.pop();
      } else dictionary[key] = value.slice(0, value.length - cut);
      size = Buffer.byteLength(JSON.stringify(payload));
    }
    return payload;
  }
}

/** 被拒请求的种类。计数单独统计，不计入有效事件。 */
export type RejectKind =
  'oversize' | 'oversize-chunked' | 'malformed' | 'invalid' | 'unauthorized' | 'duplicate' | 'conflict';

export const rejectKinds: readonly RejectKind[] = [
  'oversize',
  'oversize-chunked',
  'malformed',
  'invalid',
  'unauthorized',
  'duplicate',
  'conflict',
];

/** 超过 64 KiB 的请求体（原样是合法事件，只是太大）。 */
export function oversizeBody(base: MonitorEvent): string {
  const event = {...base, event_id: `${base.event_id}:big`, payload: {summary: 'x', diagnostic: 'y'.repeat(70_000)}};
  return JSON.stringify(event);
}

/** 截断的 JSON。 */
export function malformedBody(base: MonitorEvent): string {
  return JSON.stringify(base).slice(0, 40);
}

/** 能解析但违反协议：按轮次换一种错法。 */
export function invalidBody(base: MonitorEvent, variant: number): string {
  const ids = {decision_id: 'dx', request_id: 'rx', question_id: 'qx'};
  const bad: Record<string, unknown>[] = [
    {...base, event_id: `${base.event_id}:bad0`, type: 'decision.started', ...ids, payload: {kind: 'choice'}},
    {
      ...base,
      event_id: `${base.event_id}:bad1`,
      type: 'decision.resolved',
      ...ids,
      payload: {kind: 'choice', choice: 'a', probabilities: {a: 0.5, b: 0.1}},
    },
    {...base, event_id: `${base.event_id}:bad2`, payload: {unexpected: true}},
    {...base, event_id: `${base.event_id}:bad3`, schema_version: 2},
    {
      ...base,
      event_id: `${base.event_id}:bad4`,
      type: 'decision.resolved',
      ...ids,
      payload: {kind: 'noul', noul: 0.5, confidence: 0.9},
    },
  ];
  return JSON.stringify(bad[variant % bad.length]);
}

/** 同一 run/producer/sequence、不同 event_id：接收端应回 409。 */
export function conflictOf(event: MonitorEvent, n: number): MonitorEvent {
  return {...event, event_id: `${event.event_id}:conflict${n}`};
}

/** 最坏情况探针：一个 run 里每个决策都带接近上限的问题与候选。 */
export function heavyDecisionPair(
  runId: string,
  producer: string,
  index: number,
  occurredAt: string,
): [MonitorEvent, MonitorEvent] {
  const unit = 'observation-frame-0123456789-';
  const filler = (n: number) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
  const ids = {decision_id: `d${index}`, request_id: `req-${index}`, question_id: 'next'};
  const candidates: Record<string, string> = {};
  for (let i = 0; i < 14; i++) candidates[`c${String(i).padStart(2, '0')}`] = filler(4000);
  const base = {schema_version: 1 as const, run_id: runId, producer_id: producer, occurred_at: occurredAt};
  return [
    {
      ...base,
      event_id: `${runId}:${index * 2 + 1}`,
      sequence: index * 2 + 1,
      type: 'decision.started',
      ...ids,
      payload: {kind: 'choice', question: filler(4000), candidates},
    },
    {
      ...base,
      event_id: `${runId}:${index * 2 + 2}`,
      sequence: index * 2 + 2,
      type: 'decision.resolved',
      ...ids,
      payload: {kind: 'choice', choice: 'c00', probabilities: {c00: 0.9, c01: 0.1}, confidence: 0.7},
    },
  ];
}

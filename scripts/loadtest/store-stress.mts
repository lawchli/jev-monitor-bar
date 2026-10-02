// Offline, short-burst capacity regression. No HTTP/socket, child process, Electron or UI latency claims.
// node --import tsx scripts/loadtest/store-stress.mts [--events 24000] [--seed 1] [--out .runtime/store-stress]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {validateEvent, eventTypes, type MonitorEvent} from '../../src/protocol';
import {parseReplay} from '../../src/replay';
import {sanitizeEvent} from '../../src/redact';
import {MAX_EVICTED, MAX_RUNS} from '../../src/state';
import {EventStore} from '../../src/store';
import {BODY_LIMIT, conflictOf, LoadGenerator} from './generator';
import {summarize} from './stats';

export const DEFAULT_STRESS_EVENTS = 24000;
export const MAX_STRESS_EVENTS = 250000;
const MEMORY_LIMIT = 32 * 1024 * 1024;
const MAX_EVENTS = 20000;
const SEGMENT_LIMIT = 4 * 1024 * 1024;
const MAX_SEGMENTS = 8;
const METADATA_LIMIT = 1024 * 1024;
const root = path.resolve(import.meta.dirname, '../..');

export interface StoreStressOptions {
  events: number;
  seed: number;
  /** Parent directory only: every run creates a new mkdtemp child and never clears existing files. */
  out: string;
}

function integer(text: string, name: string, min: number, max: number) {
  const value = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`--${name} must be an integer in [${min}, ${max}]`);
  return value;
}

export function parseStoreStressArgs(argv: string[]): StoreStressOptions {
  const {values} = parseArgs({
    args: argv,
    options: {events: {type: 'string'}, seed: {type: 'string'}, out: {type: 'string'}},
    strict: true,
    allowPositionals: false,
  });
  if (values.out !== undefined && values.out.trim() === '') throw new Error('--out must not be empty');
  return {
    events: integer(values.events ?? String(DEFAULT_STRESS_EVENTS), 'events', 1, MAX_STRESS_EVENTS),
    seed: integer(values.seed ?? '1', 'seed', 0, 0xffffffff),
    out: path.resolve(root, values.out ?? '.runtime/store-stress'),
  };
}

const memory = () => {
  const {rss, heapUsed, heapTotal, external, arrayBuffers} = process.memoryUsage();
  return {rss, heapUsed, heapTotal, external, arrayBuffers};
};

/** Inspect private bounded caches without altering them; this is diagnostic code, not application behavior. */
function bounds(store: EventStore) {
  const evicted = (store as unknown as {evictedRuns: Map<string, unknown>}).evictedRuns;
  const decisions = Math.max(0, ...[...store.runs.values()].map(run => Object.keys(run.decisions).length));
  const attempts = Math.max(0, ...[...store.runs.values()].map(run => Object.keys(run.attempts).length));
  assert.ok(store.events.length <= MAX_EVENTS, 'event count exceeded its retention limit');
  assert.ok(store.bytes <= MEMORY_LIMIT, 'event bytes exceeded 32 MiB');
  assert.ok(store.runs.size <= MAX_RUNS, 'run count exceeded its limit');
  assert.ok(evicted.size <= MAX_EVICTED, 'evicted-run cache exceeded its limit');
  assert.ok(decisions <= 500 && attempts <= 500, 'per-run table exceeded 500');
  assert.equal(store.corruptLines, 0, 'unexpected corrupt persisted rows');
  assert.deepEqual(store.unreadableSegments, [], 'unexpected unreadable segment');
  assert.equal(store.storageError, undefined, 'unexpected storage degradation');
  return {
    events: store.events.length,
    bytes: store.bytes,
    runs: store.runs.size,
    evicted: evicted.size,
    decisions,
    attempts,
  };
}

function disk(directory: string) {
  const files = fs.readdirSync(directory);
  const segments = files.filter(name => /^events-\d{8}\.jsonl$/.test(name));
  const sizes = segments.map(name => fs.statSync(path.join(directory, name)).size);
  assert.ok(segments.length <= MAX_SEGMENTS, 'retained disk segments exceeded limit');
  assert.ok(
    sizes.every(size => size <= SEGMENT_LIMIT),
    'generated row exceeded its segment budget',
  );
  const metadataFile = path.join(directory, 'runs.json');
  const metadataBytes = fs.existsSync(metadataFile) ? fs.statSync(metadataFile).size : 0;
  const metadataRecords = metadataBytes
    ? (JSON.parse(fs.readFileSync(metadataFile, 'utf8')).runs as unknown[]).length
    : 0;
  assert.ok(metadataBytes <= METADATA_LIMIT && metadataRecords <= MAX_RUNS + MAX_EVICTED, 'metadata bounds exceeded');
  assert.ok(!files.some(name => name.endsWith('.tmp')), 'unexpected unfinished metadata temp file');
  return {
    segments: segments.length,
    segmentBytes: sizes.reduce((sum, size) => sum + size, 0),
    largestSegmentBytes: Math.max(0, ...sizes),
    metadataBytes,
    metadataRecords,
    totalBytes: files.reduce((sum, name) => sum + fs.statSync(path.join(directory, name)).size, 0),
  };
}

function withoutDiskWrites(check: () => void) {
  type Fn = (...args: unknown[]) => unknown;
  const table = fs as unknown as Record<string, Fn>;
  const methods = [
    'writeSync',
    'writeFileSync',
    'appendFileSync',
    'renameSync',
    'unlinkSync',
    'truncateSync',
    'ftruncateSync',
    'mkdirSync',
    'chmodSync',
  ];
  const originals = new Map(methods.map(name => [name, table[name]]));
  const writes: string[] = [];
  try {
    for (const [name, original] of originals) {
      table[name] = function (this: unknown, ...args: unknown[]) {
        writes.push(name);
        return original.apply(this, args);
      };
    }
    check();
    assert.deepEqual(writes, [], 'duplicate/conflict changed the filesystem');
  } finally {
    for (const [name, original] of originals) table[name] = original;
  }
}

export function runStoreStress(options: StoreStressOptions) {
  // Validate exported API inputs too, before creating any directory.
  const checked = parseStoreStressArgs([
    '--events',
    String(options.events),
    '--seed',
    String(options.seed),
    '--out',
    options.out,
  ]);
  fs.mkdirSync(checked.out, {recursive: true});
  const output = fs.mkdtempSync(path.join(checked.out, 'run-'));
  const directory = path.join(output, 'events');
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const startedCpu = process.cpuUsage();
  const beforeMemory = memory();
  const store = new EventStore(directory);
  let reopened: EventStore | undefined;
  const ingestMs: number[] = [];
  const observations = {events: 0, bytes: 0, runs: 0, evicted: 0, decisions: 0, attempts: 0};
  const peakMemory = {...beforeMemory};
  let inputBytes = 0;
  let storedBytesWritten = 0;
  let eventLimitEvictions = 0;
  let byteLimitEvictions = 0;
  let greatestSegment = 0;
  let lastEvent: MonitorEvent | undefined;
  const seenRuns = new Set<string>();
  const seenTypes = new Set<string>();
  const decisionsByRun = new Map<string, Set<string>>();
  const attemptsByRun = new Map<string, Set<string>>();
  let tick = Date.UTC(2026, 0, 1);
  const lightEvents = Math.min(20050, Math.floor(checked.events * 0.85));
  const phaseSpecs = [
    {name: 'count-retention', events: lightEvents, seed: checked.seed, heavyRatio: 0},
    {
      name: 'byte-retention',
      events: checked.events - lightEvents,
      seed: (checked.seed ^ 0x9e3779b9) >>> 0,
      heavyRatio: 0.3,
    },
  ];
  const phases: {
    name: string;
    events: number;
    seed: number;
    heavyRatio: number;
    elapsedMs: number;
    stats: LoadGenerator['stats'];
  }[] = [];
  const sampleMemory = () => {
    const usage = memory();
    for (const key of Object.keys(usage) as (keyof typeof usage)[])
      peakMemory[key] = Math.max(peakMemory[key], usage[key]);
    return usage;
  };
  const sample = () => {
    const current = bounds(store);
    for (const key of Object.keys(observations) as (keyof typeof observations)[])
      observations[key] = Math.max(observations[key], current[key]);
    sampleMemory();
    const names = fs.readdirSync(directory).filter(name => /^events-\d{8}\.jsonl$/.test(name));
    greatestSegment = Math.max(greatestSegment, ...names.map(name => Number(name.slice(7, 15))));
    disk(directory);
  };
  try {
    for (const phase of phaseSpecs) {
      const generator = new LoadGenerator({
        events: phase.events,
        seed: phase.seed,
        runs: 800,
        marathons: 1,
        marathonShare: 0.6,
        heavyRatio: phase.heavyRatio,
        now: () => new Date(++tick),
      });
      const phaseStart = performance.now();
      for (let index = 0; index < phase.events; index++) {
        const event = generator.next();
        const bodyBytes = Buffer.byteLength(JSON.stringify(event));
        assert.ok(bodyBytes <= BODY_LIMIT, 'generated v1 event exceeded 64 KiB');
        inputBytes += bodyBytes;
        const count = store.events.length;
        const bytes = store.bytes;
        const t0 = performance.now();
        const accepted = store.ingest(event);
        ingestMs.push(performance.now() - t0);
        assert.equal(accepted.accepted, true, `generated event was rejected: ${event.event_id}`);
        const row = store.events.at(-1)!;
        const size = Buffer.byteLength(JSON.stringify(row));
        storedBytesWritten += size + 1;
        if (count + 1 > MAX_EVENTS) eventLimitEvictions++;
        if (bytes + size > MEMORY_LIMIT) byteLimitEvictions++;
        assert.ok(store.events.length <= MAX_EVENTS && store.bytes <= MEMORY_LIMIT && store.runs.size <= MAX_RUNS);
        seenRuns.add(event.run_id);
        seenTypes.add(event.type);
        if (event.type === 'decision.started') {
          const ids = decisionsByRun.get(event.run_id) ?? new Set<string>();
          ids.add(event.decision_id!);
          decisionsByRun.set(event.run_id, ids);
        }
        if (event.action_id && event.attempt_id) {
          const ids = attemptsByRun.get(event.run_id) ?? new Set<string>();
          ids.add(JSON.stringify([event.action_id, event.attempt_id]));
          attemptsByRun.set(event.run_id, ids);
        }
        lastEvent = event;
        if (ingestMs.length % 250 === 0) sample();
      }
      phases.push({...phase, elapsedMs: performance.now() - phaseStart, stats: {...generator.stats}});
    }
    sample();
    const capacity = {
      moreThan200Runs: seenRuns.size > MAX_RUNS,
      moreThan500Decisions: [...decisionsByRun.values()].some(ids => ids.size > 500),
      moreThan500Attempts: [...attemptsByRun.values()].some(ids => ids.size > 500),
      eventLimitExercised: eventLimitEvictions > 0,
      byteLimitExercised: byteLimitEvictions > 0,
      diskPruningExercised: greatestSegment > MAX_SEGMENTS,
    };
    if (checked.events >= DEFAULT_STRESS_EVENTS) {
      for (const [name, covered] of Object.entries(capacity))
        assert.ok(covered, `default capacity coverage missing: ${name}`);
      for (const type of eventTypes) assert.ok(seenTypes.has(type), `default mix omitted ${type}`);
    }
    const finalBounds = bounds(store);
    const finalDisk = disk(directory);
    const cursor = store.cursor;
    const beforeRejectDisk = fs
      .readdirSync(directory)
      .sort()
      .map(name => [name, fs.statSync(path.join(directory, name)).size]);
    withoutDiskWrites(() => {
      assert.deepEqual(store.ingest(lastEvent!), {accepted: false, cursor});
      assert.deepEqual(store.ingest(conflictOf(lastEvent!, 1)), {accepted: false, conflict: true, cursor});
    });
    assert.deepEqual(
      fs
        .readdirSync(directory)
        .sort()
        .map(name => [name, fs.statSync(path.join(directory, name)).size]),
      beforeRejectDisk,
    );
    const ingestSampledPeak = {...peakMemory};
    const exportStart = performance.now();
    const exported = store.exportLines();
    const exportMs = performance.now() - exportStart;
    sampleMemory();
    assert.equal(exported.skipped, 0);
    assert.equal(exported.unreadable, 0);
    const parseStart = performance.now();
    const replay = parseReplay(exported.text, {validateEvent, sanitizeEvent});
    const parseReplayMs = performance.now() - parseStart;
    sampleMemory();
    assert.equal(replay.invalidLines, 0);
    const allCursors = exported.text
      .trim()
      .split('\n')
      .map(line => (JSON.parse(line) as {cursor: number}).cursor);
    sampleMemory();
    assert.equal(new Set(allCursors).size, allCursors.length, 'export reused a cursor');
    assert.equal(allCursors.at(-1), cursor, 'export omitted latest accepted event');
    store.close();
    const reopenStart = performance.now();
    reopened = new EventStore(directory);
    const reopenMs = performance.now() - reopenStart;
    sampleMemory();
    assert.equal(reopened.cursor, cursor, 'reopen changed the safe high-water mark on complete rows');
    const recoveredBounds = bounds(reopened);
    withoutDiskWrites(() => {
      assert.deepEqual(reopened!.ingest(lastEvent!), {accepted: false, cursor});
      assert.deepEqual(reopened!.ingest(conflictOf(lastEvent!, 2)), {accepted: false, conflict: true, cursor});
    });
    const next: MonitorEvent = {
      schema_version: 1,
      event_id: `stress-continue-${checked.seed}`,
      run_id: lastEvent!.run_id,
      producer_id: `stress-reopened-${checked.seed}`,
      sequence: 1,
      occurred_at: new Date(++tick).toISOString(),
      type: 'heartbeat',
      payload: {},
    };
    assert.deepEqual(reopened.ingest(next), {accepted: true, cursor: cursor + 1});
    const afterContinuationDisk = disk(directory);
    bounds(reopened);
    const afterMemory = sampleMemory();
    const usedCpu = process.cpuUsage(startedCpu);
    const cpuMs = {
      user: usedCpu.user / 1000,
      system: usedCpu.system / 1000,
      total: (usedCpu.user + usedCpu.system) / 1000,
    };
    const report = {
      method: 'offline-short-burst-real-eventstore',
      limitations: [
        'No HTTP, socket, child process, Electron, renderer or UI latency measurement.',
        'Not a 30-minute soak or Windows/macOS native validation.',
        'Process RSS includes generator, bounded aggregate tables, export and replay parsing; the 32 MiB limit covers retained event JSON only.',
        'writeSync acknowledgement is not fsync / power-loss durability.',
        'Wall time includes process scheduling/preemption; CPU time is reported separately. No deliberate pacing or 30-minute duration is enforced.',
      ],
      startedAt,
      endedAt: new Date().toISOString(),
      machine: {
        os: os.type(),
        release: os.release(),
        version: os.version(),
        arch: os.arch(),
        cpu: os.cpus()[0]?.model,
        cores: os.cpus().length,
        ramBytes: os.totalmem(),
        node: process.version,
      },
      options: checked,
      output,
      elapsedMs: performance.now() - start,
      cpuMs,
      acceptedEvents: ingestMs.length,
      continuationAccepted: true,
      runsGenerated: seenRuns.size,
      byType: Object.fromEntries(
        eventTypes.map(type => [type, phases.reduce((sum, phase) => sum + (phase.stats.byType[type] ?? 0), 0)]),
      ),
      phases,
      inputBytes,
      storedBytesWritten,
      ingestMs: summarize(ingestMs),
      memory: {
        before: beforeMemory,
        ingestSampledPeak,
        sampledPeak: peakMemory,
        afterExportReplayReopen: afterMemory,
        sampleEveryEvents: 250,
        additionalSamples: [
          'after-export',
          'after-parseReplay',
          'after-export-cursor-scan',
          'after-reopen',
          'after-continuation',
        ],
      },
      limits: {
        events: MAX_EVENTS,
        eventBytes: MEMORY_LIMIT,
        runs: MAX_RUNS,
        evictedRuns: MAX_EVICTED,
        decisionsPerRun: 500,
        attemptsPerRun: 500,
        segments: MAX_SEGMENTS,
        segmentBytes: SEGMENT_LIMIT,
        metadataRecords: MAX_RUNS + MAX_EVICTED,
        metadataBytes: METADATA_LIMIT,
      },
      capacity,
      eventLimitEvictions,
      byteLimitEvictions,
      greatestSegment,
      peakBounds: observations,
      finalBounds,
      recoveredBounds,
      disk: {beforeReopen: finalDisk, afterContinuation: afterContinuationDisk},
      export: {
        ms: exportMs,
        bytes: Buffer.byteLength(exported.text),
        events: allCursors.length,
        skipped: exported.skipped,
        unreadable: exported.unreadable,
        uniqueCursors: true,
      },
      parseReplay: {
        ms: parseReplayMs,
        events: replay.events.length,
        invalidLines: replay.invalidLines,
        truncated: replay.truncated,
        omitted: replay.omitted,
      },
      reopen: {ms: reopenMs, cursor, continuedCursor: reopened.cursor},
      assertionsPassed: true,
    };
    fs.writeFileSync(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    const summary = `# Offline store stress\n\nMethod: real EventStore, seeded v1 mix, synchronous local short burst. No sockets, subprocesses, HTTP or UI measurement; not a 30-minute soak or native Windows/macOS acceptance.\n\n- Seed: ${checked.seed}; accepted events: ${report.acceptedEvents}; runs: ${seenRuns.size}; elapsed: ${report.elapsedMs.toFixed(1)} ms.\n- Ingest p50 / p95 / p99 / max: ${report.ingestMs.p50} / ${report.ingestMs.p95} / ${report.ingestMs.p99} / ${report.ingestMs.max} ms.\n- Sampled RSS / heap peak: ${(peakMemory.rss / 1048576).toFixed(1)} / ${(peakMemory.heapUsed / 1048576).toFixed(1)} MiB (whole process, not only the event window).\n- Retained events / bytes / runs / evicted: ${finalBounds.events} / ${finalBounds.bytes} / ${finalBounds.runs} / ${finalBounds.evicted}.\n- Retained segments: ${finalDisk.segments}; disk segment bytes: ${finalDisk.segmentBytes}; metadata records / bytes: ${finalDisk.metadataRecords} / ${finalDisk.metadataBytes}.\n- Export / parseReplay / reopen: ${exportMs.toFixed(1)} / ${parseReplayMs.toFixed(1)} / ${reopenMs.toFixed(1)} ms.\n- Capacity coverage: ${JSON.stringify(capacity)}.\n- Bounds, unique cursors, recent duplicate/conflict no-write, clean reopen and new-event continuation assertions: passed.\n\nSee report.json for phases, machine information, raw byte counts, sampled limits and limitations. writeSync is not fsync; this test does not establish power-loss durability.\n`;
    fs.writeFileSync(path.join(output, 'summary.md'), summary);
    return report;
  } finally {
    store.close();
    reopened?.close();
  }
}

const isMain = () => {
  try {
    return Boolean(process.argv[1] && pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url);
  } catch {
    return false;
  }
};

if (isMain()) {
  try {
    const report = runStoreStress(parseStoreStressArgs(process.argv.slice(2)));
    console.log(
      JSON.stringify(
        {
          output: report.output,
          acceptedEvents: report.acceptedEvents,
          elapsedMs: report.elapsedMs,
          cpuMs: report.cpuMs,
          ingestMs: report.ingestMs,
          capacity: report.capacity,
          assertionsPassed: report.assertionsPassed,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
}

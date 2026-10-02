import fs from 'node:fs';
import {randomBytes} from 'node:crypto';
import {redact} from './redact';
import {MAX_EVICTED, MAX_RUNS, type RunState} from './state';

/**
 * Names, simulated flags, start times and known terminal outcomes, kept next to the segments. Only 8 segments
 * are kept; once the one holding a run's run.started is deleted, a restart would rebuild the run from its later
 * events, named by its id and not marked simulated. The store saves this file just before it deletes segments.
 */
export const RUN_NAMES_FILE = 'runs.json';
export type RunName = Pick<RunState, 'name' | 'simulated' | 'started_at'> &
  Partial<Pick<RunState, 'status' | 'ended_at'>>;
export interface RunNamesRead {
  names: Map<string, RunName>;
  unreadable: boolean;
}

// Every run the store remembers: the listed ones and the evicted ones. The byte cap only bites with very long names.
const MAX_RECORDS = MAX_RUNS + MAX_EVICTED;
const MAX_BYTES = 1024 * 1024;
// A name is at most 4096 code points, so at most twice that many UTF-16 units.
const MAX_NAME = 2 * 4096;
const retryable = new Set(['EPERM', 'EBUSY', 'EACCES']);
const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);

function waitMs(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readSmallFile(file: string): {text?: string; unreadable: boolean} {
  for (let attempt = 0; ; attempt++) {
    try {
      if (fs.statSync(file).size > MAX_BYTES) return {unreadable: false};
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        // The containing events directory is already private; a locked file can still be read on retry.
      }
      return {text: fs.readFileSync(file, 'utf8'), unreadable: false};
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // A scanner may hold the file for a moment at startup; retry n waits 20×n ms, as for the session file.
      if (code === 'ENOENT') return {unreadable: false};
      if (attempt >= 4 || !code || !retryable.has(code)) return {unreadable: true};
      waitMs(20 * (attempt + 1));
    }
  }
}

/** A missing, unreadable, oversized or malformed file gives no names, and startup goes on as before. */
export function readRunNamesResult(file: string): RunNamesRead {
  const names = new Map<string, RunName>();
  const {text, unreadable} = readSmallFile(file);
  const result = {names, unreadable};
  if (text === undefined) return result;
  let saved: unknown;
  try {
    saved = JSON.parse(text);
  } catch {
    return result;
  }
  if (!saved || typeof saved !== 'object' || !('version' in saved) || saved.version !== 1 || !('runs' in saved))
    return result;
  if (!Array.isArray(saved.runs)) return result;
  for (const row of saved.runs.slice(-MAX_RECORDS)) {
    if (!row || typeof row !== 'object') continue;
    const {id, name, simulated, started_at, status, ended_at} = row as Record<string, unknown>;
    if (typeof id !== 'string' || typeof name !== 'string' || name.length > MAX_NAME) continue;
    if (typeof simulated !== 'boolean') continue;
    if (started_at !== undefined && (typeof started_at !== 'string' || !Number.isFinite(Date.parse(started_at))))
      continue;
    const terminal =
      typeof status === 'string' &&
      terminalStatuses.has(status) &&
      typeof ended_at === 'string' &&
      Number.isFinite(Date.parse(ended_at));
    if (started_at === undefined && !terminal) continue;
    // Segments are redacted again on restart, so a saved name follows the current rules too.
    names.set(id, {
      name: redact(name, 1) as string,
      simulated,
      ...(typeof started_at === 'string' ? {started_at} : {}),
      ...(terminal ? {status: status as string, ended_at: ended_at as string} : {}),
    });
  }
  return result;
}

export function readRunNames(file: string): Map<string, RunName> {
  return readRunNamesResult(file).names;
}

/** Merge old hints with newly observed runs, deduplicating ids before enforcing record and byte bounds. */
export function boundedRunNames(runs: Iterable<[string, RunName]>): Map<string, RunName> {
  const merged = new Map<string, RunName>();
  for (const [id, {name, simulated, started_at, status, ended_at}] of runs) {
    const terminal = status !== undefined && terminalStatuses.has(status) && ended_at !== undefined;
    if (started_at === undefined && !terminal) continue;
    merged.delete(id);
    merged.set(id, {
      name: redact(name, 1) as string,
      simulated,
      ...(started_at !== undefined ? {started_at} : {}),
      ...(terminal ? {status, ended_at} : {}),
    });
  }
  const result = new Map<string, RunName>();
  let bytes = Buffer.byteLength('{"version":1,"runs":[\n\n]}\n');
  for (const [id, hint] of [...merged].reverse()) {
    const size = Buffer.byteLength(JSON.stringify({id, ...hint})) + 2;
    if (result.size >= MAX_RECORDS || bytes + size > MAX_BYTES) break;
    bytes += size;
    result.set(id, hint);
  }
  return new Map([...result].reverse());
}

/**
 * Saves the runs that have a start time, later ones last so the bounds cut the earliest first. Written to a
 * temporary file and renamed over the old one, so a crash leaves one version whole. Returns false when the file
 * could not be replaced (an antivirus scan, for instance); the caller tries again later.
 */
export function writeRunNames(file: string, runs: Iterable<[string, RunName]>): boolean {
  const rows = [...boundedRunNames(runs)].map(([id, hint]) => JSON.stringify({id, ...hint}));
  const head = '{"version":1,"runs":[\n';
  const tail = '\n]}\n';
  // Nothing has a name to lose. An older file only describes the same run ids, so it can stay.
  if (rows.length === 0) return true;
  const tmp = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, head + rows.join(',\n') + tail, {mode: 0o600, flag: 'wx'});
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Preserve the old complete file; a stray temp file never participates in recovery.
    }
    return false;
  }
}

/** Restores missing start metadata and newer terminal outcomes; returns whether the run visibly changed. */
export function nameRun(
  run: Pick<RunState, 'id' | 'name' | 'simulated' | 'started_at' | 'status' | 'ended_at'>,
  names: ReadonlyMap<string, RunName>,
): boolean {
  const saved = names.get(run.id);
  if (!saved) return false;
  const before = [run.name, run.simulated, run.started_at, run.status, run.ended_at];
  if (run.started_at === undefined) {
    run.name = saved.name;
    run.simulated = saved.simulated;
    if (saved.started_at !== undefined) run.started_at = saved.started_at;
  }
  if (saved.ended_at !== undefined && (!run.ended_at || Date.parse(saved.ended_at) > Date.parse(run.ended_at))) {
    run.ended_at = saved.ended_at;
    run.status = saved.status!;
  }
  return [run.name, run.simulated, run.started_at, run.status, run.ended_at].some(
    (value, index) => value !== before[index],
  );
}

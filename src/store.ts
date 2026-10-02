import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {validateEvent, type MonitorEvent, type StoredEvent} from './protocol';
import {sanitizeEvent} from './redact';
import {applyEvent, evictRuns, MAX_RUNS, restoreRun, type EvictedRun, type RunState} from './state';
import {boundedRunNames, nameRun, readRunNamesResult, RUN_NAMES_FILE, writeRunNames, type RunName} from './run-names';
import {randomBytes} from 'node:crypto';

// A segment that could not be deleted (Windows antivirus, indexers) is tried again no sooner than this.
const PRUNE_RETRY_MS = 1000;
const READ_RETRY_MS = [20, 40];
const LOCKED = new Set(['EBUSY', 'EPERM', 'EACCES']);
const CURSOR_RESERVATION_FILE = 'cursor-reservation.json';
const RUN_NAMES_ATTEMPTS = 5;

/** A missing segment is empty; a persistently unreadable one is skipped and reported. */
function readSegment(file: string): string | undefined {
  for (let attempt = 0; ; attempt++) {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return '';
      if (attempt >= READ_RETRY_MS.length || !code || !LOCKED.has(code)) return undefined;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, READ_RETRY_MS[attempt]);
    }
  }
}

/** Windows ignores POSIX modes and relies on the user's directory ACLs. */
function restrict(file: string, mode: number) {
  try {
    fs.chmodSync(file, mode);
  } catch {
    // A vanished or locked file does not stop recovery; newly created files still use the restrictive mode.
  }
}

function readCursorReservation(file: string): number | undefined {
  try {
    if (fs.statSync(file).size > 1024) return undefined;
    const text = readSegment(file);
    if (!text) return undefined;
    const row = JSON.parse(text);
    if (row?.version === 1 && Number.isSafeInteger(row.ceiling) && row.ceiling >= 0) return row.ceiling;
  } catch {
    // If segments also cannot be read, ingest must wait rather than guess their high-water mark.
  }
  return undefined;
}

function hasCursorReservation(file: string) {
  try {
    fs.statSync(file);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/** Previously acknowledged data became visible after a read lock cleared; no new event was accepted. */
export interface RecoveredChange {
  cursor: number;
  runIds: string[];
}

export class EventStore extends EventEmitter {
  events: StoredEvent[] = [];
  runs = new Map<string, RunState>();
  ids = new Set<string>();
  sequences = new Set<string>();
  cursor = 0;
  bytes = 0;
  corruptLines = 0;
  unreadableSegments: string[] = [];
  storageError: string | undefined;
  private segment = 0;
  private segmentBytes = 0;
  private fd: number | undefined;
  private prunePending = false;
  private pruneRetryAt: number | undefined;
  private droppedRuns = new Set<string>();
  private evictedRuns = new Map<string, EvictedRun>();
  private runNames = new Map<string, RunName>();
  private runNamesSegment: number | undefined;
  private runNamesFailures = 0;
  private runNamesUnreadable = false;
  private runNamesRetryAt = 0;
  private runNamesError: string | undefined;
  private cursorUncertain = false;
  private tornCursorUncertain = false;
  private cursorReserved = false;
  private cursorCeiling = 0;
  private recoveryRetryAt = 0;
  constructor(
    public directory: string,
    public maxEvents = 20000,
    public segmentLimit = 4 * 1024 * 1024,
    public maxSegments = 8,
    public diagnostics = false,
  ) {
    super();
    fs.mkdirSync(directory, {recursive: true, mode: 0o700});
    restrict(directory, 0o700);
    restrict(path.join(directory, CURSOR_RESERVATION_FILE), 0o600);
    const names = readRunNamesResult(path.join(directory, RUN_NAMES_FILE));
    this.runNames = names.names;
    this.runNamesUnreadable = names.unreadable;
    if (names.unreadable) {
      this.runNamesError = '运行名称文件暂时读不了，等待重试后恢复名称和模拟标记';
      this.runNamesRetryAt = Date.now() + PRUNE_RETRY_MS;
    }
    const files = this.files();
    for (const name of files) restrict(path.join(directory, name), 0o600);
    let unreadableTail = false;
    let tornTail = false;
    // Only recover bounded retained segments; malformed/torn final lines are counted.
    for (const f of files.slice(-maxSegments)) {
      this.segment = Math.max(this.segment, Number(f.slice(7, 15)));
      const file = path.join(directory, f);
      const text = readSegment(file);
      if (text === undefined) {
        this.unreadableSegments.push(f);
        unreadableTail = true;
        continue;
      }
      const before = this.cursor;
      for (const line of text.split('\n')) {
        if (!line) continue;
        let row: unknown;
        try {
          row = JSON.parse(line);
        } catch {
          // A torn tail that is not JSON has no cursor to preserve.
          this.corruptLines++;
          tornTail = true;
          continue;
        }
        // A line can fail validation and still have consumed a cursor. Counting it stops the next ingest from reusing that id.
        const parsedCursor = row !== null && typeof row === 'object' ? (row as {cursor?: unknown}).cursor : undefined;
        if (typeof parsedCursor === 'number' && Number.isSafeInteger(parsedCursor)) {
          if (parsedCursor > this.cursor) tornTail = false;
          this.cursor = Math.max(this.cursor, parsedCursor);
        }
        try {
          const {received_at, cursor, ...event} = row as Record<string, unknown>;
          validateEvent(event);
          if (typeof received_at !== 'string' || !Number.isSafeInteger(cursor)) throw new Error('Invalid envelope');
          this.remember(sanitizeEvent(row as StoredEvent, diagnostics));
        } catch {
          this.corruptLines++;
        }
      }
      // Every store-written later segment has greater cursors, so its high-water mark covers an older locked one.
      if (this.cursor > before) unreadableTail = false;
    }
    if (unreadableTail || tornTail) {
      const reservation = path.join(directory, CURSOR_RESERVATION_FILE);
      const ceiling = readCursorReservation(reservation);
      if (ceiling !== undefined) this.cursor = Math.max(this.cursor, ceiling);
      // Legacy logs have no reservation for a torn line. Preserve their documented, parseable-only recovery.
      else if (unreadableTail) this.cursorUncertain = true;
      else if (tornTail && hasCursorReservation(reservation)) {
        this.cursorUncertain = true;
        this.tornCursorUncertain = true;
      }
    }
    if (this.unreadableSegments.length > 0 || this.cursorUncertain || this.runNamesUnreadable) {
      this.recoveryRetryAt = Date.now() + PRUNE_RETRY_MS;
      this.reportRecoveryError();
    }
    // A fresh segment after every restart isolates torn writes from valid records.
    this.rotate();
    this.pruneFiles();
  }
  private files() {
    return fs
      .readdirSync(this.directory)
      .filter(f => /^events-\d{8}\.jsonl$/.test(f))
      .sort();
  }
  private file() {
    return path.join(this.directory, `events-${String(this.segment).padStart(8, '0')}.jsonl`);
  }
  private rotate() {
    this.closeSegment();
    this.segment++;
    this.segmentBytes = 0;
    this.cursorReserved = false;
    // The new file appears with its first line; pruning after that write leaves exactly maxSegments files.
    this.prunePending = true;
  }
  private closeSegment() {
    const fd = this.fd;
    if (fd === undefined) return;
    this.fd = undefined;
    try {
      fs.closeSync(fd);
    } catch {
      // Every acknowledged line was already handed to the OS; a failed close loses nothing.
    }
  }
  /** Releases the open segment. A later ingest reopens it, so closing twice or writing after close is safe. */
  close() {
    this.closeSegment();
  }
  private append(data: Buffer, cursor: number) {
    // POSIX keeps an unlinked open file writable. Detect it before acknowledging more invisible records.
    if (this.fd !== undefined && fs.fstatSync(this.fd).nlink === 0) this.rotate();
    if (this.segmentBytes + data.length > this.segmentLimit) this.rotate();
    if (!this.cursorReserved) this.reserveCursors(cursor);
    // One descriptor per segment: opening and closing the file for every event cost about half of ingest.
    const fd = (this.fd ??= fs.openSync(this.file(), 'a', 0o600));
    let written = 0;
    try {
      while (written < data.length) {
        const n = fs.writeSync(fd, data, written, data.length - written);
        if (n <= 0) throw Object.assign(new Error('Segment write made no progress'), {code: 'EIO'});
        written += n;
      }
    } catch (error) {
      // Reopen on the next ingest, so a transient error (antivirus, a full disk being cleared) does not wedge the store.
      this.closeSegment();
      // Part of a line on disk would glue onto the next record; start a fresh segment, as after a restart.
      if (written > 0) {
        this.rotate();
        // All but the newline may have landed, and recovery would load that line with this cursor. Burn it so the
        // next event does not reuse the number (the timeline keys rows by cursor).
        this.cursor = cursor;
      }
      throw error;
    }
    this.segmentBytes += data.length;
    if (this.prunePending || (this.pruneRetryAt !== undefined && Date.now() >= this.pruneRetryAt)) {
      this.prunePending = false;
      this.pruneFiles();
    }
  }
  private pruneFiles() {
    this.pruneRetryAt = undefined;
    let files: string[];
    try {
      files = this.files();
    } catch {
      // The event is already written; listing old segments can wait for the next retry.
      this.pruneRetryAt = Date.now() + PRUNE_RETRY_MS;
      return;
    }
    const old = files.slice(0, Math.max(0, files.length - this.maxSegments));
    if (old.length > 0 && !this.saveRunNames()) {
      this.pruneRetryAt = Date.now() + PRUNE_RETRY_MS;
      return;
    }
    for (const f of old) {
      // Windows antivirus/indexers can briefly lock old segments; the event is already on disk, so retry a little later.
      try {
        fs.unlinkSync(path.join(this.directory, f));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.pruneRetryAt = Date.now() + PRUNE_RETRY_MS;
      }
    }
  }
  private saveRunNames(): boolean {
    if (this.runNamesSegment === this.segment) return true;
    // Never replace a complete file with a partial map built while its read was locked at startup.
    const restored = this.recoverRunNames(true);
    const merged = boundedRunNames([...this.runNames, ...this.evictedRuns, ...this.runs]);
    const saved = restored && writeRunNames(path.join(this.directory, RUN_NAMES_FILE), merged);
    if (!saved && ++this.runNamesFailures < RUN_NAMES_ATTEMPTS) return false;
    if (saved) {
      this.runNames = merged;
      this.runNamesError = undefined;
    } else {
      this.runNamesError = this.runNamesUnreadable
        ? '运行名称文件持续读取失败，保留原名称文件，旧事件段仍会按保留上限清理'
        : '运行名称文件持续写入失败，旧事件段仍会按保留上限清理，重启后可能丢失名称';
    }
    this.reportRecoveryError();
    this.runNamesSegment = this.segment;
    this.runNamesFailures = 0;
    return true;
  }
  private reportRecoveryError() {
    const skipped = this.unreadableSegments;
    const cursorError = skipped.length
      ? `有 ${skipped.length} 个事件段读不了，已跳过并等待重试：${skipped.join('、')}${this.cursorUncertain ? '；无法确定 cursor，暂缓写入直到可读' : ''}`
      : this.tornCursorUncertain
        ? '事件尾行损坏且 cursor 预留文件读不了或已损坏，暂缓写入直到预留文件可读'
        : undefined;
    this.storageError = [cursorError, this.runNamesError].filter(Boolean).join('；') || undefined;
  }
  /** Rehydrate before saving or, at most once a second, while new events arrive. */
  private recoverRunNames(force = false): boolean {
    if (!this.runNamesUnreadable) return true;
    if (!force && Date.now() < this.runNamesRetryAt) return false;
    this.runNamesRetryAt = Date.now() + PRUNE_RETRY_MS;
    const loaded = readRunNamesResult(path.join(this.directory, RUN_NAMES_FILE));
    if (loaded.unreadable) return false;
    this.runNames = boundedRunNames([...this.runNames, ...loaded.names]);
    this.runNamesUnreadable = false;
    const runIds: string[] = [];
    for (const run of this.runs.values()) {
      if (nameRun(run, this.runNames)) runIds.push(run.id);
    }
    for (const [id, past] of this.evictedRuns) {
      const run = {id, ...past};
      if (!nameRun(run, this.runNames)) continue;
      const {id: _id, ...hint} = run;
      this.evictedRuns.set(id, hint);
      runIds.push(id);
    }
    this.runNamesError = undefined;
    this.reportRecoveryError();
    if (runIds.length > 0) this.emit('recovered', {cursor: this.cursor, runIds} satisfies RecoveredChange);
    return true;
  }
  /** Re-read missing high-water data after a lock clears, without inventing an acknowledged cursor. */
  private recoverCursor() {
    if (!this.cursorUncertain && (this.unreadableSegments.length === 0 || Date.now() < this.recoveryRetryAt)) return;
    const previousCursor = this.cursor;
    this.recoveryRetryAt = Date.now() + PRUNE_RETRY_MS;
    const ceiling = readCursorReservation(path.join(this.directory, CURSOR_RESERVATION_FILE));
    if (this.cursorUncertain && ceiling !== undefined) this.cursor = Math.max(this.cursor, ceiling);
    const unreadable: string[] = [];
    const recovered: StoredEvent[] = [];
    for (const name of this.unreadableSegments) {
      const text = readSegment(path.join(this.directory, name));
      if (text === undefined) {
        unreadable.push(name);
        continue;
      }
      for (const line of text.split('\n')) {
        if (!line) continue;
        try {
          const row = JSON.parse(line);
          if (Number.isSafeInteger(row?.cursor)) this.cursor = Math.max(this.cursor, row.cursor);
          const {received_at, cursor, ...event} = row as Record<string, unknown>;
          validateEvent(event);
          if (typeof received_at !== 'string' || !Number.isSafeInteger(cursor)) throw new Error('Invalid envelope');
          recovered.push(sanitizeEvent(row as StoredEvent, this.diagnostics));
        } catch {
          this.corruptLines++;
        }
      }
    }
    this.unreadableSegments = unreadable;
    if (ceiling !== undefined) this.tornCursorUncertain = false;
    if (ceiling !== undefined || (unreadable.length === 0 && !this.tornCursorUncertain)) this.cursorUncertain = false;
    recovered.sort((a, b) => a.cursor - b.cursor);
    const runIds = new Set<string>();
    for (const row of recovered) {
      if (this.remember(row)) runIds.add(row.run_id);
    }
    this.reportRecoveryError();
    if (runIds.size > 0 || this.cursor !== previousCursor)
      this.emit('recovered', {cursor: this.cursor, runIds: [...runIds]} satisfies RecoveredChange);
    if (this.cursorUncertain)
      throw Object.assign(new Error('Unreadable segments have no safe cursor reservation'), {code: 'EBUSY'});
  }
  /** Reserve at least one cursor per byte before any segment write; one oversized or partly written row fits too. */
  private reserveCursors(cursor: number) {
    const budget = Math.max(1, Math.ceil(this.segmentLimit)) + 1;
    const ceiling = Math.max(this.cursorCeiling, cursor + budget);
    if (!Number.isSafeInteger(ceiling)) throw new Error('Cursor reservation exceeds the safe integer range');
    const file = path.join(this.directory, CURSOR_RESERVATION_FILE);
    const tmp = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({version: 1, ceiling}) + '\n', {mode: 0o600, flag: 'wx'});
      fs.renameSync(tmp, file);
      restrict(file, 0o600);
    } catch (error) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // Preserve the original storage error; an orphaned temp file contains no credentials or events.
      }
      throw error;
    }
    this.cursorCeiling = ceiling;
    this.cursorReserved = true;
  }
  private seq(e: MonitorEvent) {
    return JSON.stringify([e.run_id, e.producer_id, e.sequence]);
  }
  private markDropped(runId: string) {
    // Re-adding moves the run to the newest end, so trimming starts with runs whose events aged out longest ago.
    this.droppedRuns.delete(runId);
    this.droppedRuns.add(runId);
    if (this.droppedRuns.size <= MAX_RUNS) return;
    for (const id of this.droppedRuns) {
      if (this.droppedRuns.size <= MAX_RUNS) break;
      // A run the UI still lists keeps its mark, so its timeline can still say older events were dropped.
      if (!this.runs.has(id)) this.droppedRuns.delete(id);
    }
  }
  private remember(e: StoredEvent): boolean {
    if (this.ids.has(e.event_id) || this.sequences.has(this.seq(e))) return false;
    this.ids.add(e.event_id);
    this.sequences.add(this.seq(e));
    if (this.events.length === 0 || this.events[this.events.length - 1].cursor < e.cursor) this.events.push(e);
    else {
      // Lock recovery adds older records after newer ones were already accepted. Keep retention ordered by cursor.
      let low = 0;
      let high = this.events.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (this.events[middle].cursor <= e.cursor) low = middle + 1;
        else high = middle;
      }
      this.events.splice(low, 0, e);
    }
    this.bytes += Buffer.byteLength(JSON.stringify(e));
    let r = this.runs.get(e.run_id);
    if (!r) {
      r = restoreRun(e.run_id, this.evictedRuns);
      nameRun(r, this.runNames);
      this.runs.set(e.run_id, r);
    }
    const received = r.last_received;
    applyEvent(r, e);
    if (received !== undefined && received > (r.last_received ?? '')) r.last_received = received;
    evictRuns(this.runs, this.evictedRuns);
    while (this.events.length > this.maxEvents || this.bytes > 32 * 1024 * 1024) {
      const old = this.events.shift()!;
      this.ids.delete(old.event_id);
      this.sequences.delete(this.seq(old));
      this.bytes -= Buffer.byteLength(JSON.stringify(old));
      this.markDropped(old.run_id);
    }
    return true;
  }
  ingest(raw: unknown) {
    validateEvent(raw);
    // Recovery can add already acknowledged ids/sequences, so it must finish before checking a retry.
    this.recoverCursor();
    this.recoverRunNames();
    if (this.ids.has(raw.event_id)) return {accepted: false, cursor: this.cursor};
    // A new event_id on a used producer sequence usually means a restarted sender reused its producer_id.
    if (this.sequences.has(this.seq(raw))) return {accepted: false, conflict: true, cursor: this.cursor};
    const e: StoredEvent = {
      ...sanitizeEvent(raw, this.diagnostics),
      received_at: new Date().toISOString(),
      cursor: this.cursor + 1,
    };
    // Commit on disk before acknowledgement; a failed write never becomes a successful send.
    this.append(Buffer.from(JSON.stringify(e) + '\n'), e.cursor);
    this.cursor = e.cursor;
    this.remember(e);
    this.emit('event', e);
    return {accepted: true, cursor: e.cursor};
  }
  snapshot(runId?: string) {
    return {
      cursor: this.cursor,
      runs: [...this.runs.values()].map(({decisions, attempts, ...r}) => r),
      run: runId ? this.runs.get(runId) : undefined,
      events: this.events.filter(e => !runId || e.run_id === runId).slice(-400),
      corruptLines: this.corruptLines,
    };
  }
  page(query: {runId?: string; beforeCursor?: number; limit?: number} = {}) {
    const raw = query.limit;
    const requested = typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(raw) : 100;
    const limit = Math.min(500, Math.max(1, requested));
    const before = typeof query.beforeCursor === 'number' ? query.beforeCursor : undefined;
    const rows = this.events.filter(event => {
      if (query.runId !== undefined && event.run_id !== query.runId) return false;
      if (before !== undefined && event.cursor >= before) return false;
      return true;
    });
    rows.sort((a, b) => a.cursor - b.cursor);
    return rows.slice(-limit);
  }
  /** An empty older page is missing events that were dropped from the memory window. */
  historyTruncated(query: {runId?: string; beforeCursor?: number} = {}): boolean {
    if (query.beforeCursor === undefined) return false;
    if (query.runId !== undefined) return this.droppedRuns.has(query.runId);
    return this.droppedRuns.size > 0;
  }
  exportLines(): {text: string; skipped: number; unreadable: number} {
    const records: string[] = [];
    let skipped = 0;
    let unreadable = 0;
    // Each segment is parsed alone. A torn tail has no newline, so joining the raw files would glue it to the next record.
    for (const name of this.files()) {
      const raw = readSegment(path.join(this.directory, name));
      if (raw === undefined) {
        unreadable++;
        continue;
      }
      const source = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
      for (const part of source.split('\n')) {
        const line = part.endsWith('\r') ? part.slice(0, -1) : part;
        if (!line) continue;
        const record = exportRecord(line);
        if (!record) {
          skipped++;
          continue;
        }
        records.push(JSON.stringify(record));
      }
    }
    return {text: records.length === 0 ? '' : `${records.join('\n')}\n`, skipped, unreadable};
  }
}

function exportRecord(line: string): StoredEvent | undefined {
  try {
    const row = JSON.parse(line);
    if (!row || typeof row !== 'object' || Array.isArray(row)) return undefined;
    const {received_at, cursor, ...event} = row;
    validateEvent(event);
    if (typeof received_at !== 'string' || !Number.isSafeInteger(cursor)) return undefined;
    return {...sanitizeEvent(event, false), received_at, cursor};
  } catch {
    return undefined;
  }
}

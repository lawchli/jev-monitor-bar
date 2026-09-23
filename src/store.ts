import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {validateEvent, type MonitorEvent, type StoredEvent} from './protocol';
import {sanitizeEvent} from './redact';
import {applyEvent, emptyRun, selectRunToEvict, type RunState} from './state';

export class EventStore extends EventEmitter {
  events: StoredEvent[] = [];
  runs = new Map<string, RunState>();
  ids = new Set<string>();
  sequences = new Set<string>();
  cursor = 0;
  bytes = 0;
  corruptLines = 0;
  private segment = 0;
  private segmentBytes = 0;
  constructor(
    public directory: string,
    public maxEvents = 20000,
    public segmentLimit = 4 * 1024 * 1024,
    public maxSegments = 8,
    public diagnostics = false,
  ) {
    super();
    fs.mkdirSync(directory, {recursive: true});
    const files = this.files();
    // Only recover bounded retained segments; malformed/torn final lines are counted.
    for (const f of files.slice(-maxSegments)) {
      this.segment = Math.max(this.segment, Number(f.slice(7, 15)));
      for (const line of fs.readFileSync(path.join(directory, f), 'utf8').split('\n')) {
        if (!line) continue;
        let row: unknown;
        try {
          row = JSON.parse(line);
        } catch {
          // A torn tail that is not JSON has no cursor to preserve.
          this.corruptLines++;
          continue;
        }
        // A line can fail validation and still have consumed a cursor. Counting it stops the next ingest from reusing that id.
        const parsedCursor = row !== null && typeof row === 'object' ? (row as {cursor?: unknown}).cursor : undefined;
        if (typeof parsedCursor === 'number' && Number.isSafeInteger(parsedCursor)) {
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
    }
    // A fresh segment after every restart isolates torn writes from valid records.
    this.segment++;
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
  private pruneFiles() {
    const files = this.files();
    for (const f of files.slice(0, Math.max(0, files.length - this.maxSegments))) {
      // Windows antivirus/indexers can briefly lock old segments; the event is already on disk, so retry on a later prune.
      try {
        fs.unlinkSync(path.join(this.directory, f));
      } catch {}
    }
  }
  private seq(e: MonitorEvent) {
    return JSON.stringify([e.run_id, e.producer_id, e.sequence]);
  }
  private evictRun() {
    const victim = selectRunToEvict(this.runs.values());
    if (victim) this.runs.delete(victim.id);
  }
  private remember(e: StoredEvent) {
    if (this.ids.has(e.event_id) || this.sequences.has(this.seq(e))) return;
    this.ids.add(e.event_id);
    this.sequences.add(this.seq(e));
    this.events.push(e);
    this.bytes += Buffer.byteLength(JSON.stringify(e));
    let r = this.runs.get(e.run_id);
    if (!r) {
      r = emptyRun(e.run_id);
      this.runs.set(e.run_id, r);
    }
    applyEvent(r, e);
    while (this.runs.size > 200) this.evictRun();
    while (this.events.length > this.maxEvents || this.bytes > 32 * 1024 * 1024) {
      const old = this.events.shift()!;
      this.ids.delete(old.event_id);
      this.sequences.delete(this.seq(old));
      this.bytes -= Buffer.byteLength(JSON.stringify(old));
    }
  }
  ingest(raw: unknown) {
    validateEvent(raw);
    if (this.ids.has(raw.event_id)) return {accepted: false, cursor: this.cursor};
    // A new event_id on a used producer sequence usually means a restarted sender reused its producer_id.
    if (this.sequences.has(this.seq(raw))) return {accepted: false, conflict: true, cursor: this.cursor};
    const e: StoredEvent = {
      ...sanitizeEvent(raw, this.diagnostics),
      received_at: new Date().toISOString(),
      cursor: this.cursor + 1,
    };
    const line = JSON.stringify(e) + '\n';
    const size = Buffer.byteLength(line);
    if (this.segmentBytes + size > this.segmentLimit) {
      this.segment++;
      this.segmentBytes = 0;
    }
    // Commit on disk before acknowledgement; append failure never becomes a successful send.
    fs.appendFileSync(this.file(), line);
    this.segmentBytes += size;
    this.pruneFiles();
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
  exportLines(): {text: string; skipped: number} {
    const records: string[] = [];
    let skipped = 0;
    // Each segment is parsed alone. A torn tail has no newline, so joining the raw files would glue it to the next record.
    for (const name of this.files()) {
      const raw = fs.readFileSync(path.join(this.directory, name), 'utf8');
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
    return {text: records.length === 0 ? '' : `${records.join('\n')}\n`, skipped};
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

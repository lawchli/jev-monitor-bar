import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventStore} from '../src/store';
import type {MonitorEvent, StoredEvent} from '../src/protocol';

function directory(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-segments-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
}

function event(sequence: number): MonitorEvent {
  return {
    schema_version: 1,
    event_id: `segment-${sequence}`,
    run_id: 'run-1',
    producer_id: 'host-1',
    sequence,
    occurred_at: '2026-01-01T00:00:00.000Z',
    type: 'heartbeat',
    payload: {},
  };
}

function writeSegment(dir: string, index: number | string, sequence: number): void {
  const row: StoredEvent = {...event(sequence), received_at: '2026-01-01T00:00:01.000Z', cursor: sequence};
  fs.writeFileSync(path.join(dir, `events-${String(index).padStart(8, '0')}.jsonl`), `${JSON.stringify(row)}\n`);
}

function exportedIds(store: EventStore): string[] {
  const exported = store.exportLines();
  assert.equal(exported.skipped, 0);
  return exported.text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => (JSON.parse(line) as StoredEvent).event_id);
}

test('segments beyond eight digits stay visible to export and restart', t => {
  const dir = directory(t);
  writeSegment(dir, 99_999_999, 1);
  const store = new EventStore(dir);
  t.after(() => store.close());
  assert.deepEqual(store.ingest(event(2)), {accepted: true, cursor: 2});
  assert.equal(fs.existsSync(path.join(dir, 'events-100000000.jsonl')), true);
  assert.deepEqual(exportedIds(store), ['segment-1', 'segment-2']);
  store.close();

  const recovered = new EventStore(dir);
  t.after(() => recovered.close());
  assert.equal(recovered.cursor, 2);
  assert.equal(recovered.corruptLines, 0);
  assert.deepEqual(
    recovered.events.map(row => row.event_id),
    ['segment-1', 'segment-2'],
  );
  assert.deepEqual(recovered.ingest(event(3)), {accepted: true, cursor: 3});
  assert.equal(fs.existsSync(path.join(dir, 'events-100000001.jsonl')), true);
  assert.deepEqual(exportedIds(recovered), ['segment-1', 'segment-2', 'segment-3']);
});

test('retention and recovery order segment names numerically across digit widths', t => {
  const dir = directory(t);
  [99_999_998, 99_999_999, 100_000_000, 100_000_001].forEach((index, offset) => writeSegment(dir, index, offset + 1));
  const store = new EventStore(dir, undefined, undefined, 2);
  t.after(() => store.close());
  assert.equal(store.cursor, 4);
  assert.deepEqual(
    store.events.map(row => row.event_id),
    ['segment-3', 'segment-4'],
  );
  assert.deepEqual(fs.readdirSync(dir).sort(), ['events-100000000.jsonl', 'events-100000001.jsonl']);
  assert.deepEqual(store.ingest(event(5)), {accepted: true, cursor: 5});
  assert.deepEqual(fs.readdirSync(dir).sort(), ['events-100000001.jsonl', 'events-100000002.jsonl']);
  assert.deepEqual(exportedIds(store), ['segment-4', 'segment-5']);
});

test('alternate padding at the same numeric index preserves every segment', t => {
  const dir = directory(t);
  writeSegment(dir, '000000001', 1);
  writeSegment(dir, '00000001', 2);
  writeSegment(dir, 2, 3);
  const store = new EventStore(dir);
  t.after(() => store.close());
  assert.equal(store.cursor, 3);
  assert.deepEqual(
    store.events.map(row => row.event_id),
    ['segment-1', 'segment-2', 'segment-3'],
  );
  assert.deepEqual(exportedIds(store), ['segment-1', 'segment-2', 'segment-3']);
  assert.deepEqual(store.ingest(event(4)), {accepted: true, cursor: 4});
  assert.equal(fs.existsSync(path.join(dir, 'events-00000003.jsonl')), true);
  assert.deepEqual(exportedIds(store), ['segment-1', 'segment-2', 'segment-3', 'segment-4']);
});

test('unsafe numeric segment names stop recovery without changing files', t => {
  for (const index of ['9007199254740992', '9007199254740993', '999999999999999999999999999999']) {
    const dir = directory(t);
    writeSegment(dir, 1, 1);
    writeSegment(dir, index, 2);
    const before = fs.readdirSync(dir).sort();
    assert.throws(() => new EventStore(dir), {code: 'EOVERFLOW'});
    assert.deepEqual(fs.readdirSync(dir).sort(), before);
    for (const name of before) assert.equal(fs.readFileSync(path.join(dir, name), 'utf8').endsWith('\n'), true);
  }
});

test('malformed names stay outside segment recovery and pruning', t => {
  const dir = directory(t);
  const ignored = [
    'events-1234567.jsonl',
    'events-+00000001.jsonl',
    'events-0000000x.jsonl',
    'events-00000001.jsonl.tmp',
    'events-00000001-extra.jsonl',
  ];
  for (const name of ignored) fs.writeFileSync(path.join(dir, name), 'unrelated');
  const store = new EventStore(dir, undefined, undefined, 1);
  t.after(() => store.close());
  assert.equal(store.cursor, 0);
  assert.equal(store.corruptLines, 0);
  assert.deepEqual(store.ingest(event(1)), {accepted: true, cursor: 1});
  assert.deepEqual(exportedIds(store), ['segment-1']);
  for (const name of ignored) assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), 'unrelated');
});

test('startup at the final safe segment fails before creating or pruning files', t => {
  const dir = directory(t);
  writeSegment(dir, 1, 1);
  writeSegment(dir, Number.MAX_SAFE_INTEGER, 2);
  const before = fs
    .readdirSync(dir)
    .sort()
    .map(name => [name, fs.readFileSync(path.join(dir, name), 'utf8')]);
  assert.throws(() => new EventStore(dir, undefined, undefined, 1), {code: 'EOVERFLOW'});
  assert.deepEqual(
    fs
      .readdirSync(dir)
      .sort()
      .map(name => [name, fs.readFileSync(path.join(dir, name), 'utf8')]),
    before,
  );
});

test('rotation past the final safe segment rejects before any disk or memory change', t => {
  const dir = directory(t);
  writeSegment(dir, Number.MAX_SAFE_INTEGER - 1, 1);
  const store = new EventStore(dir, undefined, 600);
  t.after(() => store.close());
  assert.deepEqual(store.ingest(event(2)), {accepted: true, cursor: 2});
  assert.equal(fs.existsSync(path.join(dir, `events-${Number.MAX_SAFE_INTEGER}.jsonl`)), true);
  const before = exportedIds(store);
  // The first row fits; a larger valid second row requires another segment.
  assert.throws(() => store.ingest({...event(3), payload: {summary: 'x'.repeat(500)}}), {code: 'EOVERFLOW'});
  assert.equal(store.cursor, 2);
  assert.deepEqual(
    store.events.map(row => row.event_id),
    before,
  );
  assert.deepEqual(exportedIds(store), before);
  assert.deepEqual(store.ingest(event(2)), {accepted: false, cursor: 2});
  assert.equal(fs.existsSync(path.join(dir, 'events-9007199254740992.jsonl')), false);
});

test('a partial write at the final segment burns its cursor and cannot reopen its torn line', t => {
  const dir = directory(t);
  writeSegment(dir, Number.MAX_SAFE_INTEGER - 1, 1);
  const store = new EventStore(dir);
  t.after(() => store.close());
  assert.deepEqual(store.ingest(event(2)), {accepted: true, cursor: 2});
  const realWrite = fs.writeSync;
  const write = t.mock.method(fs, 'writeSync');
  const allButNewline = (fd: number, buffer: NodeJS.ArrayBufferView, offset?: number | null, length?: number | null) =>
    realWrite(fd, buffer, offset, (length ?? 1) - 1);
  write.mock.mockImplementationOnce(allButNewline as typeof fs.writeSync, 0);
  write.mock.mockImplementationOnce(() => {
    throw Object.assign(new Error('write failed'), {code: 'EIO'});
  }, 1);
  assert.throws(() => store.ingest(event(3)), {code: 'EIO'});
  assert.equal(store.cursor, 3);
  write.mock.restore();
  const file = path.join(dir, `events-${Number.MAX_SAFE_INTEGER}.jsonl`);
  const before = fs.readFileSync(file, 'utf8');
  assert.equal(before.endsWith('\n'), false);
  assert.throws(() => store.ingest(event(4)), {code: 'EOVERFLOW'});
  assert.equal(store.cursor, 3);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(
    store.events.map(row => row.event_id),
    ['segment-1', 'segment-2'],
  );
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventStore} from '../src/store';
import {readRunNames, RUN_NAMES_FILE, writeRunNames} from '../src/run-names';
import {MAX_EVICTED, MAX_RUNS, type RunState} from '../src/state';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jev-names-'));
let sequence = 0;
function event(runId: string, type: string, payload: Record<string, unknown> = {}) {
  sequence++;
  return {
    schema_version: 1,
    event_id: `name-${sequence}`,
    run_id: runId,
    producer_id: 'names-host',
    sequence,
    occurred_at: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, sequence)).toISOString(),
    type,
    payload,
  };
}
const segments = (dir: string) => fs.readdirSync(dir).filter(name => /^events-\d{8}\.jsonl$/.test(name));

test('rotation and repeated restarts keep run names, simulated flags and original start times', () => {
  const dir = tempDir();
  const first = new EventStore(dir, undefined, 600, 2);
  const start = event('old', 'run.started', {name: '模拟：长期运行', simulated: true});
  first.ingest(start);
  for (let i = 0; i < 15; i++) first.ingest(event('old', 'heartbeat'));
  first.close();
  assert.equal(segments(dir).length, 2);
  assert.ok(!first.exportLines().text.includes('run.started'), 'the original start segment has actually been pruned');
  for (let i = 0; i < 3; i++) {
    const restored = new EventStore(dir, undefined, 600, 2);
    const run = restored.runs.get('old');
    assert.ok(run);
    assert.equal(run.name, '模拟：长期运行');
    assert.equal(run.simulated, true);
    assert.equal(run.started_at, start.occurred_at);
    restored.ingest(event('old', 'heartbeat'));
    restored.close();
  }
});

test('saved names are redacted and a retained run.started remains authoritative', () => {
  const dir = tempDir();
  const file = path.join(dir, RUN_NAMES_FILE);
  assert.equal(
    writeRunNames(file, [['task', {name: 'password=hunter2', simulated: true, started_at: '2026-01-01T00:00:00Z'}]]),
    true,
  );
  assert.ok(!fs.readFileSync(file, 'utf8').includes('hunter2'));
  assert.equal(readRunNames(file).get('task')?.name, 'password=[REDACTED]');
  const store = new EventStore(dir);
  store.ingest(event('task', 'run.started', {name: '真实运行', simulated: false}));
  store.close();
  const restored = new EventStore(dir);
  assert.equal(restored.runs.get('task')?.name, '真实运行');
  assert.equal(restored.runs.get('task')?.simulated, false);
  restored.close();
});

test('missing, malformed, oversized and partly invalid metadata do not prevent recovery', () => {
  const dir = tempDir();
  const file = path.join(dir, RUN_NAMES_FILE);
  assert.equal(readRunNames(file).size, 0);
  fs.writeFileSync(file, '{');
  assert.equal(readRunNames(file).size, 0);
  fs.writeFileSync(file, 'x'.repeat(1024 * 1024 + 1));
  assert.equal(readRunNames(file).size, 0);
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      runs: [
        null,
        {id: 'bad', name: 'x', simulated: 'true', started_at: 'invalid'},
        {id: 'good', name: '保留', simulated: true, started_at: '2026-01-01T00:00:00Z'},
      ],
    }),
  );
  assert.equal(readRunNames(file).size, 1);
  assert.equal(readRunNames(file).get('good')?.name, '保留');
});

test('run-name storage is bounded by record count and bytes and retains the newest names', () => {
  const dir = tempDir();
  const file = path.join(dir, RUN_NAMES_FILE);
  const rows: [string, Pick<RunState, 'name' | 'simulated' | 'started_at'>][] = [];
  for (let i = 0; i < MAX_RUNS + MAX_EVICTED + 100; i++) {
    rows.push([`run-${i}`, {name: `运行 ${i}`, simulated: true, started_at: '2026-01-01T00:00:00Z'}]);
  }
  assert.equal(writeRunNames(file, rows), true);
  assert.equal(readRunNames(file).size, MAX_RUNS + MAX_EVICTED);
  assert.equal(readRunNames(file).has('run-0'), false);
  assert.equal(readRunNames(file).has(`run-${rows.length - 1}`), true);
  for (const row of rows) row[1].name = '长'.repeat(4096);
  assert.equal(writeRunNames(file, rows), true);
  assert.ok(fs.statSync(file).size <= 1024 * 1024);
  assert.ok(readRunNames(file).size < MAX_RUNS + MAX_EVICTED);
  assert.equal(readRunNames(file).has(`run-${rows.length - 1}`), true);
});

test('a locked run-name replacement preserves the old file, delays pruning and succeeds on retry', t => {
  const dir = tempDir();
  const first = new EventStore(dir, undefined, 600, 2);
  first.ingest(event('long', 'run.started', {name: '保留名字', simulated: true}));
  for (let i = 0; i < 6; i++) first.ingest(event('long', 'heartbeat'));
  const file = path.join(dir, RUN_NAMES_FILE);
  const before = fs.readFileSync(file, 'utf8');
  const rename = fs.renameSync;
  let locked = true;
  t.mock.method(fs, 'renameSync', (source: fs.PathLike, destination: fs.PathLike) => {
    if (String(destination) === file && locked) throw Object.assign(new Error('locked names'), {code: 'EBUSY'});
    return rename(source, destination);
  });
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const prune = t.mock.method(fs, 'unlinkSync');
  for (let i = 0; i < 2; i++) first.ingest(event('long', 'heartbeat'));
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.ok(segments(dir).length > 2);
  assert.equal(prune.mock.calls.filter(call => /^events-/.test(path.basename(String(call.arguments[0])))).length, 0);
  locked = false;
  now += 1500;
  first.ingest(event('long', 'heartbeat'));
  assert.equal(segments(dir).length, 2);
  first.close();
  const restored = new EventStore(dir, undefined, 600, 2);
  assert.equal(restored.runs.get('long')?.name, '保留名字');
  assert.equal(restored.runs.get('long')?.simulated, true);
  restored.close();
});

test('permanently unavailable run-name storage reports degradation while keeping segment growth bounded', t => {
  const dir = tempDir();
  const store = new EventStore(dir, undefined, 600, 2);
  store.ingest(event('task', 'run.started', {name: '运行', simulated: true}));
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source: fs.PathLike, destination: fs.PathLike) => {
    if (String(destination) === path.join(dir, RUN_NAMES_FILE))
      throw Object.assign(new Error('locked names'), {code: 'EBUSY'});
    return rename(source, destination);
  });
  const counts: number[] = [];
  for (let i = 0; i < 40; i++) {
    store.ingest(event('task', 'heartbeat'));
    counts.push(segments(dir).length);
  }
  assert.ok(Math.max(...counts) <= 2 + 5);
  assert.match(store.storageError ?? '', /名称文件持续写入失败/);
  t.mock.reset();
  for (let i = 0; i < 5; i++) store.ingest(event('task', 'heartbeat'));
  assert.equal(store.storageError, undefined, 'a successful replacement clears the stale write-failure warning');
  store.close();
});

test('a startup-locked names file is rehydrated before saving and preserves names absent from retained segments', t => {
  const dir = tempDir();
  const first = new EventStore(dir, undefined, 600, 2);
  first.ingest(event('old', 'run.started', {name: '模拟：需要保留', simulated: true}));
  for (let i = 0; i < 15; i++) first.ingest(event('old', 'heartbeat'));
  first.close();
  const file = path.join(dir, RUN_NAMES_FILE);
  const real = fs.readFileSync;
  const read = t.mock.method(fs, 'readFileSync', ((name: fs.PathOrFileDescriptor, options?: unknown) => {
    if (String(name) === file) throw Object.assign(new Error('scanner holds names'), {code: 'EBUSY'});
    return real(name, options as BufferEncoding);
  }) as typeof fs.readFileSync);
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const restored = new EventStore(dir, undefined, 600, 2);
  assert.equal(restored.runs.get('old')?.name, 'old');
  assert.match(restored.storageError ?? '', /名称文件暂时读不了/);
  read.mock.restore();
  now += 1500;
  restored.ingest(event('new', 'run.started', {name: '新运行'}));
  assert.equal(restored.runs.get('old')?.name, '模拟：需要保留');
  assert.equal(restored.runs.get('old')?.simulated, true);
  for (let i = 0; i < 8; i++) restored.ingest(event('new', 'heartbeat'));
  restored.close();
  assert.ok(!restored.exportLines().text.includes('"run_id":"old"'), 'old run is absent from the retained segments');
  assert.equal(readRunNames(file).get('old')?.name, '模拟：需要保留', 'old hints survive saves without a rebuilt run');
  const next = new EventStore(dir, undefined, 600, 2);
  next.ingest(event('old', 'heartbeat'));
  assert.equal(next.runs.get('old')?.name, '模拟：需要保留');
  assert.equal(next.runs.get('old')?.simulated, true);
  next.close();
});

test('permanently locked name reads never overwrite the original metadata and recover after bounded pruning', t => {
  const dir = tempDir();
  const first = new EventStore(dir, undefined, 600, 2);
  first.ingest(event('old', 'run.started', {name: '原始模拟名字', simulated: true}));
  for (let i = 0; i < 15; i++) first.ingest(event('old', 'heartbeat'));
  first.close();
  const file = path.join(dir, RUN_NAMES_FILE);
  const real = fs.readFileSync;
  const before = real(file, 'utf8');
  const read = t.mock.method(fs, 'readFileSync', ((name: fs.PathOrFileDescriptor, options?: unknown) => {
    if (String(name) === file) throw Object.assign(new Error('scanner holds names'), {code: 'EBUSY'});
    return real(name, options as BufferEncoding);
  }) as typeof fs.readFileSync);
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const store = new EventStore(dir, undefined, 600, 2);
  store.ingest(event('new', 'run.started', {name: '新增运行'}));
  let maximum = 0;
  for (let i = 0; i < 30; i++) {
    store.ingest(event('new', 'heartbeat'));
    maximum = Math.max(maximum, segments(dir).length);
  }
  assert.ok(maximum <= 2 + 5);
  assert.equal(real(file, 'utf8'), before);
  assert.match(store.storageError ?? '', /保留原名称文件/);
  read.mock.restore();
  now += 1500;
  for (let i = 0; i < 5; i++) store.ingest(event('new', 'heartbeat'));
  assert.equal(store.storageError, undefined);
  assert.equal(readRunNames(file).get('old')?.name, '原始模拟名字');
  assert.equal(readRunNames(file).get('new')?.name, '新增运行');
  store.ingest(event('old', 'heartbeat'));
  assert.equal(store.runs.get('old')?.name, '原始模拟名字');
  assert.equal(store.runs.get('old')?.simulated, true);
  store.close();
});

for (const type of ['run.completed', 'run.failed', 'run.cancelled']) {
  test(`${type} persists across pruning, restart and late decision events`, () => {
    const dir = tempDir();
    const store = new EventStore(dir, undefined, 600, 2);
    store.ingest(event('done', 'run.started', {name: '模拟：结束的任务', simulated: true}));
    const terminal = event('done', type);
    store.ingest(terminal);
    for (let i = 0; i < 15; i++) store.ingest(event('done', 'heartbeat'));
    store.close();
    assert.ok(!store.exportLines().text.includes(type), 'the terminal segment was pruned');
    const restored = new EventStore(dir, undefined, 600, 2);
    assert.equal(restored.runs.get('done')?.status, type.split('.')[1]);
    assert.equal(restored.runs.get('done')?.ended_at, terminal.occurred_at);
    restored.ingest({
      ...event('done', 'decision.started', {kind: 'choice', question: '迟到的判断'}),
      decision_id: 'late-decision',
      request_id: 'late-request',
      question_id: 'late-question',
    });
    assert.equal(restored.runs.get('done')?.status, type.split('.')[1]);
    assert.equal(restored.runs.get('done')?.name, '模拟：结束的任务');
    assert.equal(restored.runs.get('done')?.simulated, true);
    restored.close();
  });
}

test('legacy v1 name-only metadata remains readable without fabricating a terminal outcome', () => {
  const dir = tempDir();
  const file = path.join(dir, RUN_NAMES_FILE);
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      runs: [{id: 'legacy', name: '旧文件名字', simulated: true, started_at: '2026-01-01T00:00:00Z'}],
    }),
  );
  const store = new EventStore(dir);
  store.ingest(event('legacy', 'heartbeat'));
  assert.equal(store.runs.get('legacy')?.name, '旧文件名字');
  assert.equal(store.runs.get('legacy')?.simulated, true);
  assert.equal(store.runs.get('legacy')?.status, 'waiting');
  assert.equal(store.runs.get('legacy')?.ended_at, undefined);
  store.close();
});

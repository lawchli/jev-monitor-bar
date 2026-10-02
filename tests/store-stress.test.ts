import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_STRESS_EVENTS,
  MAX_STRESS_EVENTS,
  parseStoreStressArgs,
  runStoreStress,
} from '../scripts/loadtest/store-stress.mjs';

test('store stress arguments are bounded safe integers and default to a capacity-sized workload', () => {
  const defaults = parseStoreStressArgs([]);
  assert.equal(defaults.events, DEFAULT_STRESS_EVENTS);
  assert.equal(defaults.seed, 1);
  assert.ok(defaults.out.endsWith(path.join('.runtime', 'store-stress')));
  assert.deepEqual(parseStoreStressArgs(['--events=1', '--seed=0', '--out=/tmp/stress-out']), {
    events: 1,
    seed: 0,
    out: path.resolve('/tmp/stress-out'),
  });
  for (const value of ['0', '-1', '1.5', 'NaN', 'Infinity', '', '9007199254740992', String(MAX_STRESS_EVENTS + 1)])
    assert.throws(() => parseStoreStressArgs(['--events', value]));
  for (const value of ['-1', '1.5', 'NaN', 'Infinity', '4294967296'])
    assert.throws(() => parseStoreStressArgs(['--seed', value]));
  assert.throws(() => parseStoreStressArgs(['--out', ' ']));
  assert.throws(() => parseStoreStressArgs(['--unknown']));
});

test('short offline stress exercises real persisted events, export, reopen and continuation without clearing output', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-store-stress-test-'));
  const marker = path.join(out, 'keep.txt');
  fs.writeFileSync(marker, 'user-owned-marker');
  const first = runStoreStress({events: 180, seed: 7, out});
  const second = runStoreStress({events: 1, seed: 7, out});
  assert.notEqual(first.output, second.output);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'user-owned-marker');
  assert.equal(first.acceptedEvents, 180);
  assert.equal(first.export.events, 180);
  assert.equal(first.parseReplay.events, 180);
  assert.equal(first.reopen.cursor, 180);
  assert.equal(first.reopen.continuedCursor, 181);
  assert.equal(first.assertionsPassed, true);
  const report = JSON.parse(fs.readFileSync(path.join(first.output, 'report.json'), 'utf8'));
  assert.equal(report.method, 'offline-short-burst-real-eventstore');
  assert.equal(report.ingestMs.count, 180);
  assert.equal(report.disk.beforeReopen.segments, 1);
  const rows = fs
    .readdirSync(path.join(first.output, 'events'))
    .filter(name => name.endsWith('.jsonl'))
    .sort()
    .flatMap(name =>
      fs
        .readFileSync(path.join(first.output, 'events', name), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line)),
    );
  assert.equal(rows.length, 181);
  assert.equal(rows.at(-1).cursor, 181);
  assert.ok(rows.some(row => row.type === 'decision.started'));
  assert.match(fs.readFileSync(path.join(first.output, 'summary.md'), 'utf8'), /not a 30-minute soak/);
});

test('exported runner validates options before making output directories', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-store-stress-invalid-'));
  const out = path.join(parent, 'not-created');
  assert.throws(() => runStoreStress({events: NaN, seed: 1, out}));
  assert.equal(fs.existsSync(out), false);
});

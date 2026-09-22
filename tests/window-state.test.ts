import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  defaultWindowState,
  fitToDisplays,
  loadWindowState,
  saveWindowState,
  switchMode,
  type DisplayWorkArea,
  type Rect,
  type SavedWindowState,
} from '../src/main/window-state';

const primary: DisplayWorkArea = {id: 1, workArea: {x: 0, y: 0, width: 1920, height: 1080}, scaleFactor: 1};
const left: DisplayWorkArea = {id: 2, workArea: {x: -1920, y: 0, width: 1920, height: 1080}, scaleFactor: 1};

function centered(rect: Rect, area: Rect): Rect {
  const width = Math.min(rect.width, area.width);
  const height = Math.min(rect.height, area.height);
  return {
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    width,
    height,
  };
}

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-winstate-'));
  return path.join(dir, 'nested', 'window-state.json');
}

function sample(): SavedWindowState {
  return {
    version: 1,
    mode: 'compact',
    pinned: true,
    bounds: {
      compact: {x: 10, y: 20, width: 400, height: 132},
      expanded: {x: 30, y: 40, width: 440, height: 640},
    },
    displayId: 2,
    scaleFactor: 1.5,
  };
}

test('missing, corrupt, and unknown-version files load as undefined', () => {
  const file = tempFile();
  assert.equal(loadWindowState(file), undefined);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, '{');
  assert.equal(loadWindowState(file), undefined);
  fs.writeFileSync(file, 'null');
  assert.equal(loadWindowState(file), undefined);
  const broken = sample();
  fs.writeFileSync(file, JSON.stringify({...broken, version: 2}));
  assert.equal(loadWindowState(file), undefined);
  fs.writeFileSync(file, JSON.stringify({version: 1, mode: 'compact', pinned: true}));
  assert.equal(loadWindowState(file), undefined);
});

test('save round-trips and is only readable by the owner on POSIX', () => {
  const file = tempFile();
  const state = sample();
  saveWindowState(file, state);
  assert.deepEqual(loadWindowState(file), state);
  assert.equal(
    fs.readdirSync(path.dirname(file)).some(name => name.endsWith('.tmp')),
    false,
  );
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('rename retries EPERM twice and then replaces the file', t => {
  const file = tempFile();
  fs.mkdirSync(path.dirname(file), {recursive: true});
  let calls = 0;
  const original = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    calls += 1;
    if (calls <= 2) {
      const error = new Error('busy') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    }
    return original(from, to);
  });
  saveWindowState(file, sample());
  assert.equal(calls, 3);
  assert.deepEqual(loadWindowState(file)?.mode, 'compact');
});

test('a non-retryable rename removes the temp file and throws', t => {
  const file = tempFile();
  fs.mkdirSync(path.dirname(file), {recursive: true});
  t.mock.method(fs, 'renameSync', () => {
    const error = new Error('missing') as NodeJS.ErrnoException;
    error.code = 'ENOENT';
    throw error;
  });
  assert.throws(() => saveWindowState(file, sample()), /missing/);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readdirSync(path.dirname(file)).filter(name => name.endsWith('.tmp')).length, 0);
});

test('a window on a removed display is centered on the primary work area', () => {
  const rect = {x: -1800, y: 80, width: 400, height: 132};
  assert.deepEqual(fitToDisplays(rect, [primary, left], primary.id), rect);
  assert.deepEqual(fitToDisplays(rect, [primary], primary.id), centered(rect, primary.workArea));
});

test('a window on a left-hand display keeps its negative coordinates', () => {
  const rect = {x: -1500, y: 40, width: 400, height: 132};
  assert.deepEqual(fitToDisplays(rect, [primary, left], primary.id), rect);
});

test('a window larger than the work area keeps its origin and is clipped to the area', () => {
  const area = {x: 0, y: 0, width: 800, height: 600};
  const display: DisplayWorkArea = {id: 1, workArea: area, scaleFactor: 2};
  const rect = {x: 100, y: 50, width: 1000, height: 900};
  assert.deepEqual(fitToDisplays(rect, [display], display.id), {x: 100, y: 50, width: 700, height: 550});
  assert.deepEqual(fitToDisplays({x: 0, y: 0, width: 2000, height: 2000}, [display], display.id), {
    x: 0,
    y: 0,
    width: 800,
    height: 600,
  });
});

test('fit stays in DIP when the matching display has a non-1 scale factor', () => {
  const hiDpi: DisplayWorkArea = {id: 2, workArea: {x: 1920, y: 0, width: 1280, height: 800}, scaleFactor: 2};
  const rect = {x: 2000, y: 40, width: 400, height: 132};
  assert.deepEqual(fitToDisplays(rect, [primary, hiDpi], primary.id), rect);
});

test('the display with the wider title-bar overlap wins', () => {
  const right: DisplayWorkArea = {id: 3, workArea: {x: 1000, y: 0, width: 1000, height: 800}, scaleFactor: 1};
  const narrowLeft: DisplayWorkArea = {id: 4, workArea: {x: 0, y: 0, width: 1000, height: 800}, scaleFactor: 1};
  const rect = {x: 900, y: 0, width: 1500, height: 200};
  assert.deepEqual(fitToDisplays(rect, [narrowLeft, right], narrowLeft.id), {x: 900, y: 0, width: 1000, height: 200});
});

test('mode switch stores the live bounds without overwriting the other mode', () => {
  const initial = defaultWindowState();
  initial.bounds.compact = {x: 10, y: 20, width: 400, height: 132};
  initial.bounds.expanded = {x: 30, y: 40, width: 440, height: 640};
  const expanded = switchMode(initial, 'expanded', {x: 12, y: 22, width: 380, height: 120});
  assert.equal(expanded.mode, 'expanded');
  assert.deepEqual(expanded.bounds.compact, {x: 12, y: 22, width: 380, height: 120});
  assert.deepEqual(expanded.bounds.expanded, initial.bounds.expanded);
  const back = switchMode(expanded, 'compact', {x: 50, y: 60, width: 500, height: 700});
  assert.equal(back.mode, 'compact');
  assert.deepEqual(back.bounds.expanded, {x: 50, y: 60, width: 500, height: 700});
  assert.deepEqual(back.bounds.compact, expanded.bounds.compact);
  const file = tempFile();
  saveWindowState(file, back);
  assert.deepEqual(loadWindowState(file), back);
});

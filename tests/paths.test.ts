import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {resolveMonitorPaths, type ResolveMonitorPathsOptions} from '../src/paths';

interface PathCase {
  name: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homedir: string;
  cwd?: string;
  expected: {home: string; sessionFile: string};
}

const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/paths-cases.json'), 'utf8')) as PathCase[];

test('shared path cases cover home, session, and derived files', () => {
  assert.ok(cases.length >= 10);
  for (const item of cases) {
    const resolved = resolveMonitorPaths({
      platform: item.platform,
      env: item.env,
      homedir: item.homedir,
      cwd: item.cwd,
    });
    const pathApi = item.platform === 'win32' ? path.win32 : path.posix;
    assert.equal(resolved.home, item.expected.home, item.name);
    assert.equal(resolved.sessionFile, item.expected.sessionFile, item.name);
    assert.equal(resolved.eventsDir, pathApi.join(resolved.home, 'events'), item.name);
    assert.equal(resolved.windowStateFile, pathApi.join(resolved.home, 'window-state.json'), item.name);
    assert.equal(resolved.electronProfileDir, pathApi.join(resolved.home, 'electron-profile'), item.name);
  }
});

test('relative JEV_MONITOR_HOME uses process.cwd when cwd is omitted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-paths-'));
  const previous = process.cwd();
  process.chdir(dir);
  try {
    const resolved = resolveMonitorPaths({
      platform: 'linux',
      env: {JEV_MONITOR_HOME: 'rel'},
      homedir: '/home/me',
    } satisfies ResolveMonitorPathsOptions);
    assert.equal(resolved.home, path.posix.join(dir, 'rel'));
  } finally {
    process.chdir(previous);
  }
});

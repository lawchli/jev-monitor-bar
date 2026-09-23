import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const root = path.resolve(__dirname, '..');

interface RuntimeFresh {
  applyLaunchEnv(env: NodeJS.ProcessEnv, options: {demo: boolean; repoRoot: string}): NodeJS.ProcessEnv;
  freshRuntimeTarget(env: NodeJS.ProcessEnv, options: {demo: boolean; repoRoot: string}): string;
  removeFreshRuntime(repoRoot: string, target: string): void;
}

async function load(): Promise<RuntimeFresh> {
  return (await import(pathToFileURL(path.join(root, 'scripts/runtime-fresh.mjs')).href)) as RuntimeFresh;
}

function marker(dir: string, name = 'secret.txt') {
  fs.mkdirSync(dir, {recursive: true});
  const file = path.join(dir, name);
  fs.writeFileSync(file, 'keep');
  return file;
}

function kept(file: string) {
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep');
}

function linkDir(target: string, linkPath: string) {
  fs.symlinkSync(target, linkPath, 'junction');
}

test('demo fresh deletes only this repo runtime and pins the session file', async () => {
  const runtimeFresh = await load();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-fresh-demo-'));
  const repo = path.join(base, 'repo');
  const inherited = path.join(base, 'inherited');
  fs.mkdirSync(repo);
  const devFile = marker(path.join(repo, '.runtime', 'dev'));
  const demoDir = path.join(repo, '.runtime', 'demo');
  marker(demoDir, 'old.txt');
  const inheritedFile = marker(path.join(inherited, '.runtime', 'demo'));
  const inheritedSession = path.join(inherited, 'session.json');
  fs.writeFileSync(inheritedSession, 'keep');
  try {
    const env = runtimeFresh.applyLaunchEnv(
      {JEV_MONITOR_HOME: path.dirname(inheritedFile), JEV_MONITOR_SESSION: inheritedSession},
      {demo: true, repoRoot: repo},
    );
    assert.equal(env.JEV_MONITOR_HOME, path.resolve(repo, '.runtime', 'demo'));
    assert.equal(env.JEV_MONITOR_SESSION, path.join(env.JEV_MONITOR_HOME, 'session.json'));
    assert.throws(() => runtimeFresh.removeFreshRuntime(repo, path.dirname(inheritedFile)), /refusing to delete/);
    runtimeFresh.removeFreshRuntime(repo, runtimeFresh.freshRuntimeTarget(env, {demo: true, repoRoot: repo}));
    assert.equal(fs.existsSync(path.join(demoDir, 'old.txt')), false);
    assert.equal(fs.existsSync(demoDir), false);
    kept(devFile);
    kept(inheritedFile);
    assert.equal(fs.readFileSync(inheritedSession, 'utf8'), 'keep');
  } finally {
    fs.rmSync(base, {recursive: true, force: true});
  }
});

test('fresh delete without an inherited home removes only .runtime/dev', async () => {
  const runtimeFresh = await load();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-fresh-dev-'));
  const devDir = path.join(repo, '.runtime', 'dev');
  marker(devDir, 'old.txt');
  const demoFile = marker(path.join(repo, '.runtime', 'demo'));
  try {
    const env = runtimeFresh.applyLaunchEnv({}, {demo: false, repoRoot: repo});
    assert.equal(env.JEV_MONITOR_HOME, path.resolve(repo, '.runtime', 'dev'));
    runtimeFresh.removeFreshRuntime(repo, runtimeFresh.freshRuntimeTarget(env, {demo: false, repoRoot: repo}));
    assert.equal(fs.existsSync(path.join(devDir, 'old.txt')), false);
    kept(demoFile);
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
  }
});

test('fresh delete refuses an inherited home outside the repo runtime', async () => {
  const runtimeFresh = await load();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-fresh-refuse-'));
  const repo = path.join(base, 'repo');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(repo);
  const secret = marker(outside);
  try {
    const env = runtimeFresh.applyLaunchEnv({JEV_MONITOR_HOME: outside}, {demo: false, repoRoot: repo});
    assert.equal(env.JEV_MONITOR_HOME, outside);
    assert.throws(() => runtimeFresh.freshRuntimeTarget(env, {demo: false, repoRoot: repo}), /refusing to delete/);
    assert.throws(() => runtimeFresh.removeFreshRuntime(repo, outside), /refusing to delete/);
    assert.throws(
      () => runtimeFresh.removeFreshRuntime(repo, path.resolve(repo, '.runtime', 'demo', '..', '..', 'outside')),
      /refusing to delete/,
    );
    kept(secret);
    runtimeFresh.removeFreshRuntime(repo, path.resolve(repo, '.runtime', 'demo'));
    kept(secret);
  } finally {
    fs.rmSync(base, {recursive: true, force: true});
  }
});

test('fresh delete does not follow a symlink to another directory', async () => {
  const runtimeFresh = await load();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-fresh-link-'));
  const repo = path.join(base, 'repo');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(repo);
  const throughParent = marker(path.join(outside, 'demo'));
  linkDir(outside, path.join(repo, '.runtime'));
  const leafOutside = path.join(base, 'leaf-outside');
  const throughLeaf = marker(leafOutside);
  const leafRepo = path.join(base, 'leaf-repo', '.runtime');
  fs.mkdirSync(leafRepo, {recursive: true});
  linkDir(leafOutside, path.join(leafRepo, 'demo'));
  try {
    assert.throws(
      () => runtimeFresh.removeFreshRuntime(repo, path.resolve(repo, '.runtime', 'demo')),
      /refusing to delete through symlink/,
    );
    assert.throws(
      () => runtimeFresh.removeFreshRuntime(path.join(base, 'leaf-repo'), path.resolve(leafRepo, 'demo')),
      /refusing to delete through symlink/,
    );
    kept(throughParent);
    kept(throughLeaf);
    assert.equal(fs.lstatSync(path.join(repo, '.runtime')).isSymbolicLink(), true);
    assert.equal(fs.lstatSync(path.join(leafRepo, 'demo')).isSymbolicLink(), true);
  } finally {
    fs.rmSync(base, {recursive: true, force: true});
  }
});

test('fresh delete of a real runtime directory does not remove a linked outside tree', async () => {
  const runtimeFresh = await load();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-fresh-inner-'));
  const repo = path.join(base, 'repo');
  const outside = path.join(base, 'outside');
  const demo = path.join(repo, '.runtime', 'demo');
  fs.mkdirSync(demo, {recursive: true});
  fs.writeFileSync(path.join(demo, 'local.txt'), 'gone');
  const secret = marker(outside);
  linkDir(outside, path.join(demo, 'link'));
  try {
    runtimeFresh.removeFreshRuntime(repo, demo);
    assert.equal(fs.existsSync(demo), false);
    kept(secret);
  } finally {
    fs.rmSync(base, {recursive: true, force: true});
  }
});

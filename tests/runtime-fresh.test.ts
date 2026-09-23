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

test('custom home, outward symlink, and external session survive; demo fresh clears only in-repo demo', async () => {
  const runtimeFresh = await load();
  const {deleteFreshRuntime} = (await import(pathToFileURL(path.join(root, 'scripts/fresh-runtime.mjs')).href)) as {
    deleteFreshRuntime(candidate: string, root?: string): string;
  };
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-fresh-accept-'));
  const sessionText = '{"url":"http://127.0.0.1:9","token":"external"}';

  function runFresh(env: NodeJS.ProcessEnv, repo: string, demo: boolean) {
    const next = runtimeFresh.applyLaunchEnv(env, {demo, repoRoot: repo});
    const home = next.JEV_MONITOR_HOME;
    if (!home) throw new Error('launch env is missing JEV_MONITOR_HOME');
    runtimeFresh.freshRuntimeTarget(next, {demo, repoRoot: repo});
    deleteFreshRuntime(home, repo);
    return next;
  }

  const linked = path.join(base, 'linked');
  const linkedRepo = path.join(linked, 'repo');
  const linkedOutside = path.join(linked, 'outside');
  const linkedHome = path.join(linked, 'custom-home');
  const linkedSession = path.join(linked, 'session.json');
  fs.mkdirSync(linkedRepo, {recursive: true});
  const linkedHomeFile = marker(linkedHome, 'data.txt');
  fs.writeFileSync(linkedSession, sessionText);
  const linkedOutsideFile = marker(linkedOutside, 'secret.txt');
  fs.mkdirSync(path.join(linkedRepo, '.runtime'));
  linkDir(linkedOutside, path.join(linkedRepo, '.runtime', 'demo'));
  const linkedEnv = {JEV_MONITOR_HOME: linkedHome, JEV_MONITOR_SESSION: linkedSession};

  const real = path.join(base, 'real');
  const repo = path.join(real, 'repo');
  const outside = path.join(real, 'outside');
  const customHome = path.join(real, 'custom-home');
  const sessionFile = path.join(real, 'session.json');
  fs.mkdirSync(repo, {recursive: true});
  const customFile = marker(customHome, 'data.txt');
  fs.writeFileSync(sessionFile, sessionText);
  const outsideFile = marker(outside, 'secret.txt');
  const devFile = marker(path.join(repo, '.runtime', 'dev'));
  const demoDir = path.join(repo, '.runtime', 'demo');
  marker(demoDir, 'old.txt');
  const outward = path.join(repo, 'outward');
  linkDir(outside, outward);
  const inherited = {JEV_MONITOR_HOME: customHome, JEV_MONITOR_SESSION: sessionFile};

  try {
    assert.throws(() => runFresh(linkedEnv, linkedRepo, true), /--fresh refuses to delete/);
    assert.equal(linkedEnv.JEV_MONITOR_HOME, linkedHome);
    assert.equal(linkedEnv.JEV_MONITOR_SESSION, linkedSession);
    assert.equal(fs.lstatSync(path.join(linkedRepo, '.runtime', 'demo')).isSymbolicLink(), true);
    kept(linkedOutsideFile);
    kept(linkedHomeFile);
    assert.equal(fs.readFileSync(linkedSession, 'utf8'), sessionText);

    assert.throws(() => runFresh(inherited, repo, false), /refusing to delete/);
    kept(customFile);
    kept(devFile);
    kept(outsideFile);
    assert.equal(fs.readFileSync(path.join(demoDir, 'old.txt'), 'utf8'), 'keep');
    assert.equal(fs.readFileSync(sessionFile, 'utf8'), sessionText);
    assert.equal(fs.lstatSync(outward).isSymbolicLink(), true);

    const env = runFresh(inherited, repo, true);
    assert.equal(inherited.JEV_MONITOR_HOME, customHome);
    assert.equal(inherited.JEV_MONITOR_SESSION, sessionFile);
    assert.equal(env.JEV_MONITOR_HOME, path.resolve(repo, '.runtime', 'demo'));
    assert.equal(env.JEV_MONITOR_SESSION, path.join(env.JEV_MONITOR_HOME, 'session.json'));
    assert.notEqual(env.JEV_MONITOR_SESSION, sessionFile);
    assert.equal(fs.existsSync(demoDir), false);
    assert.equal(fs.existsSync(path.join(repo, '.runtime', 'demo', 'session.json')), false);
    kept(customFile);
    kept(devFile);
    kept(outsideFile);
    assert.equal(fs.readFileSync(sessionFile, 'utf8'), sessionText);
    assert.equal(fs.lstatSync(outward).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(path.join(outward, 'secret.txt'), 'utf8'), 'keep');
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

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

type FreshRuntime = {
  repoRoot: string;
  launchHome: (env: NodeJS.ProcessEnv, cwd?: string) => string;
  resolveFreshTarget: (candidate: string, root?: string) => string;
  deleteFreshRuntime: (candidate: string, root?: string) => string;
};

const freshRuntimeSpecifier: string = '../scripts/fresh-runtime.mjs';

async function load(): Promise<FreshRuntime> {
  return (await import(freshRuntimeSpecifier)) as FreshRuntime;
}

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function symlinkDir(target: string, link: string): void {
  if (process.platform === 'win32') fs.symlinkSync(target, link, 'junction');
  else fs.symlinkSync(target, link);
}

function removeLink(link: string): void {
  fs.rmSync(link, {recursive: true, force: true});
}

function removeTree(dir: string): void {
  fs.rmSync(dir, {recursive: true, force: true});
}

function writeMarker(dir: string, name: string, text: string): void {
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, name), text);
}

test('fresh target for this repository is its own runtime directory', async () => {
  const {repoRoot, resolveFreshTarget} = await load();
  const real = fs.realpathSync(repoRoot);
  assert.equal(real, fs.realpathSync(path.resolve(__dirname, '..')));
  assert.equal(resolveFreshTarget(path.join(repoRoot, '.runtime', 'dev')), path.join(real, '.runtime', 'dev'));
  assert.equal(resolveFreshTarget(path.join(repoRoot, '.runtime', 'demo')), path.join(real, '.runtime', 'demo'));
  assert.throws(() => resolveFreshTarget(os.tmpdir(), repoRoot), /--fresh refuses to delete/);
});

test('deletes only this repo .runtime/dev and .runtime/demo', async () => {
  const {deleteFreshRuntime, launchHome, resolveFreshTarget} = await load();
  const root = tempDir('jev-fresh-repo-');
  const elsewhere = tempDir('jev-fresh-else-');
  const dev = path.join(root, '.runtime', 'dev');
  const demo = path.join(root, '.runtime', 'demo');
  const real = fs.realpathSync(root);
  try {
    writeMarker(dev, 'marker', 'dev');
    writeMarker(demo, 'marker', 'demo');
    writeMarker(path.join(elsewhere, '.runtime', 'dev'), 'marker', 'else');

    assert.equal(resolveFreshTarget(dev, root), path.join(real, '.runtime', 'dev'));
    assert.equal(
      deleteFreshRuntime(launchHome({JEV_MONITOR_HOME: dev}, root), root),
      path.join(real, '.runtime', 'dev'),
    );
    assert.equal(fs.existsSync(dev), false);
    assert.equal(fs.readFileSync(path.join(demo, 'marker'), 'utf8'), 'demo');
    assert.equal(fs.readFileSync(path.join(elsewhere, '.runtime', 'dev', 'marker'), 'utf8'), 'else');

    assert.equal(
      deleteFreshRuntime(path.join(root, '.runtime', 'dev', '..', 'demo'), root),
      path.join(real, '.runtime', 'demo'),
    );
    assert.equal(fs.existsSync(demo), false);
    assert.equal(fs.readFileSync(path.join(elsewhere, '.runtime', 'dev', 'marker'), 'utf8'), 'else');

    deleteFreshRuntime(path.join(root, '.runtime', 'dev'), root);
    assert.equal(fs.readFileSync(path.join(elsewhere, '.runtime', 'dev', 'marker'), 'utf8'), 'else');
  } finally {
    removeTree(root);
    removeTree(elsewhere);
  }
});

test('does not delete an arbitrary path, a prefix, or a parent directory', async () => {
  const {deleteFreshRuntime, launchHome} = await load();
  const root = tempDir('jev-fresh-keep-');
  const outside = tempDir('jev-fresh-out-');
  const dev = path.join(root, '.runtime', 'dev');
  const demo = path.join(root, '.runtime', 'demo');
  try {
    writeMarker(dev, 'marker', 'dev');
    writeMarker(demo, 'marker', 'demo');
    writeMarker(path.join(root, '.runtime', 'dev-extra'), 'marker', 'extra');
    writeMarker(path.join(root, '.runtime', 'developer'), 'marker', 'developer');
    writeMarker(path.join(dev, 'events'), 'marker', 'events');
    writeMarker(outside, 'secret', 'keep');
    writeMarker(path.join(outside, '.runtime', 'dev'), 'marker', 'default-outside');
    writeMarker(path.join(root, 'secret'), 'marker', 'repo-secret');

    const refused = [
      outside,
      root,
      path.join(root, '.runtime'),
      path.join(root, '.runtime', 'dev-extra'),
      path.join(root, '.runtime', 'developer'),
      path.join(dev, 'events'),
      path.join(root, '.runtime', 'dev', '..', '..', 'secret'),
      launchHome({JEV_MONITOR_HOME: outside}, root),
      launchHome({}, outside),
      launchHome({JEV_MONITOR_HOME: ''}, outside),
    ];
    for (const candidate of refused) {
      assert.throws(() => deleteFreshRuntime(candidate, root), /--fresh refuses to delete/, candidate);
    }

    assert.equal(fs.readFileSync(path.join(dev, 'marker'), 'utf8'), 'dev');
    assert.equal(fs.readFileSync(path.join(demo, 'marker'), 'utf8'), 'demo');
    assert.equal(fs.readFileSync(path.join(dev, 'events', 'marker'), 'utf8'), 'events');
    assert.equal(fs.readFileSync(path.join(root, '.runtime', 'dev-extra', 'marker'), 'utf8'), 'extra');
    assert.equal(fs.readFileSync(path.join(root, '.runtime', 'developer', 'marker'), 'utf8'), 'developer');
    assert.equal(fs.readFileSync(path.join(outside, 'secret'), 'utf8'), 'keep');
    assert.equal(fs.readFileSync(path.join(outside, '.runtime', 'dev', 'marker'), 'utf8'), 'default-outside');
    assert.equal(fs.readFileSync(path.join(root, 'secret', 'marker'), 'utf8'), 'repo-secret');
  } finally {
    removeTree(root);
    removeTree(outside);
  }
});

test('a default home outside the repo is refused, and a repo-relative home is deleted', async () => {
  const {deleteFreshRuntime, launchHome} = await load();
  const root = tempDir('jev-fresh-rel-');
  const elsewhere = tempDir('jev-fresh-cwd-');
  const dev = path.join(root, '.runtime', 'dev');
  try {
    writeMarker(dev, 'marker', 'dev');
    writeMarker(path.join(elsewhere, '.runtime', 'dev'), 'marker', 'else');
    assert.equal(launchHome({}, elsewhere), path.resolve(elsewhere, '.runtime', 'dev'));
    assert.throws(() => deleteFreshRuntime(launchHome({}, elsewhere), root), /--fresh refuses to delete/);
    assert.equal(fs.readFileSync(path.join(elsewhere, '.runtime', 'dev', 'marker'), 'utf8'), 'else');

    deleteFreshRuntime(launchHome({JEV_MONITOR_HOME: '.runtime/dev'}, root), root);
    assert.equal(fs.existsSync(dev), false);
    assert.equal(fs.readFileSync(path.join(elsewhere, '.runtime', 'dev', 'marker'), 'utf8'), 'else');
  } finally {
    removeTree(root);
    removeTree(elsewhere);
  }
});

test('does not follow a symlink or junction out of the runtime directory', async () => {
  const {deleteFreshRuntime} = await load();
  const root = tempDir('jev-fresh-link-');
  const outside = tempDir('jev-fresh-target-');
  const demo = path.join(root, '.runtime', 'demo');
  try {
    writeMarker(path.join(outside, 'dev'), 'secret', 'keep');
    writeMarker(outside, 'secret', 'keep');
    symlinkDir(outside, path.join(root, '.runtime'));
    assert.throws(() => deleteFreshRuntime(path.join(root, '.runtime', 'dev'), root), /--fresh refuses to delete/);
    assert.equal(fs.readFileSync(path.join(outside, 'dev', 'secret'), 'utf8'), 'keep');
    assert.ok(fs.lstatSync(path.join(root, '.runtime')));
    removeLink(path.join(root, '.runtime'));
    assert.equal(fs.readFileSync(path.join(outside, 'dev', 'secret'), 'utf8'), 'keep');

    fs.mkdirSync(path.join(root, '.runtime'));
    symlinkDir(outside, path.join(root, '.runtime', 'dev'));
    assert.throws(() => deleteFreshRuntime(path.join(root, '.runtime', 'dev'), root), /--fresh refuses to delete/);
    assert.equal(fs.readFileSync(path.join(outside, 'secret'), 'utf8'), 'keep');
    assert.ok(fs.lstatSync(path.join(root, '.runtime', 'dev')));
    removeLink(path.join(root, '.runtime', 'dev'));

    writeMarker(demo, 'marker', 'demo');
    symlinkDir(demo, path.join(root, '.runtime', 'dev'));
    assert.throws(() => deleteFreshRuntime(path.join(root, '.runtime', 'dev'), root), /--fresh refuses to delete/);
    assert.equal(fs.readFileSync(path.join(demo, 'marker'), 'utf8'), 'demo');
    removeLink(path.join(root, '.runtime', 'dev'));

    const dev = path.join(root, '.runtime', 'dev');
    writeMarker(dev, 'marker', 'dev');
    symlinkDir(outside, path.join(dev, 'escape'));
    deleteFreshRuntime(dev, root);
    assert.equal(fs.existsSync(dev), false);
    assert.equal(fs.readFileSync(path.join(outside, 'secret'), 'utf8'), 'keep');
    assert.equal(fs.readFileSync(path.join(demo, 'marker'), 'utf8'), 'demo');
  } finally {
    removeTree(root);
    removeTree(outside);
  }
});

test('accepts the runtime directory through a symlink to the repository root', async () => {
  const {deleteFreshRuntime} = await load();
  const root = tempDir('jev-fresh-via-');
  const dev = path.join(root, '.runtime', 'dev');
  const link = path.join(path.dirname(root), `jev-fresh-alias-${path.basename(root)}`);
  try {
    writeMarker(dev, 'marker', 'dev');
    symlinkDir(root, link);
    const deleted = deleteFreshRuntime(path.join(link, '.runtime', 'dev'), root);
    assert.equal(deleted, path.join(fs.realpathSync(root), '.runtime', 'dev'));
    assert.equal(fs.existsSync(dev), false);
    assert.ok(fs.lstatSync(link));
  } finally {
    fs.rmSync(link, {recursive: true, force: true});
    removeTree(root);
  }
});

test('launch.mjs deletes through the runtime guard', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/launch.mjs'), 'utf8');
  assert.match(source, /freshRuntimeTarget\(env,\s*\{demo,\s*repoRoot\}\)/);
  assert.match(source, /deleteFreshRuntime\(\s*home,\s*repoRoot\s*\)/);
  assert.doesNotMatch(source, /removeFreshRuntime\s*\(/);
  assert.doesNotMatch(source, /rmSync\s*\(/);
});

test('one repository cannot fresh another repository runtime', async () => {
  const {deleteFreshRuntime} = await load();
  const root = tempDir('jev-fresh-a-');
  const other = tempDir('jev-fresh-b-');
  try {
    writeMarker(path.join(other, '.runtime', 'dev'), 'marker', 'other');
    writeMarker(path.join(other, '.runtime', 'demo'), 'marker', 'other-demo');
    assert.throws(() => deleteFreshRuntime(path.join(other, '.runtime', 'dev'), root), /--fresh refuses to delete/);
    assert.throws(() => deleteFreshRuntime(path.join(other, '.runtime', 'demo'), root), /--fresh refuses to delete/);
    assert.equal(fs.readFileSync(path.join(other, '.runtime', 'dev', 'marker'), 'utf8'), 'other');
    assert.equal(fs.readFileSync(path.join(other, '.runtime', 'demo', 'marker'), 'utf8'), 'other-demo');
  } finally {
    removeTree(root);
    removeTree(other);
  }
});

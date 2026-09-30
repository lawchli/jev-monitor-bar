import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const root = path.resolve(__dirname, '..');
const posix = process.platform !== 'win32';

interface TreeEntry {
  rel: string;
  type: 'file' | 'dir' | 'symlink';
  mode: number;
  size?: number;
  target?: string;
  sha256?: string;
}
interface ZipEntry {
  name: string;
  type: 'file' | 'dir' | 'symlink';
  mode: number;
  size?: number;
  target?: string;
  sha256?: string;
}
interface ReleaseZip {
  walkTree(dir: string): TreeEntry[];
  hashTree(dir: string): Promise<TreeEntry[]>;
  writeDirectoryZip(dir: string, topName: string, zipPath: string, options?: {mtime?: Date}): Promise<string>;
  readZipEntries(zipPath: string): Promise<ZipEntry[]>;
  compareTreeWithZip(
    dirEntries: TreeEntry[],
    zipEntries: ZipEntry[],
    topName: string,
    options: {checkModes: boolean},
  ): string[];
}

async function load(): Promise<ReleaseZip> {
  return (await import(pathToFileURL(path.join(root, 'scripts/release-zip.mjs')).href)) as ReleaseZip;
}

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-release-zip-'));
  const dir = path.join(base, 'app');
  fs.mkdirSync(path.join(dir, 'Versions', 'A'), {recursive: true});
  fs.mkdirSync(path.join(dir, 'empty'));
  fs.writeFileSync(path.join(dir, 'Versions', 'A', 'binary'), Buffer.from([0, 1, 2, 3, 255]));
  fs.writeFileSync(path.join(dir, 'readme.txt'), '说明\n'.repeat(100));
  if (posix) {
    fs.chmodSync(path.join(dir, 'Versions', 'A', 'binary'), 0o755);
    fs.chmodSync(path.join(dir, 'readme.txt'), 0o644);
    fs.symlinkSync('A', path.join(dir, 'Versions', 'Current'));
    fs.symlinkSync('Versions/Current/binary', path.join(dir, 'binary'));
  }
  return {base, dir, zipPath: path.join(base, 'app.zip')};
}

test('directory zip round-trips content, empty dirs, exec bits and symlinks', async () => {
  const zipTools = await load();
  const {base, dir, zipPath} = fixture();
  try {
    const partial = await zipTools.writeDirectoryZip(dir, 'jev-monitor-bar-test', zipPath, {
      mtime: new Date('2026-01-01T00:00:00Z'),
    });
    assert.equal(partial, `${zipPath}.partial`);
    fs.renameSync(partial, zipPath);
    const tree = await zipTools.hashTree(dir);
    const entries = await zipTools.readZipEntries(zipPath);
    assert.deepEqual(zipTools.compareTreeWithZip(tree, entries, 'jev-monitor-bar-test', {checkModes: posix}), []);
    const names = entries.map(entry => entry.name);
    assert.equal(names[0], 'jev-monitor-bar-test');
    assert.ok(names.includes('jev-monitor-bar-test/empty'));
    assert.equal(entries.find(entry => entry.name === 'jev-monitor-bar-test/empty')?.type, 'dir');
    if (posix) {
      const current = entries.find(entry => entry.name === 'jev-monitor-bar-test/Versions/Current');
      assert.equal(current?.type, 'symlink');
      assert.equal(current?.target, 'A');
      const binary = entries.find(entry => entry.name === 'jev-monitor-bar-test/Versions/A/binary');
      assert.equal((binary?.mode ?? 0) & 0o777, 0o755);
      assert.equal((entries.find(entry => entry.name === 'jev-monitor-bar-test/readme.txt')?.mode ?? 0) & 0o777, 0o644);
    }
    fs.writeFileSync(path.join(dir, 'readme.txt'), 'changed');
    fs.writeFileSync(path.join(dir, 'new.txt'), 'new');
    const changed = zipTools.compareTreeWithZip(await zipTools.hashTree(dir), entries, 'jev-monitor-bar-test', {
      checkModes: posix,
    });
    assert.ok(changed.includes('jev-monitor-bar-test/readme.txt: content differs'));
    assert.ok(changed.includes('zip is missing jev-monitor-bar-test/new.txt'));
  } finally {
    fs.rmSync(base, {recursive: true, force: true});
  }
});

test('zip comparison flags unsafe, duplicate, extra and retyped entries', async () => {
  const zipTools = await load();
  const tree: TreeEntry[] = [{rel: 'a.txt', type: 'file', mode: 0o100644, size: 1, sha256: 'x'}];
  const problems = zipTools.compareTreeWithZip(
    tree,
    [
      {name: 'top', type: 'dir', mode: 0o40755},
      {name: 'top/a.txt', type: 'symlink', mode: 0o120755, target: 'b'},
      {name: 'top/a.txt', type: 'symlink', mode: 0o120755, target: 'b'},
      {name: 'top/../evil', type: 'file', mode: 0o100644, size: 0, sha256: 'y'},
    ],
    'top',
    {checkModes: true},
  );
  assert.ok(problems.includes('unsafe entry top/../evil'));
  assert.ok(problems.includes('duplicate entry top/a.txt'));
  assert.ok(problems.includes('zip has extra top/../evil'));
  assert.ok(problems.includes('top/a.txt: symlink in zip, file on disk'));
});

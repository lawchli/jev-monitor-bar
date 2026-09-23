import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

// Mirrors Node's lookup: nested node_modules first, then each ancestor node_modules (pnpm keeps deps as siblings).
function locate(name: string, fromDir: string) {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate =
      path.basename(dir) === 'node_modules' ? path.join(dir, name) : path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate);
    if (path.dirname(dir) === dir) return undefined;
  }
}
function hasNativeFiles(dir: string): boolean {
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    if (entry.name === 'node_modules') continue;
    if (
      entry.isDirectory()
        ? hasNativeFiles(path.join(dir, entry.name))
        : entry.name.endsWith('.node') || entry.name === 'binding.gyp'
    )
      return true;
  }
  return false;
}

test('runtime dependencies are pure JavaScript without install scripts', () => {
  const seen = new Map<string, string>(),
    problems: string[] = [];
  const queue = Object.keys(readJson(path.join(root, 'package.json')).dependencies ?? {}).map(name => ({
    name,
    from: root,
    optional: false,
  }));
  while (queue.length) {
    const {name, from, optional} = queue.shift()!;
    const dir = locate(name, from);
    // Platform-specific optional packages are only installed where they apply; the ones present are still checked.
    if (!dir) {
      if (!optional) problems.push(`${name}: not installed`);
      continue;
    }
    if (seen.has(dir)) continue;
    const pkg = readJson(path.join(dir, 'package.json'));
    seen.set(dir, `${pkg.name}@${pkg.version}`);
    const scripts = Object.keys(pkg.scripts ?? {}).filter(s => ['preinstall', 'install', 'postinstall'].includes(s));
    if (scripts.length) problems.push(`${pkg.name}: install scripts ${scripts.join(', ')}`);
    if (pkg.gypfile || hasNativeFiles(dir)) problems.push(`${pkg.name}: native addon`);
    for (const dep of Object.keys(pkg.dependencies ?? {})) queue.push({name: dep, from: dir, optional: false});
    for (const dep of Object.keys(pkg.optionalDependencies ?? {})) queue.push({name: dep, from: dir, optional: true});
  }
  assert.ok(seen.size > 0);
  assert.deepEqual(problems, [], `Runtime dependencies must not need extra components:\n${problems.join('\n')}`);
});

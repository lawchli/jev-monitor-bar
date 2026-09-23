import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
fs.rmSync(dist, {recursive: true, force: true});

const shared = {bundle: true, sourcemap: true};

await esbuild.build({
  ...shared,
  entryPoints: [path.join(root, 'src/main/index.ts')],
  outfile: path.join(dist, 'main.cjs'),
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
});

await esbuild.build({
  ...shared,
  entryPoints: [path.join(root, 'src/preload/index.ts')],
  outfile: path.join(dist, 'preload.cjs'),
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
});

await esbuild.build({
  ...shared,
  entryPoints: {[path.join('app')]: path.join(root, 'src/renderer/main.tsx')},
  outdir: path.join(dist, 'renderer'),
  platform: 'browser',
  format: 'iife',
  target: 'chrome130',
  jsx: 'automatic',
});

fs.copyFileSync(path.join(root, 'src/renderer/index.html'), path.join(dist, 'renderer/index.html'));

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const platformAllowed = new Set(['src/paths.ts', 'src/main/platform.ts']);
const schemaUrl = 'http://json-schema.org/draft-07/schema#';

function listSources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listSources(full));
    else if (entry.isFile() && /\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found;
}

function allowedUrl(url: string): boolean {
  if (url === schemaUrl || url.startsWith(schemaUrl)) return true;
  const host = url.slice(url.indexOf('://') + 3).split(/[/:?#]/)[0];
  return host === '127.0.0.1';
}

function lineViolations(rel: string, line: string, lineNo: number): string[] {
  const at = `${rel}:${lineNo}`;
  const hits: string[] = [];
  const flag = (when: boolean, label: string) => {
    if (when) hits.push(`${at} ${label}`);
  };
  flag(line.includes('process.platform') && !platformAllowed.has(rel), 'process.platform');
  flag(line.includes('child_process'), 'child_process');
  flag(/(?<![0-9])0\.0\.0\.0(?![0-9])/.test(line), '0.0.0.0');
  flag(line.includes('globalShortcut'), 'globalShortcut');
  flag(line.includes('openExternal'), 'openExternal');
  flag(line.includes('setLoginItemSettings'), 'setLoginItemSettings');
  flag(/eval\s*\(/.test(line), 'eval(');
  flag(/new Function\s*\(/.test(line), 'new Function(');
  flag(line.includes('dangerouslySetInnerHTML'), 'dangerouslySetInnerHTML');
  flag(/fetch\s*\(/.test(line), 'fetch(');
  flag(line.includes('XMLHttpRequest'), 'XMLHttpRequest');
  flag(line.includes('WebSocket'), 'WebSocket');
  for (const match of line.matchAll(/https?:\/\/[^\s'"`)\\]+/g)) {
    const url = match[0].replace(/[,;]+$/, '');
    if (!allowedUrl(url)) hits.push(`${at} ${url}`);
  }
  return hits;
}

test('src stays inside platform and antivirus boundaries', () => {
  const files = listSources(path.join(root, 'src'));
  assert.ok(files.length > 0, 'expected src to contain TypeScript sources');
  const hits = files.flatMap(file => {
    const rel = path.relative(root, file).split(path.sep).join('/');
    return fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .flatMap((line, index) => lineViolations(rel, line, index + 1));
  });
  assert.deepEqual(hits, []);
});

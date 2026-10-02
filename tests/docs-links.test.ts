import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(__dirname, '..');
const documents = [
  'README.md',
  'python/README.md',
  'docs/INTEGRATION.md',
  'docs/PROTOCOL.md',
  'docs/HANDOFF.md',
  'docs/WINDOWS_ACCEPTANCE.md',
];

test('current delivery documents link to files that exist inside the repository', () => {
  let checked = 0;
  for (const document of documents) {
    const file = path.join(root, document);
    const markdown = fs.readFileSync(file, 'utf8').replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '');
    for (const match of markdown.matchAll(/!?\[[^\]]+\]\((<[^>]+>|[^\s)]+)(?:\s+["'][^"']*["'])?\)/g)) {
      const target = match[1].replace(/^<|>$/g, '');
      if (/^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith('#')) continue;
      const pathname = decodeURIComponent(target.split(/[?#]/, 1)[0]);
      const resolved = path.resolve(path.dirname(file), pathname);
      const relative = path.relative(root, resolved);
      assert.ok(
        relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
        `${document}: ${target} escapes the repository`,
      );
      assert.ok(fs.existsSync(resolved), `${document}: missing link target ${target}`);
      checked++;
    }
  }
  assert.ok(checked >= 15, `expected meaningful documentation link coverage, checked ${checked}`);
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {
  createRendererHandler,
  RENDERER_ORIGIN,
  RENDERER_SCHEME_PRIVILEGES,
  RENDERER_URL,
  resolveRendererFile,
} from '../src/main/renderer-protocol';

const root = path.resolve(__dirname, '..');
const roots = [
  {name: 'posix', api: path.posix, root: '/opt/jev-monitor-bar/resources/app.asar/dist/renderer'},
  {name: 'win32', api: path.win32, root: 'C:\\Users\\me\\jev-monitor-bar\\resources\\app.asar\\dist\\renderer'},
] as const;

test('renderer URLs serve the complete build output from a standard origin without CSP bypass', async () => {
  assert.equal(RENDERER_ORIGIN, 'app://renderer');
  assert.equal(RENDERER_URL, 'app://renderer/index.html');
  assert.deepEqual({...RENDERER_SCHEME_PRIVILEGES}, {standard: true, secure: true});
  const config = (await import(pathToFileURL(path.join(root, 'scripts/package-config.mjs')).href)) as {
    REQUIRED_ASAR_FILES: readonly string[];
  };
  const shipped = config.REQUIRED_ASAR_FILES.filter(entry => entry.startsWith('/dist/renderer/'));
  assert.ok(shipped.length >= 3);
  for (const {name, api, root: base} of roots) {
    for (const entry of [...shipped, '/dist/renderer/app.js.map', '/dist/renderer/app.css.map']) {
      const filename = entry.slice('/dist/renderer/'.length);
      const resolved = resolveRendererFile(base, `${RENDERER_ORIGIN}/${filename}`, api);
      assert.equal(resolved?.file, api.join(base, filename), `${name} ${entry}`);
      assert.ok(resolved?.mimeType, entry);
    }
    assert.equal(resolveRendererFile(base, 'app://renderer/app.js?v=1#x', api)?.file, api.join(base, 'app.js'));
  }
});

test('renderer URLs refuse arbitrary files, path escapes and other origins on Windows and POSIX', () => {
  const rejected = [
    'app://renderer/..%2fmain.cjs',
    'app://renderer/..%2f..%2f..%2fetc%2fpasswd',
    'app://renderer/%2E%2E%2Fmain.js',
    'app://renderer/..%5cmain.js',
    'app://renderer/..%5C..%5CWindows%5Cwin.ini',
    'app://renderer/a\\..\\..\\main.js',
    'app://renderer//etc/passwd.js',
    'app://renderer/C:/Windows/win.ini.js',
    'app://renderer/C:%5cWindows%5cwin.ini.js',
    'app://renderer/%5c%5cserver%5cshare%5cx.js',
    'app://renderer/app.js::$DATA',
    'app://renderer/index.html%00.js',
    'app://renderer/.env.js',
    'app://renderer/app.js.',
    'app://renderer/app.js%20',
    'app://renderer/nul.js',
    'app://renderer/CON',
    'app://renderer/com1.js',
    'app://renderer/toString',
    'app://renderer/constructor',
    'app://renderer/__proto__',
    'app://renderer/',
    'app://renderer',
    'app://renderer/main.cjs',
    'app://renderer/main.js',
    'app://renderer/icons/custom.svg',
    'app://renderer/sub/app.js',
    'app://renderer/sub//app.js',
    'app://renderer/%E0%A4%A.js',
    'file:///etc/hosts',
    'http://renderer/index.html',
    'app://other/index.html',
    'app://renderer:8080/index.html',
    'app://user:pass@renderer/index.html',
    'app:index.html',
    'not a url',
  ];
  for (const {name, api, root: base} of roots) {
    for (const url of rejected) assert.equal(resolveRendererFile(base, url, api), undefined, `${name} ${url}`);
    // URL parsing may normalize dot segments, but only the final allowlisted renderer asset can be read.
    for (const url of ['app://renderer/../app.js', 'app://renderer/%2e%2e/%2E%2e/app.js']) {
      assert.equal(resolveRendererFile(base, url, api)?.file, api.join(base, 'app.js'), `${name} ${url}`);
    }
  }
});

test('the handler returns renderer contents, safe MIME types, HEAD responses and no filesystem errors', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-renderer-protocol-'));
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  const rendererDir = path.join(base, 'renderer');
  fs.mkdirSync(rendererDir);
  fs.writeFileSync(path.join(rendererDir, 'index.html'), '<!doctype html><title>x</title>');
  fs.writeFileSync(path.join(rendererDir, 'app.js'), 'window.x = 1;\n');
  fs.writeFileSync(path.join(base, 'secret.js'), 'window.secret = 1;\n');
  const handler = createRendererHandler(rendererDir);
  const request = (url: string, method = 'GET') => handler(new Request(url, {method}));
  const html = await request(RENDERER_URL);
  assert.equal(html.status, 200);
  assert.equal(html.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(html.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await html.text(), '<!doctype html><title>x</title>');
  const script = await request('app://renderer/app.js');
  assert.equal(script.status, 200);
  assert.equal(script.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(await script.text(), 'window.x = 1;\n');
  const head = await request('app://renderer/app.js', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  const post = await request('app://renderer/app.js', 'POST');
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');
  for (const url of ['app://renderer/app.css', 'app://renderer/..%2fsecret.js', 'app://other/secret.js']) {
    const response = await request(url);
    assert.equal(response.status, 404, url);
    assert.equal(await response.text(), '', url);
  }
});

test('rejected URLs and methods do not cause any filesystem reads', async () => {
  const reads: string[] = [];
  const handler = createRendererHandler('/renderer', async file => {
    reads.push(file);
    return new Uint8Array();
  });
  assert.equal((await handler(new Request('app://renderer/secrets.js'))).status, 404);
  assert.equal((await handler(new Request(RENDERER_URL, {method: 'PUT'}))).status, 405);
  assert.deepEqual(reads, []);
});

test('an allowlisted symlink cannot expose a file outside the unpacked renderer', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-renderer-symlink-'));
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  const rendererDir = path.join(base, 'renderer');
  fs.mkdirSync(rendererDir);
  const secret = path.join(base, 'secret.js');
  fs.writeFileSync(secret, 'window.secret = true;');
  try {
    fs.symlinkSync(secret, path.join(rendererDir, 'app.js'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    t.skip('This Windows account cannot create symlinks');
    return;
  }
  const response = await createRendererHandler(rendererDir)(new Request('app://renderer/app.js'));
  assert.equal(response.status, 404);
  assert.equal(await response.text(), '');
});

test('renderer CSP restricts scripts to its own origin and denies network, frames and workers', () => {
  const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
  const match = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html);
  assert.ok(match, 'index.html needs a CSP meta tag');
  const directives = new Map(
    match[1].split(';').map(part => {
      const [name, ...values] = part.trim().split(/\s+/);
      return [name, values] as const;
    }),
  );
  for (const name of ['default-src', 'script-src', 'style-src']) assert.deepEqual(directives.get(name), ["'self'"]);
  for (const name of ['connect-src', 'object-src', 'frame-src', 'worker-src', 'base-uri', 'form-action']) {
    assert.deepEqual(directives.get(name), ["'none'"], name);
  }
  assert.ok(!match[1].includes('unsafe-'));
  assert.ok(!/\bfile:/.test(match[1]));
});

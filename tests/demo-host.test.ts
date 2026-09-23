import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startServer} from '../src/server';
import {metrics, type RunState} from '../src/state';
import {EventStore} from '../src/store';

const root = path.resolve(__dirname, '..');

function writeSession(home: string, url: string, token = 'token') {
  fs.mkdirSync(home, {recursive: true});
  fs.writeFileSync(path.join(home, 'session.json'), JSON.stringify({url, token}));
}

function runHost(args: string[], timeoutMs: number) {
  const started = Date.now();
  const child = spawn(process.execPath, [path.join(root, 'scripts/demo-host.mjs'), ...args], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', chunk => {
    output += chunk;
  });
  child.stderr?.on('data', chunk => {
    output += chunk;
  });
  return new Promise<{code: number; output: string; elapsed: number}>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`demo host timed out after ${timeoutMs}ms\n${output}`));
    }, timeoutMs);
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', exitCode => {
      clearTimeout(timer);
      resolve({code: exitCode ?? 1, output, elapsed: Date.now() - started});
    });
  });
}

function listen(onRequest: http.RequestListener) {
  const server = http.createServer(onRequest);
  server.headersTimeout = 0;
  server.requestTimeout = 0;
  return new Promise<{port: number; close: () => Promise<void>}>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('expected a tcp port'));
        return;
      }
      resolve({
        port: address.port,
        close: () =>
          new Promise(done => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}

function assertReadyTimeout(result: {code: number; output: string; elapsed: number}) {
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /receiver not ready within 20s/);
  assert.ok(result.elapsed >= 19_000, `exited too early: ${result.elapsed}ms\n${result.output}`);
  assert.ok(result.elapsed < 28_000, `exited too late: ${result.elapsed}ms\n${result.output}`);
}

interface ScenarioExpect {
  run_status: string;
  decisions: Record<string, string>;
  attempts: Record<string, string>;
  metrics?: {passed: number; failed: number; unknown: number; unverified: number; retries: number};
}

function observed(run: RunState): ScenarioExpect {
  const decisions: Record<string, string> = {};
  for (const [id, decision] of Object.entries(run.decisions)) decisions[id] = decision.status;
  const attempts: Record<string, string> = {};
  for (const attempt of Object.values(run.attempts)) attempts[`${attempt.action_id}/${attempt.id}`] = attempt.status;
  return {run_status: run.status, decisions, attempts, metrics: metrics(run)};
}

test('demo host replays every scenario once through the receiver', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-demo-'));
  const store = new EventStore(path.join(home, 'events'));
  const server = await startServer(store, path.join(home, 'session.json'));
  const started = Date.now();
  const child = spawn(
    process.execPath,
    [path.join(root, 'scripts/demo-host.mjs'), '--fast', '--once', '--home', home],
    {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout?.on('data', chunk => {
    output += chunk;
  });
  child.stderr?.on('data', chunk => {
    output += chunk;
  });
  try {
    const code = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`demo host timed out\n${output}`));
      }, 15_000);
      child.on('exit', exitCode => {
        clearTimeout(timer);
        resolve(exitCode ?? 1);
      });
    });
    assert.equal(code, 0, output);
    assert.ok(Date.now() - started < 15_000, 'fast replay must skip the reconnect pause');
    const index = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/scenarios/index.json'), 'utf8')) as {
      scenarios: {id: string; file: string; expect: ScenarioExpect}[];
    };
    assert.equal(store.runs.size, index.scenarios.length);
    for (const scenario of index.scenarios) {
      const first = JSON.parse(
        fs.readFileSync(path.join(root, 'fixtures/scenarios', scenario.file), 'utf8').split('\n')[0],
      );
      const run = [...store.runs.values()].find(item => item.name === first.payload.name);
      assert.ok(run, scenario.id);
      assert.deepEqual(observed(run), scenario.expect, scenario.id);
    }
    const byProducer = new Map<string, number[]>();
    for (const event of store.events) {
      const sequences = byProducer.get(event.producer_id) ?? [];
      sequences.push(event.sequence);
      byProducer.set(event.producer_id, sequences);
    }
    assert.equal(byProducer.size, index.scenarios.length);
    for (const [producerId, sequences] of byProducer) {
      assert.deepEqual(
        sequences,
        sequences.map((_, index) => index + 1),
        producerId,
      );
    }
  } finally {
    if (child.exitCode === null) child.kill();
    await server.close();
  }
});

test('demo host accepts only a canonical loopback origin', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-demo-origin-'));
  const store = new EventStore(path.join(home, 'events'));
  const server = await startServer(store, path.join(home, 'session.json'));
  const sessionFile = path.join(home, 'session.json');
  const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8')) as {url: string; token: string};
  fs.writeFileSync(sessionFile, JSON.stringify({url: `${session.url}/`, token: session.token}));
  try {
    const result = await runHost(['--fast', '--once', '--scenario', 'normal', '--home', home], 15_000);
    assert.equal(result.code, 0, result.output);
    assert.equal(store.runs.size, 1);
  } finally {
    await server.close();
  }
});

test('demo host does not connect for a non-canonical session URL', async () => {
  const hits: string[] = [];
  const server = await listen((req, res) => {
    hits.push(`${req.method} ${req.url ?? ''}`);
    res.writeHead(200, {'content-type': 'application/json'});
    res.end('{"ok":true}');
  });
  const urls = [
    `http://localhost:${server.port}`,
    `http://user:secret@127.0.0.1:${server.port}/extra?q=1#frag`,
    `https://127.0.0.1:${server.port}`,
    `http://127.0.0.1:${server.port}/health`,
  ];
  const homes = urls.map(() => fs.mkdtempSync(path.join(os.tmpdir(), 'jev-demo-reject-')));
  try {
    const results = await Promise.all(
      urls.map((url, index) => {
        writeSession(homes[index], url, 'secret');
        return runHost(['--fast', '--once', '--home', homes[index]], 30_000);
      }),
    );
    for (const result of results) assertReadyTimeout(result);
    assert.deepEqual(hits, []);
  } finally {
    await server.close();
  }
});

test('demo host does not follow a health redirect', async () => {
  const targetHits: string[] = [];
  const target = await listen((req, res) => {
    targetHits.push(`${req.method} ${req.url ?? ''}`);
    res.writeHead(200);
    res.end('stolen');
  });
  const sourceHits: string[] = [];
  const source = await listen((req, res) => {
    sourceHits.push(`${req.method} ${req.url ?? ''}`);
    res.writeHead(307, {location: `http://127.0.0.1:${target.port}/health`});
    res.end();
  });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-demo-redirect-'));
  writeSession(home, `http://127.0.0.1:${source.port}`, 'secret');
  try {
    const result = await runHost(['--fast', '--once', '--home', home], 30_000);
    assertReadyTimeout(result);
    assert.ok(sourceHits.length > 0);
    assert.deepEqual(targetHits, []);
  } finally {
    await source.close();
    await target.close();
  }
});

test('demo host gives up when health never responds', async () => {
  const server = await listen(() => {
    // The connection is accepted and no headers are written.
  });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-demo-hang-'));
  writeSession(home, `http://127.0.0.1:${server.port}`, 'secret');
  try {
    const result = await runHost(['--fast', '--once', '--home', home], 30_000);
    assertReadyTimeout(result);
  } finally {
    await server.close();
  }
});

test('demo host exits when an event redirect would leave the session origin', async () => {
  const targetHits: string[] = [];
  const target = await listen((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      targetHits.push(`${req.method} ${req.url ?? ''} ${Buffer.concat(chunks).toString('utf8')}`);
      res.writeHead(200);
      res.end('stolen');
    });
  });
  const source = await listen((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, {'content-type': 'application/json'});
      res.end('{"ok":true}');
      return;
    }
    res.writeHead(307, {location: `http://127.0.0.1:${target.port}/events`});
    res.end();
  });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-demo-event-redirect-'));
  writeSession(home, `http://127.0.0.1:${source.port}`, 'secret');
  try {
    const result = await runHost(['--fast', '--once', '--scenario', 'normal', '--home', home], 15_000);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /event rejected 307/);
    assert.deepEqual(targetHits, []);
  } finally {
    await source.close();
    await target.close();
  }
});

test('demo host exits 1 on a non-401 event response', async () => {
  const server = await listen((req, res) => {
    req.resume();
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, {'content-type': 'application/json'});
      res.end('{"ok":true}');
      return;
    }
    res.writeHead(400, {'content-type': 'application/json'});
    res.end('{"error":"bad event"}');
  });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-demo-400-'));
  writeSession(home, `http://127.0.0.1:${server.port}`, 'secret');
  try {
    const result = await runHost(['--fast', '--once', '--scenario', 'normal', '--home', home], 15_000);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /event rejected 400: \{"error":"bad event"\}/);
  } finally {
    await server.close();
  }
});

test('demo host retries with a replaced session after 401', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-demo-401-'));
  const sessionFile = path.join(home, 'session.json');
  let accepted = 0;
  let rejected = 0;
  const server = await listen((req, res) => {
    req.resume();
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, {'content-type': 'application/json'});
      res.end('{"ok":true}');
      return;
    }
    if (req.headers.authorization !== 'Bearer fresh') {
      rejected += 1;
      fs.writeFileSync(sessionFile, JSON.stringify({url: `http://127.0.0.1:${server.port}`, token: 'fresh'}));
      res.writeHead(401, {'content-type': 'application/json'});
      res.end('{"error":"unauthorized"}');
      return;
    }
    accepted += 1;
    res.writeHead(200, {'content-type': 'application/json'});
    res.end('{"accepted":true}');
  });
  writeSession(home, `http://127.0.0.1:${server.port}`, 'stale');
  try {
    const result = await runHost(['--fast', '--once', '--scenario', 'normal', '--home', home], 15_000);
    assert.equal(result.code, 0, result.output);
    assert.ok(rejected >= 1);
    assert.equal(accepted, 10);
  } finally {
    await server.close();
  }
});

test('demo host retries an event post that never responds', async () => {
  let hung = false;
  let accepted = 0;
  const server = await listen((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, {'content-type': 'application/json'});
      res.end('{"ok":true}');
      return;
    }
    if (!hung) {
      hung = true;
      return;
    }
    req.resume();
    accepted += 1;
    res.writeHead(200, {'content-type': 'application/json'});
    res.end('{"accepted":true}');
  });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-demo-event-hang-'));
  writeSession(home, `http://127.0.0.1:${server.port}`, 'secret');
  try {
    const result = await runHost(['--fast', '--once', '--scenario', 'normal', '--home', home], 20_000);
    assert.equal(result.code, 0, result.output);
    assert.equal(hung, true);
    assert.equal(accepted, 10);
  } finally {
    await server.close();
  }
});

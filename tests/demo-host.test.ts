import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startServer} from '../src/server';
import {metrics, type RunState} from '../src/state';
import {EventStore} from '../src/store';

const root = path.resolve(__dirname, '..');

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
  } finally {
    if (child.exitCode === null) child.kill();
    await server.close();
  }
});

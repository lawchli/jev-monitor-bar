import {randomBytes} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const fast = args.includes('--fast');
const once = args.includes('--once');

function option(name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    console.error(`missing value for ${name}`);
    process.exit(1);
  }
  return value;
}

const home = option('--home') ?? process.env.JEV_MONITOR_HOME;
if (!home) {
  console.error('JEV_MONITOR_HOME or --home is required');
  process.exit(1);
}
const sessionFile = process.env.JEV_MONITOR_SESSION || path.join(home, 'session.json');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function readSession() {
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    if (!parsed || typeof parsed.url !== 'string' || typeof parsed.token !== 'string') return undefined;
    const url = new URL(parsed.url);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') return undefined;
    return {url: parsed.url.replace(/\/$/, ''), token: parsed.token};
  } catch {
    return undefined;
  }
}

async function waitReady() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const session = readSession();
    if (session) {
      try {
        const response = await fetch(`${session.url}/health`, {headers: {authorization: `Bearer ${session.token}`}});
        if (response.ok) return session;
      } catch {
        // Receiver is not up yet.
      }
    }
    await sleep(200);
  }
  console.error('receiver not ready within 20s');
  process.exit(1);
}

async function postEvent(sessionRef, body) {
  let delay = 200;
  for (;;) {
    const session = sessionRef.current;
    try {
      const response = await fetch(`${session.url}/events`, {
        method: 'POST',
        headers: {'content-type': 'application/json', authorization: `Bearer ${session.token}`},
        body,
      });
      if (response.status === 200) return;
      const text = await response.text();
      if (response.status === 401) {
        const next = readSession();
        if (next) sessionRef.current = next;
        await sleep(delay);
        delay = Math.min(delay * 2, 5_000);
        continue;
      }
      console.error(`event rejected ${response.status}: ${text}`);
      process.exit(1);
    } catch {
      const next = readSession();
      if (next) sessionRef.current = next;
      await sleep(delay);
      delay = Math.min(delay * 2, 5_000);
    }
  }
}

let lastMs = 0;
function stamp() {
  let ms = Date.now();
  if (ms <= lastMs) ms = lastMs + 1;
  lastMs = ms;
  return new Date(ms).toISOString();
}

function rewrite(event, runId, producerId, sequence, occurredAt) {
  return {
    ...event,
    run_id: runId,
    producer_id: producerId,
    sequence,
    event_id: `${runId}-${sequence}`,
    occurred_at: occurredAt,
  };
}

const catalog = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/scenarios/index.json'), 'utf8'));
const only = option('--scenario');
let scenarios = catalog.scenarios;
if (only) {
  scenarios = scenarios.filter(scenario => scenario.id === only);
  if (scenarios.length !== 1) {
    console.error(`unknown scenario ${only}`);
    process.exit(1);
  }
}

const sessionRef = {current: await waitReady()};
const producerId = `demo-host-${process.pid}-${randomBytes(4).toString('hex')}`;
let generation = 0;

do {
  for (const scenario of scenarios) {
    generation += 1;
    const runId = `demo-${scenario.id}-${Date.now().toString(36)}-${generation.toString(36)}`;
    const lines = fs
      .readFileSync(path.join(root, 'fixtures/scenarios', scenario.file), 'utf8')
      .split('\n')
      .filter(Boolean);
    for (let index = 0; index < lines.length; index += 1) {
      if (index > 0) await sleep(fast ? 0 : scenario.delay_ms);
      const event = rewrite(JSON.parse(lines[index]), runId, producerId, index + 1, stamp());
      await postEvent(sessionRef, JSON.stringify(event));
      if (scenario.pause_after_index === index) await sleep(fast ? 0 : (scenario.pause_ms ?? 0));
    }
  }
} while (!once);

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {setImmediate} from 'node:timers/promises';
import test from 'node:test';
import {startServer} from '../src/server';
import {EventStore} from '../src/store';

async function receiver(t: {after(fn: () => Promise<void>): void}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-utf8-'));
  const store = new EventStore(path.join(directory, 'events'));
  const started = await startServer(store, path.join(directory, 'session.json'));
  t.after(async () => {
    await started.close();
    store.close();
    fs.rmSync(directory, {recursive: true, force: true});
  });
  return {...started, store};
}

function heartbeat(summary: string) {
  return JSON.stringify({
    schema_version: 1,
    event_id: 'event',
    run_id: 'run',
    producer_id: 'producer',
    sequence: 1,
    occurred_at: '2026-10-04T00:00:00Z',
    type: 'heartbeat',
    payload: {summary},
  });
}

function request(session: {url: string; token: string}) {
  let req!: http.ClientRequest;
  const response = new Promise<{status: number; body: string}>((resolve, reject) => {
    req = http.request(
      session.url + '/events',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${session.token}`,
        },
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () =>
          resolve({
            status: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on('error', reject);
  });
  return {req, response};
}

test('malformed UTF-8 inside otherwise valid JSON is rejected without confirming an event', async t => {
  const {session, store} = await receiver(t);
  const [before, after] = heartbeat('PLACEHOLDER').split('PLACEHOLDER');
  const invalid = [
    {name: 'invalid continuation', bytes: [0xc3, 0x28]},
    {name: 'truncated two-byte sequence', bytes: [0xc3]},
    {name: 'truncated three-byte sequence', bytes: [0xe4, 0xb8]},
    {name: 'overlong encoding', bytes: [0xe0, 0x80, 0x80]},
    {name: 'surrogate code point', bytes: [0xed, 0xa0, 0x80]},
    {name: 'code point above Unicode range', bytes: [0xf4, 0x90, 0x80, 0x80]},
  ];
  for (const sample of invalid) {
    const {req, response} = request(session);
    req.end(Buffer.concat([Buffer.from(before), Buffer.from(sample.bytes), Buffer.from(after)]));
    const received = await response;
    assert.equal(received.status, 400, sample.name);
    assert.deepEqual(JSON.parse(received.body), {error: 'Invalid JSON'}, sample.name);
    assert.equal(store.cursor, 0, sample.name);
    assert.equal(store.events.length, 0, sample.name);
  }
  const normal = request(session);
  normal.req.end(heartbeat('ordinary ASCII'));
  assert.equal((await normal.response).status, 200);
  assert.equal(store.cursor, 1);
});

test('valid multi-byte UTF-8 survives chunk boundaries including a literal replacement character', async t => {
  const {session, store} = await receiver(t);
  const [before, after] = heartbeat('PLACEHOLDER').split('PLACEHOLDER');
  const text = '中文🙂�';
  const encoded = Buffer.from(text);
  const {req, response} = request(session);
  req.write(Buffer.concat([Buffer.from(before), encoded.subarray(0, 1)]));
  await setImmediate();
  req.write(encoded.subarray(1, 2));
  await setImmediate();
  req.end(Buffer.concat([encoded.subarray(2), Buffer.from(after)]));
  assert.equal((await response).status, 200);
  assert.equal(store.cursor, 1);
  assert.equal(store.events[0].payload.summary, text);
});

test('UTF-8 decoding preserves the existing rejection of a leading JSON byte-order mark', async t => {
  const {session, store} = await receiver(t);
  const {req, response} = request(session);
  req.end(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(heartbeat('summary'))]));
  assert.equal((await response).status, 400);
  assert.equal(store.cursor, 0);
  assert.equal(store.events.length, 0);
});

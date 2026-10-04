import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import test from 'node:test';
import {startServer} from '../src/server';
import {EventStore} from '../src/store';

async function receiver(t: {after(fn: () => Promise<void>): void}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-body-limit-'));
  const store = new EventStore(path.join(directory, 'events'));
  const started = await startServer(store, path.join(directory, 'session.json'));
  t.after(async () => {
    await started.close();
    store.close();
    fs.rmSync(directory, {recursive: true, force: true});
  });
  return {...started, store};
}

function heartbeat(sequence = 1) {
  return JSON.stringify({
    schema_version: 1,
    event_id: `event-${sequence}`,
    run_id: 'run',
    producer_id: 'producer',
    sequence,
    occurred_at: '2026-10-04T00:00:00Z',
    type: 'heartbeat',
    payload: {summary: '中文'},
  });
}

function request(session: {url: string; token: string}) {
  let req!: http.ClientRequest;
  const response = new Promise<{status: number; connection?: string; body: string}>((resolve, reject) => {
    req = http.request(
      session.url + '/events',
      {method: 'POST', headers: {'content-type': 'application/json', authorization: `Bearer ${session.token}`}},
      res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () =>
          resolve({
            status: res.statusCode!,
            connection: res.headers.connection,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on('error', reject);
  });
  return {req, response};
}

test('a chunked body over 64 KiB gets a complete 413 before the sender ends it', {timeout: 7000}, async t => {
  const {session, server, store} = await receiver(t);
  const closed = new Promise<void>(resolve => server.once('connection', socket => socket.once('close', resolve)));
  const {req, response} = request(session);
  t.after(() => req.destroy());
  req.write(Buffer.alloc(32768, 120));
  req.write(Buffer.alloc(32768, 120));
  req.write(Buffer.from('x'));
  // Deliberately leave the chunked request unfinished: it already exceeds the body budget.
  const received = await response;
  assert.equal(received.status, 413);
  assert.equal(received.connection, 'close');
  assert.deepEqual(JSON.parse(received.body), {error: '64 KiB event limit'});
  await closed;
  assert.equal(await new Promise<number>(resolve => server.getConnections((_error, count) => resolve(count))), 0);
  assert.equal(store.cursor, 0);
  assert.equal(store.events.length, 0);

  const valid = request(session);
  valid.req.end(heartbeat());
  assert.equal((await valid.response).status, 200);
  assert.equal(store.cursor, 1);
});

test('the 64 KiB byte boundary is accepted for a chunked JSON request', async t => {
  const {session, store} = await receiver(t);
  const body = Buffer.from(heartbeat());
  const {req, response} = request(session);
  req.write(body.subarray(0, body.length - 1));
  req.write(body.subarray(body.length - 1));
  req.end(Buffer.alloc(65536 - body.length, 32));
  assert.equal((await response).status, 200);
  assert.equal(store.cursor, 1);
  assert.equal(store.events[0].payload.summary, '中文');
});

test('a completed oversized chunked request still flushes the 413 response', async t => {
  const {session, store} = await receiver(t);
  const {req, response} = request(session);
  req.write(Buffer.alloc(65536, 120));
  req.end(Buffer.from('x'));
  const received = await response;
  assert.equal(received.status, 413);
  assert.deepEqual(JSON.parse(received.body), {error: '64 KiB event limit'});
  assert.equal(store.cursor, 0);
});

test('an aborted partial body does not ingest and leaves the receiver usable', async t => {
  const {session, server, store} = await receiver(t);
  const closed = new Promise<void>(resolve => server.once('connection', socket => socket.once('close', resolve)));
  const receivedRequest = once(server, 'request');
  const partial = request(session);
  // A local abort is expected to reject the client request before it can receive a response.
  const aborted = partial.response.catch(() => undefined);
  partial.req.write(heartbeat().slice(0, 20));
  await receivedRequest;
  partial.req.destroy();
  await aborted;
  await closed;
  assert.equal(store.cursor, 0);
  const valid = request(session);
  valid.req.end(heartbeat());
  assert.equal((await valid.response).status, 200);
  assert.equal(store.cursor, 1);
});

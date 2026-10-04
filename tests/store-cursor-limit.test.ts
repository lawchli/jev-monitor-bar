import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type {MonitorEvent} from '../src/protocol';
import {EventStore} from '../src/store';
import {startServer} from '../src/server';

function event(sequence: number): MonitorEvent {
  return {
    schema_version: 1,
    event_id: `event-${sequence}`,
    run_id: 'run-1',
    producer_id: 'host-1',
    sequence,
    occurred_at: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString(),
    type: 'heartbeat',
    payload: {},
  };
}

function directoryAt(cursor: number) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-cursor-limit-'));
  fs.writeFileSync(
    path.join(directory, 'events-00000001.jsonl'),
    `${JSON.stringify({...event(1), received_at: '2026-01-01T00:00:01.000Z', cursor})}\n`,
  );
  return directory;
}

function segmentContents(directory: string) {
  return fs
    .readdirSync(directory)
    .filter(name => name.endsWith('.jsonl'))
    .sort()
    .map(name => [name, fs.readFileSync(path.join(directory, name), 'utf8')]);
}

test('an exhausted recovered cursor rejects new events before changing disk or memory', () => {
  const directory = directoryAt(Number.MAX_SAFE_INTEGER);
  const store = new EventStore(directory);
  try {
    const disk = segmentContents(directory);
    const snapshot = structuredClone(store.snapshot('run-1'));
    for (let retry = 0; retry < 2; retry++) {
      assert.throws(() => store.ingest(event(2)), {code: 'EOVERFLOW'});
      assert.deepEqual(segmentContents(directory), disk);
      assert.deepEqual(structuredClone(store.snapshot('run-1')), snapshot);
    }
    store.close();
    const recovered = new EventStore(directory);
    try {
      assert.equal(recovered.cursor, Number.MAX_SAFE_INTEGER);
      assert.equal(recovered.corruptLines, 0);
      assert.deepEqual(
        recovered.events.map(row => row.event_id),
        ['event-1'],
      );
    } finally {
      recovered.close();
    }
  } finally {
    store.close();
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

test('the final safe cursor is acknowledged and recoverable, and retries still dedupe at exhaustion', () => {
  const directory = directoryAt(Number.MAX_SAFE_INTEGER - 1);
  const store = new EventStore(directory);
  try {
    assert.deepEqual(store.ingest(event(2)), {accepted: true, cursor: Number.MAX_SAFE_INTEGER});
    assert.deepEqual(store.ingest(event(2)), {accepted: false, cursor: Number.MAX_SAFE_INTEGER});
    assert.deepEqual(store.ingest({...event(2), event_id: 'conflicting-sequence'}), {
      accepted: false,
      conflict: true,
      cursor: Number.MAX_SAFE_INTEGER,
    });
    assert.throws(() => store.ingest(event(3)), {code: 'EOVERFLOW'});
    store.close();
    const recovered = new EventStore(directory);
    try {
      assert.equal(recovered.cursor, Number.MAX_SAFE_INTEGER);
      assert.equal(recovered.corruptLines, 0);
      assert.deepEqual(
        recovered.events.map(row => [row.event_id, row.cursor]),
        [
          ['event-1', Number.MAX_SAFE_INTEGER - 1],
          ['event-2', Number.MAX_SAFE_INTEGER],
        ],
      );
      assert.deepEqual(recovered.ingest(event(2)), {accepted: false, cursor: Number.MAX_SAFE_INTEGER});
      assert.throws(() => recovered.ingest(event(3)), {code: 'EOVERFLOW'});
    } finally {
      recovered.close();
    }
  } finally {
    store.close();
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

test('the receiver reports cursor exhaustion as unavailable storage and preserves duplicate acknowledgements', async () => {
  const directory = directoryAt(Number.MAX_SAFE_INTEGER);
  const store = new EventStore(directory);
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    server = await startServer(store, path.join(directory, 'session.json'));
    const post = (row: MonitorEvent) =>
      new Promise<{status: number; body: unknown}>((resolve, reject) => {
        const request = http.request(
          `${server!.session.url}/events`,
          {
            method: 'POST',
            headers: {'content-type': 'application/json', authorization: `Bearer ${server!.session.token}`},
          },
          response => {
            let text = '';
            response.setEncoding('utf8');
            response.on('data', chunk => (text += chunk));
            response.on('end', () => resolve({status: response.statusCode!, body: JSON.parse(text)}));
            response.on('error', reject);
          },
        );
        request.on('error', reject);
        request.end(JSON.stringify(row));
      });
    assert.deepEqual(await post(event(2)), {status: 503, body: {error: 'Storage unavailable'}});
    assert.deepEqual(await post(event(1)), {
      status: 200,
      body: {accepted: false, cursor: Number.MAX_SAFE_INTEGER},
    });
    assert.equal(store.cursor, Number.MAX_SAFE_INTEGER);
    assert.equal(store.events.length, 1);
    assert.equal(store.corruptLines, 0);
  } finally {
    await server?.close();
    store.close();
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

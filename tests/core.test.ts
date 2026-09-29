import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {validateEvent} from '../src/protocol';
import {EventStore} from '../src/store';
import {startServer} from '../src/server';
import {metrics} from '../src/state';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jev-monitor-'));
let n = 0;
const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
function ev(type: string, extra: Record<string, unknown> = {}, payload: Record<string, unknown> = {}) {
  n++;
  return {
    schema_version: 1,
    event_id: `e${n}`,
    run_id: 'run-1',
    producer_id: 'host-1',
    sequence: n,
    occurred_at: at(n),
    type,
    payload,
    ...extra,
  };
}
const decision = {decision_id: 'd1', request_id: 'req1', question_id: 'next'};
const attempt = (id: string) => ({action_id: 'act1', attempt_id: id, decision_id: 'd1'});

test('protocol rejects primitive misuse and unsourced rules', () => {
  assert.throws(() => validateEvent(ev('decision.resolved', decision, {kind: 'noul', noul: 0.4, confidence: 0.9})));
  assert.throws(() =>
    validateEvent(ev('decision.resolved', decision, {kind: 'choice', choice: 'a', probabilities: {a: 0.5, b: 0.2}})),
  );
  assert.throws(() =>
    validateEvent(ev('action.selected', attempt('t1'), {action: 'b', source: 'rule', rule: 'avoid-danger'})),
  );
  assert.throws(() =>
    validateEvent(ev('decision.started', {request_id: 'req1', question_id: 'q'}, {kind: 'choice', question: '?'})),
  );
  assert.doesNotThrow(() =>
    validateEvent(
      ev('decision.resolved', decision, {
        kind: 'choice',
        choice: 'a',
        probabilities: {a: 0.8, b: 0.2},
        confidence: 0.6,
      }),
    ),
  );
});

test('dedupes by event_id and reports reused producer sequences as conflicts', () => {
  const store = new EventStore(tempDir());
  const first = ev('heartbeat');
  assert.equal(store.ingest(first).accepted, true);
  assert.deepEqual(store.ingest(first), {accepted: false, cursor: 1});
  assert.deepEqual(store.ingest({...first, event_id: 'restarted-sender'}), {
    accepted: false,
    conflict: true,
    cursor: 1,
  });
});

test('a locked old segment does not fail ingestion', t => {
  const store = new EventStore(tempDir(), undefined, 200, 1);
  const unlink = t.mock.method(fs, 'unlinkSync', () => {
    throw Object.assign(new Error('locked'), {code: 'EPERM'});
  });
  for (let i = 0; i < 5; i++) assert.equal(store.ingest(ev('heartbeat')).accepted, true);
  assert.ok(unlink.mock.callCount() > 0);
  unlink.mock.restore();
  store.ingest(ev('heartbeat'));
  assert.equal(fs.readdirSync(store.directory).length, 1);
});

test('candidate names that look sensitive survive sanitizing and restart', () => {
  const dir = tempDir();
  const store = new EventStore(dir);
  store.ingest(
    ev('decision.resolved', decision, {
      kind: 'choice',
      choice: 'reset_password',
      candidates: {reset_password: '重置', read_env: null},
      probabilities: {reset_password: 0.7, read_env: 0.3},
      usage: {input_tokens: 12},
    }),
  );
  const restored = new EventStore(dir);
  assert.equal(restored.corruptLines, 0);
  assert.deepEqual(restored.events[0].payload.probabilities, {reset_password: 0.7, read_env: 0.3});
  assert.deepEqual(restored.events[0].payload.usage, {input_tokens: 12});
});

test('secrets in text are redacted and diagnostics are dropped unless enabled', () => {
  const payload = {
    summary: 'call with Authorization: Bearer abc.def and api_key=sk-1234567890abcdef',
    diagnostic: {headers: {authorization: 'x'}, env: {A: '1'}},
  };
  const plain = new EventStore(tempDir());
  plain.ingest(ev('progress.updated', {}, payload));
  assert.doesNotMatch(plain.events[0].payload.summary!, /abc\.def|sk-1234567890abcdef/);
  assert.equal(plain.events[0].payload.diagnostic, undefined);
  const diag = new EventStore(tempDir(), undefined, undefined, undefined, true);
  diag.ingest(ev('progress.updated', {}, payload));
  assert.deepEqual(diag.events[0].payload.diagnostic, {headers: {authorization: '[REDACTED]'}, env: '[REDACTED]'});
});

test('out-of-order decision events keep the resolved result', () => {
  const store = new EventStore(tempDir());
  const started = ev('decision.started', decision, {
    kind: 'choice',
    question: '下一步？',
    candidates: {a: null, b: null},
  });
  const resolved = ev('decision.resolved', decision, {kind: 'choice', choice: 'a', probabilities: {a: 0.9, b: 0.1}});
  store.ingest(resolved);
  store.ingest(started);
  const d = store.runs.get('run-1')!.decisions.d1;
  assert.equal(d.status, 'selected');
  assert.equal(d.payload.question, '下一步？');
  assert.equal(store.runs.get('run-1')!.latest!.event_id, resolved.event_id);
});

test('terminal run status is not reverted by late or older events', () => {
  const store = new EventStore(tempDir());
  const failedEarlier = ev('run.failed');
  store.ingest(ev('run.started', {}, {name: 'demo'}));
  const completed = ev('run.completed');
  store.ingest(completed);
  store.ingest(ev('decision.started', decision, {kind: 'choice', question: '?'}));
  store.ingest(failedEarlier);
  const run = store.runs.get('run-1')!;
  assert.equal(run.status, 'completed');
  assert.equal(run.ended_at, completed.occurred_at);
});

test('rule override, retry, and unverified completion are tracked separately', () => {
  const store = new EventStore(tempDir());
  store.ingest(ev('decision.resolved', decision, {kind: 'choice', choice: 'a', probabilities: {a: 0.6, b: 0.4}}));
  store.ingest(
    ev('action.selected', attempt('t1'), {
      action: 'b',
      source: 'rule',
      rule: 'avoid-danger',
      rule_source: 'policy.yaml',
    }),
  );
  store.ingest(ev('action.started', attempt('t1')));
  store.ingest(ev('action.failed', attempt('t1'), {reason: 'timeout'}));
  store.ingest(
    ev('action.selected', attempt('t2'), {
      action: 'b',
      source: 'rule',
      rule: 'avoid-danger',
      rule_source: 'policy.yaml',
    }),
  );
  store.ingest(ev('action.completed', attempt('t2')));
  const run = store.runs.get('run-1')!;
  assert.equal(run.decisions.d1.payload.choice, 'a');
  const t1 = run.attempts[JSON.stringify(['act1', 't1'])],
    t2 = run.attempts[JSON.stringify(['act1', 't2'])];
  assert.equal(t1.selected!.payload.action, 'b');
  assert.equal(t1.status, 'failed');
  assert.equal(t2.status, 'unverified');
  assert.deepEqual(metrics(run), {passed: 0, failed: 0, unknown: 0, unverified: 1, retries: 1});
  store.ingest(
    ev('verification.completed', attempt('t2'), {
      result: 'failed',
      checks: [{name: 'door-open', observed: 'closed', result: 'failed'}],
    }),
  );
  assert.equal(t2.status, 'verification_failed');
});

test('receiver answers a stalled request body with 408 within a few seconds', async () => {
  const dir = tempDir();
  const store = new EventStore(path.join(dir, 'events'));
  const srv = await startServer(store, path.join(dir, 'session.json'));
  try {
    const started = Date.now();
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        srv.session.url + '/events',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': '100',
            authorization: `Bearer ${srv.session.token}`,
          },
        },
        res => {
          res.resume();
          resolve(res.statusCode!);
        },
      );
      req.on('error', reject);
      // Send part of the declared body and never finish it.
      req.write('{"type":');
    });
    const elapsed = Date.now() - started;
    assert.equal(status, 408);
    assert.ok(elapsed < 5000, `408 after ${elapsed} ms`);
  } finally {
    await srv.close();
  }
});

function request(url: string, headers: Record<string, string>, body: string, chunked = false) {
  return new Promise<number>((resolve, reject) => {
    const req = http.request(url, {method: 'POST', headers: {'content-type': 'application/json', ...headers}}, res => {
      res.resume();
      resolve(res.statusCode!);
    });
    req.on('error', reject);
    if (chunked) {
      req.write(body.slice(0, 40000));
      req.end(body.slice(40000));
    } else req.end(body);
  });
}

test('receiver enforces credential, origin, size, and sequence conflicts', async () => {
  const dir = tempDir();
  const store = new EventStore(path.join(dir, 'events'));
  const srv = await startServer(store, path.join(dir, 'session.json'));
  try {
    const url = srv.session.url + '/events',
      auth = {authorization: `Bearer ${srv.session.token}`};
    const body = JSON.stringify(ev('heartbeat'));
    assert.equal(await request(url, {}, body), 401);
    assert.equal(await request(url, {authorization: srv.session.token}, body), 401);
    assert.equal(await request(url, {authorization: `bearer ${srv.session.token}`}, body), 401);
    assert.equal(await request(url, {...auth, origin: 'https://example.com'}, body), 403);
    assert.equal(await request(url, auth, 'x'.repeat(70000)), 413);
    assert.equal(await request(url, auth, 'x'.repeat(70000), true), 413);
    assert.equal(await request(url, auth, body), 200);
    assert.equal(await request(url, auth, JSON.stringify({...JSON.parse(body), event_id: 'other'})), 409);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')), srv.session);
  } finally {
    await srv.close();
  }
});

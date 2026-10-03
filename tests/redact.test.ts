import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {validateEvent, type MonitorEvent} from '../src/protocol';
import {redact, sanitizeEvent} from '../src/redact';
import {parseReplay} from '../src/replay';
import {EventStore} from '../src/store';

// All credentials are synthetic fixtures, never taken from the host environment.
const github = 'ghp_' + 'a'.repeat(36);
const slack = 'xoxb-' + '0'.repeat(12) + '-' + '0'.repeat(12) + '-abcdefghijklmno';
const aws = 'AKIA' + 'B'.repeat(16);
const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlIn0.c2lnbmF0dXJl';
const cases = [
  ['JSON quoted password', '{"password": "fixture secret", "ok": 2}', ['fixture secret']],
  ['Python quoted token', "{'token': 'fixture secret', 'ok': 2}", ['fixture secret']],
  ['escaped JSON quote', '{"api_key":"first\\\"second", "ok":2}', ['first', 'second']],
  ['escaped Python quote', "{'password':'first\\'second', 'ok':2}", ['first', 'second']],
  ['AWS environment assignment', 'AWS_SECRET_ACCESS_KEY=fixtureAwsSecret next=ok', ['fixtureAwsSecret']],
  ['AWS quoted assignment', 'AWS_SECRET_ACCESS_KEY="fixture Aws Secret" next=ok', ['fixture Aws Secret']],
  ['prefixed API key', 'TYPESAFE_API_KEY=fixtureTypesafeKey next=ok', ['fixtureTypesafeKey']],
  ['access token', 'access_token="fixtureAccessToken" next=ok', ['fixtureAccessToken']],
  ['client secret', 'client_secret=fixtureClientSecret next=ok', ['fixtureClientSecret']],
  ['GitHub token', `credential ${github} done`, [github]],
  ['Slack token', `credential ${slack} done`, [slack]],
  ['AWS access key', `credential ${aws} done`, [aws]],
  ['JWT', `credential ${jwt} done`, [jwt]],
  ['URL credentials', 'https://fixtureUser:fixturePass@example.test/path?ok=2', ['fixtureUser', 'fixturePass']],
  [
    'URL escaped credentials',
    'postgres://fixture%40user:fixture%3Apass@example.test/db',
    ['fixture%40user', 'fixture%3Apass'],
  ],
  ['Basic authorization', 'Authorization: Basic Zml4dHVyZTpwYXNz\r\nNext: keep', ['Zml4dHVyZTpwYXNz']],
  ['Bearer authorization', 'Authorization: Bearer fixtureBearer\r\nNext: keep', ['fixtureBearer']],
  [
    'Cookie header',
    'Cookie: sid=fixtureSession; preference=fixturePreference\r\nNext: keep',
    ['fixtureSession', 'fixturePreference'],
  ],
  ['Set-Cookie header', 'Set-Cookie: sid=fixtureSession; HttpOnly\r\nNext: keep', ['fixtureSession']],
  ['JSON authorization', '{"Authorization": "Basic Zml4dHVyZTpwYXNz", "ok": 2}', ['Zml4dHVyZTpwYXNz']],
  [
    'Python cookie',
    "{'Cookie': 'sid=fixtureSession; other=fixturePreference', 'ok': 2}",
    ['fixtureSession', 'fixturePreference'],
  ],
  [
    'PEM block',
    'before\n-----BEGIN PRIVATE KEY-----\nfixturePrivateMaterial\n-----END PRIVATE KEY-----\nafter',
    ['fixturePrivateMaterial'],
  ],
  ['truncated PEM', 'before\n-----BEGIN PRIVATE KEY-----\nfixtureTruncatedMaterial', ['fixtureTruncatedMaterial']],
] as const;

for (const [label, source, secrets] of cases) {
  test(`M2 free-text redaction: ${label}`, () => {
    const clean = redact(source) as string;
    assert.ok(clean.includes('[REDACTED]'));
    for (const secret of secrets) assert.equal(clean.includes(secret), false, `leaked ${label}`);
    assert.equal(redact(clean), clean, 'sanitizing on reload/export must be idempotent');
    if (source.includes('Next: keep')) assert.ok(clean.endsWith('\r\nNext: keep'));
  });
}

test('M2 quoted values preserve JSON structure and adjacent ordinary values', () => {
  const source = JSON.stringify({password: 'first"second', token: 'third\\fourth', count: 2, summary: 'keep'});
  assert.deepEqual(JSON.parse(redact(source) as string), {
    password: '[REDACTED]',
    token: '[REDACTED]',
    count: 2,
    summary: 'keep',
  });
  assert.equal(redact("{'password': 'first\\'second', 'count': 2}"), "{'password': '[REDACTED]', 'count': 2}");
  const headers = JSON.stringify({
    Authorization: 'Basic Zml4dHVyZTpwYXNz',
    Cookie: 'sid=fixtureSession; other=fixturePreference',
    next: 'keep',
  });
  assert.deepEqual(JSON.parse(redact(headers) as string), {
    Authorization: 'Basic [REDACTED]',
    Cookie: '[REDACTED]',
    next: 'keep',
  });
});

for (const label of [
  'PRIVATE KEY',
  'RSA PRIVATE KEY',
  'EC PRIVATE KEY',
  'OPENSSH PRIVATE KEY',
  'ENCRYPTED PRIVATE KEY',
]) {
  test(`M2 removes the complete ${label} PEM block`, () => {
    const source = `before\r\n-----BEGIN ${label}-----\r\nfixturePrivateMaterial\r\nfixtureSecondLine\r\n-----END ${label}-----\r\nafter`;
    const clean = redact(source) as string;
    assert.equal(clean.includes('fixturePrivateMaterial'), false);
    assert.equal(clean.includes('fixtureSecondLine'), false);
    assert.ok(clean.startsWith('before\r\n'));
    assert.ok(clean.endsWith('\r\nafter'));
    assert.equal(redact(clean), clean);
  });
}

test('M2 ordinary prose, URLs, incomplete token lookalikes, numbers and null stay intact', () => {
  const value = {
    summary:
      '下一步 reset_password / read_env; token bucket; API key rotation; ghp_short xoxb-short AKIA123; release v1.2.3',
    link: 'https://example.test/path?ok=2',
    data: [null, 0, 0.75, true, false],
  };
  assert.deepEqual(redact(value), value);
  assert.equal(redact('Cookie:\r\nNext: keep'), 'Cookie:\r\nNext: keep');
  assert.equal(redact('Authorization:\r\nNext: keep'), 'Authorization:\r\nNext: keep');
});

test('M2 nested quoted cookie text preserves the surrounding JSON structure', () => {
  const source = JSON.stringify({summary: 'cookie: fixtureCookie', next: 'keep'});
  assert.deepEqual(JSON.parse(redact(source) as string), {summary: 'cookie: [REDACTED]', next: 'keep'});
});

test('M2 JWT signatures ending with base64url punctuation are replaced in full', () => {
  for (const suffix of ['-', '_']) {
    assert.equal(redact(`before ${jwt}${suffix} after`), 'before [REDACTED] after');
  }
});

function event(sequence: number, summary: string): MonitorEvent {
  return {
    schema_version: 1,
    event_id: `token/event-${sequence}`,
    run_id: 'secret/run',
    producer_id: 'password/producer',
    sequence,
    occurred_at: '2026-10-04T00:00:00.000Z',
    type: 'progress.updated',
    payload: {summary},
  };
}

test('M2 diagnostics remain opt-in; protocol IDs, dictionary names and numeric values survive', () => {
  const original = {
    ...event(1, `use ${github}`),
    payload: {
      summary: `use ${github}`,
      candidates: {reset_password: 'password="fixture candidate"', read_env: null},
      probabilities: {reset_password: 0.7, read_env: 0.3},
      legend: {api_key: `use ${slack}`},
      usage: {input_tokens: 123, secret: 0},
      diagnostic: {token: 'fixtureDiagnostic', nested: {note: `use ${jwt}`, count: 3}},
    },
  };
  const snapshot = structuredClone(original);
  const plain = sanitizeEvent(original);
  assert.equal('diagnostic' in plain.payload, false);
  const enabled = sanitizeEvent(original, true);
  assert.deepEqual(enabled.payload.diagnostic, {token: '[REDACTED]', nested: {note: 'use [REDACTED]', count: 3}});
  assert.deepEqual(enabled.payload.probabilities, original.payload.probabilities);
  assert.deepEqual(enabled.payload.usage, original.payload.usage);
  assert.deepEqual(enabled.payload.candidates, {reset_password: 'password="[REDACTED]"', read_env: null});
  assert.deepEqual(Object.keys(enabled.payload.legend), ['api_key']);
  const {payload: _payload, ...identity} = enabled;
  const {payload: _originalPayload, ...originalIdentity} = original;
  assert.deepEqual(identity, originalIdentity);
  assert.deepEqual(original, snapshot, 'caller event must not be mutated');
  assert.deepEqual(sanitizeEvent(enabled, true), enabled);
});

test('M2 accepted 4096-code-point summaries survive ingest, restart, export and replay', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-redact-m2-'));
  const stores: EventStore[] = [];
  t.after(() => {
    for (const store of stores) store.close();
    fs.rmSync(directory, {recursive: true, force: true});
  });
  const sources = cases.map(([, source]) => source as string);
  sources.push('token="a" ' + '😀'.repeat(4096 - 10));
  sources.push('Cookie: a\r\n' + 'x'.repeat(4096 - 11));
  const store = new EventStore(directory);
  stores.push(store);
  const rows = sources.map((summary, index) => event(index + 1, summary));
  for (const row of rows) assert.equal(store.ingest(row).accepted, true);
  store.close();
  const restored = new EventStore(directory);
  stores.push(restored);
  assert.equal(restored.corruptLines, 0);
  assert.equal(restored.events.length, rows.length);
  const exported = restored.exportLines();
  assert.equal(exported.skipped, 0);
  const replay = parseReplay(exported.text, {validateEvent, sanitizeEvent});
  assert.equal(replay.invalidLines, 0);
  assert.equal(replay.events.length, rows.length);
  assert.deepEqual(replay.events, restored.events);
  for (const row of replay.events) {
    assert.ok(Array.from(row.payload.summary!).length <= 4096);
    assert.doesNotThrow(() => {
      const {cursor: _cursor, received_at: _received, ...clean} = row;
      validateEvent(clean);
    });
  }
  const secrets = cases.flatMap(([, , secrets]) => [...secrets]);
  const disk = fs
    .readdirSync(directory)
    .map(file => fs.readFileSync(path.join(directory, file), 'utf8'))
    .join('\n');
  for (const secret of secrets) {
    assert.equal(disk.includes(secret), false, 'newly persisted rows must already be redacted');
    assert.equal(exported.text.includes(secret), false, 'export must never expose credentials');
  }
  assert.equal(Array.from(replay.events.at(-2)!.payload.summary!).length, 4096);
  assert.equal(redact(replay.events.at(-2)!.payload.summary), replay.events.at(-2)!.payload.summary);
});

test('M2 replay and restart sanitize previously written legacy secret rows', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-redact-legacy-'));
  const rows = cases.map(([, summary], index) => ({
    ...event(index + 1, summary),
    cursor: index + 1,
    received_at: '2026-10-04T00:00:00.000Z',
  }));
  const text = rows.map(row => JSON.stringify(row)).join('\r\n') + '\r\n';
  fs.writeFileSync(path.join(directory, 'events-00000001.jsonl'), text);
  const store = new EventStore(directory);
  t.after(() => {
    store.close();
    fs.rmSync(directory, {recursive: true, force: true});
  });
  assert.equal(store.corruptLines, 0);
  assert.equal(store.events.length, rows.length);
  const imported = parseReplay(text, {validateEvent, sanitizeEvent});
  assert.equal(imported.invalidLines, 0);
  assert.deepEqual(imported.events, store.events);
  const exported = store.exportLines();
  assert.equal(exported.skipped, 0);
  for (const [, , secrets] of cases) {
    for (const secret of secrets) {
      assert.equal(JSON.stringify(store.events).includes(secret), false);
      assert.equal(exported.text.includes(secret), false);
    }
  }
});

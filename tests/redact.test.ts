import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {redact} from '../src/redact';
import {EventStore} from '../src/store';

// Every secret below is fake. Each case keeps the text around the secret, so over-redaction shows up as a mismatch.
const cases: [string, string][] = [
  ['{"api_key": "abc123secretvalue", "n": 1}', '{"api_key": "[REDACTED]", "n": 1}'],
  ["{'password': 'hunter2 two words'}", "{'password': '[REDACTED]'}"],
  ['{\\"token\\": \\"abc def\\"}', '{\\"token\\": \\"[REDACTED]\\"}'],
  ['password = "a \\" b" rest', 'password = "[REDACTED]" rest'],
  ['AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY next', 'AWS_SECRET_ACCESS_KEY=[REDACTED] next'],
  ['client_secret: abcdef x-api-key=12345', 'client_secret: [REDACTED] x-api-key=[REDACTED]'],
  ['GET /cb?access_token=abc&state=1', 'GET /cb?access_token=[REDACTED]&state=1'],
  ['clone with ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa now', 'clone with [REDACTED] now'],
  ['pat github_pat_11AAAAAAA0aaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbb end', 'pat [REDACTED] end'],
  ['gitlab glpat-aaaaaaaaaaaaaaaaaaaa end', 'gitlab [REDACTED] end'],
  ['slack xoxb-1234567890-abcdefghijkl done', 'slack [REDACTED] done'],
  ['key id AKIAIOSFODNN7EXAMPLE used', 'key id [REDACTED] used'],
  ['google AIzaSyA-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa end', 'google [REDACTED] end'],
  [
    'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U ok',
    'jwt [REDACTED] ok',
  ],
  ['fetch https://admin:s3cretpw@db.example.com/x', 'fetch https://[REDACTED]@db.example.com/x'],
  ['Cookie: session=abc123; theme=dark\nnext', 'Cookie: [REDACTED]\nnext'],
  ['{"Set-Cookie": "id=a3f; Path=/", "x": 1}', '{"Set-Cookie": "[REDACTED]", "x": 1}'],
  ['Authorization: Basic dXNlcjpwYXNzd29yZA==', 'Authorization: Basic [REDACTED]'],
  ['{"Authorization": "Bearer abc.def", "x": 1}', '{"Authorization": "[REDACTED]", "x": 1}'],
  [
    'Authorization: Bearer abc.def and api_key=sk-1234567890abcdef',
    'Authorization: Bearer [REDACTED] and api_key=[REDACTED]',
  ],
  [
    'key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\nok',
    'key:\n[REDACTED]\nok',
  ],
  ['cut -----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA', 'cut [REDACTED]'],
];

const untouched = [
  'max_tokens=512, input tokens: 300, a basic check',
  'see https://example.com/a@b and mail me@example.com',
  'token budget is fine; the secret ingredient is salt',
  '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
  '下一步：拾取钥匙（key）',
];

test('free-text redaction covers quoted values, compound key names, known token formats, URLs, cookies and PEM', () => {
  for (const [input, expected] of cases) assert.equal(redact(input), expected, input);
  for (const text of untouched) assert.equal(redact(text), text);
});

test('redaction is idempotent, so restart and export show what the live view showed', () => {
  for (const [input] of cases) {
    const once = redact(input);
    assert.equal(redact(once), once, input);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-monitor-'));
  const store = new EventStore(dir);
  cases.forEach(([summary], i) =>
    store.ingest({
      schema_version: 1,
      event_id: `e${i}`,
      run_id: 'run-1',
      producer_id: 'host-1',
      sequence: i + 1,
      occurred_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      type: 'progress.updated',
      payload: {summary},
    }),
  );
  const live = store.events.map(e => e.payload.summary);
  assert.deepEqual(
    live,
    cases.map(([, expected]) => expected),
  );
  store.close();
  const restored = new EventStore(dir);
  assert.deepEqual(
    restored.events.map(e => e.payload.summary),
    live,
  );
  const exported = restored.exportLines();
  assert.equal(exported.skipped, 0);
  assert.deepEqual(
    exported.text
      .trim()
      .split('\n')
      .map(line => JSON.parse(line).payload.summary),
    live,
  );
  restored.close();
});

test('object keys that name credentials are redacted in diagnostics', () => {
  assert.deepEqual(redact({passwd: 'a', passphrase: 'b', aws_access_key_id: 'c', private_key: 'd', retries: 2}), {
    passwd: '[REDACTED]',
    passphrase: '[REDACTED]',
    aws_access_key_id: '[REDACTED]',
    private_key: '[REDACTED]',
    retries: 2,
  });
});

test('redaction stays linear on long adversarial text', () => {
  // A diagnostic string can fill most of a 64 KiB event.
  const fill = (unit: string) => unit.repeat(Math.ceil(65536 / unit.length)).slice(0, 65536);
  const inputs = [
    'a-',
    'token_a-',
    'token: "\\',
    'token=\\"a',
    'a://b',
    'eyJaaaaaaaaa.',
    'sk-a',
    'Bearer ',
    'cookie: ',
  ];
  for (const unit of inputs) {
    const started = performance.now();
    redact(fill(unit));
    // Linear patterns take a few ms here; an unbounded URL scheme took about 2 s on 'a-'.
    assert.ok(performance.now() - started < 250, unit);
  }
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import type {RunSummary} from '../src/ipc';
import {suggestedExportFileName} from '../src/main/export-name';
import {createMonitorHandlers, type IpcSender, type RendererContents} from '../src/main/ipc-api';
import {exportFileName} from '../src/replay';
import {emptyRun} from '../src/state';
import {EventStore} from '../src/store';

const now = new Date(2026, 9, 4, 12, 30, 0);
const labelRun = (name: string): RunSummary => ({...emptyRun('run-a'), name, started_at: now.toISOString()});
const generic = exportFileName(now);

test('filename suggestions use a bounded portable declared label and keep the generic fallback', () => {
  assert.equal(suggestedExportFileName(now, [labelRun('季度报告')]), generic.replace('.jsonl', '-季度报告.jsonl'));
  assert.equal(
    suggestedExportFileName(now, [labelRun('../报告\\草稿: final?\u0000')]),
    generic.replace('.jsonl', '-报告-草稿-final.jsonl'),
  );
  const long = suggestedExportFileName(now, [labelRun('报'.repeat(100))]);
  assert.equal(long, generic.replace('.jsonl', `-${'报'.repeat(32)}.jsonl`));
  for (const runs of [
    [],
    [emptyRun('token=secret-id')],
    [labelRun('run-a')],
    [labelRun('a'), labelRun('b')],
    [labelRun('...')],
  ]) {
    assert.equal(suggestedExportFileName(now, runs), generic);
  }
});

test('redaction runs before truncation and filename normalization cannot expose credentials', () => {
  const labels = [
    '季度报告 password="example secret"',
    'AWS_SECRET_ACCESS_KEY=EXAMPLESECRET',
    'Authorization: Basic ZXhhbXBsZTpleGFtcGxl',
    'Cookie: session=EXAMPLESESSION; other=EXAMPLECOOKIE',
    'ghp_0123456789abcdefghijklmnop',
    ['xoxb', '1234567890', 'abcdefghijklmno'].join('-'),
    'AKIA1234567890ABCDEF',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJleGFtcGxlIn0.signature',
    'https://example-user:example-password@example.invalid/path',
    '-----BEGIN PRIVATE KEY-----\nEXAMPLEKEY\n-----END PRIVATE KEY-----',
    '[REDACTED]',
    '[TRUNCATED]',
    `${'报告'.repeat(30)} token=EXAMPLESECRET`,
    'ｔｏｋｅｎ＝EXAMPLESECRET',
    'sk:0123456789abcdefghijklmnop',
  ];
  for (const name of labels) assert.equal(suggestedExportFileName(now, [labelRun(name)]), generic, name);
});

test('save dialog suggestions come from stored labels; cancellation never writes or changes history', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-export-name-'));
  const store = new EventStore(dir);
  const frame = {url: 'file:///renderer/index.html'};
  const contents: RendererContents = {mainFrame: frame};
  const event: IpcSender = {sender: contents, senderFrame: frame};
  const handlers = createMonitorHandlers({
    store,
    rendererUrl: frame.url,
    contents,
    controller: {setMode: mode => mode, setPinned: pinned => pinned},
    getStatus: () => {
      throw new Error('unused');
    },
  });
  let sequence = 0;
  const started = (name?: string) => {
    sequence += 1;
    assert.equal(
      store.ingest({
        schema_version: 1,
        event_id: `e-${sequence}`,
        run_id: 'secret-run-id',
        producer_id: 'host',
        sequence,
        occurred_at: new Date(now.getTime() + sequence * 1000).toISOString(),
        type: 'run.started',
        payload: name ? {name} : {},
      }).accepted,
      true,
    );
  };
  let suggestion = '';
  let saved = '';
  const files = {
    saveDialog: async (name: string) => {
      suggestion = name;
      return undefined;
    },
    openDialog: async () => undefined,
    readBounded: () => ({ok: true as const, text: ''}),
    write: (_file: string, text: string) => {
      saved = text;
    },
  };
  try {
    started();
    await handlers.exportEvents(event, files);
    assert.match(suggestion, /^jev-monitor-export-\d{8}-\d{6}\.jsonl$/);
    assert.equal(suggestion.includes('secret-run-id'), false);
    started('季度报告');
    const before = structuredClone(store.snapshot('secret-run-id'));
    assert.deepEqual(await handlers.exportEvents(event, files), {saved: false});
    assert.match(suggestion, /^jev-monitor-export-\d{8}-\d{6}-季度报告\.jsonl$/);
    assert.equal(saved, '');
    assert.deepEqual(structuredClone(store.snapshot('secret-run-id')), before);
    started('季度报告 token=EXAMPLESECRET');
    await handlers.exportEvents(event, files);
    assert.match(suggestion, /^jev-monitor-export-\d{8}-\d{6}\.jsonl$/);
    assert.equal(suggestion.includes('EXAMPLESECRET'), false);
    started('季度报告');
    const result = await handlers.exportEvents(event, {
      ...files,
      saveDialog: async name => {
        suggestion = name;
        return path.join(dir, 'export.jsonl');
      },
    });
    assert.equal(result.saved, true);
    assert.equal(saved, store.exportLines().text);
    assert.equal(result.bytes, Buffer.byteLength(saved));
  } finally {
    store.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

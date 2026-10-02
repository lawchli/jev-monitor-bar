import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {StoredEvent} from '../src/protocol';
import {timelineItems, laterAttemptKeys} from '../src/renderer/expanded/model';
import {searchTimelineItems, searchTimelineItemsAsync} from '../src/renderer/expanded/search';
import {EventStore} from '../src/store';

function stored(cursor: number, reason: string): StoredEvent {
  return {
    schema_version: 1,
    event_id: `event-${cursor}`,
    run_id: 'reports',
    producer_id: 'host',
    sequence: cursor,
    occurred_at: '2026-10-03T09:00:00.000Z',
    type: 'action.failed',
    payload: {reason},
    received_at: '2026-10-03T09:00:00.100Z',
    cursor,
    action_id: 'write-report',
    attempt_id: `try-${cursor}`,
  };
}

test('local search ANDs terms, ignores case, and normalizes full-width characters', () => {
  const items = timelineItems([stored(1, 'Timeout 写入失败'), stored(2, 'timeout 等待其他任务')], 'all');
  assert.deepEqual(
    searchTimelineItems(items, 'ＴＩＭＥＯＵＴ 写入').map(item => item.cursor),
    [1],
  );
  assert.deepEqual(
    searchTimelineItems(items, '  timeout\n\t写入失败 ').map(item => item.cursor),
    [1],
  );
  assert.deepEqual(
    searchTimelineItems(items, ' timeout ').map(item => item.cursor),
    [1, 2],
  );
});

test('search covers Chinese event labels, event fields, dates and nested payload values', () => {
  const items = timelineItems([stored(1, '输出 <report>.txt'), stored(2, 'disk full')], 'all');
  assert.equal(searchTimelineItems(items, '执行失败 report>.txt').length, 1);
  assert.equal(searchTimelineItems(items, 'try-2 2026-10-03 write-report').length, 1);
  assert.equal(searchTimelineItems(items, '不存在').length, 0);
});

test('search is literal rather than regex, only observes redacted data, and never mutates events', () => {
  const events = [stored(1, 'value [REDACTED] a.*b'), stored(2, 'other value')];
  const before = structuredClone(events);
  const items = timelineItems(events, 'all');
  assert.deepEqual(
    searchTimelineItems(items, 'a.*b').map(item => item.cursor),
    [1],
  );
  assert.equal(searchTimelineItems(items, '.*').length, 1);
  assert.equal(searchTimelineItems(items, 'real-secret-not-in-redacted-record').length, 0);
  assert.equal(searchTimelineItems(items, '[redacted]').length, 1);
  assert.deepEqual(events, before);
});

test('blank search preserves the category filter and ordering without changing the input array', () => {
  const items = timelineItems([stored(4, 'fourth'), stored(2, 'second')], 'errors');
  assert.deepEqual(searchTimelineItems(items, ' \t '), items);
  assert.notEqual(searchTimelineItems(items, ''), items);
  assert.deepEqual(
    searchTimelineItems(items, 'reports').map(item => item.cursor),
    [2, 4],
  );
});

test('async search agrees with literal synchronous search across yields and cached queries', async () => {
  const items = timelineItems(
    Array.from({length: 300}, (_, index) => stored(index + 1, index % 2 ? 'report timeout' : 'other')),
    'all',
  );
  let yields = 0;
  const options = {
    budgetMs: 0,
    yieldControl: async () => {
      yields++;
    },
  };
  for (const query of ['REPORT timeout', 'missing', '', 'report']) {
    assert.deepEqual(await searchTimelineItemsAsync(items, query, options), searchTimelineItems(items, query));
  }
  assert.ok(yields >= 299);
});

test('async search cancels before scanning and after a yield without publishing stale results', async () => {
  const items = timelineItems([stored(1, 'old query'), stored(2, 'new query')], 'all');
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(searchTimelineItemsAsync(items, 'old', {signal: aborted.signal}), {name: 'AbortError'});
  const controller = new AbortController();
  let resume: () => void = () => {};
  let yielded: () => void = () => {};
  const scheduled = new Promise<void>(resolve => {
    yielded = resolve;
  });
  const pending = searchTimelineItemsAsync(items, 'old', {
    signal: controller.signal,
    budgetMs: 0,
    yieldControl: () => {
      yielded();
      return new Promise<void>(resolve => {
        resume = resolve;
      });
    },
  });
  await scheduled;
  controller.abort();
  resume();
  await assert.rejects(pending, {name: 'AbortError'});
  assert.deepEqual(
    (await searchTimelineItemsAsync(items, 'new')).map(item => item.cursor),
    [2],
  );
});

test('bounded run hints cannot hide retries present in loaded historical events', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-history-retry-'));
  const store = new EventStore(directory);
  try {
    let sequence = 0;
    const emit = (action_id: string, attempt_id: string) => {
      sequence++;
      assert.equal(
        store.ingest({
          schema_version: 1,
          event_id: `e-${sequence}`,
          run_id: 'run-a',
          producer_id: 'host',
          sequence,
          occurred_at: '2026-10-03T00:00:00.000Z',
          type: 'action.started',
          payload: {},
          action_id,
          attempt_id,
        }).accepted,
        true,
      );
    };
    emit('old-action', 'first');
    emit('old-action', 'retry');
    for (let index = 0; index < 501; index++) emit(`new-action-${index}`, 'first');
    const run = store.runs.get('run-a');
    assert.ok(run);
    assert.equal(Object.keys(run.attempts).length, 500);
    assert.equal(laterAttemptKeys(run).size, 0);
    assert.deepEqual(
      timelineItems(store.events, 'errors', laterAttemptKeys(run)).map(item => item.cursor),
      [2],
    );
  } finally {
    store.close();
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

test('explicit retry numbers supplement a loaded page whose first attempt is absent', () => {
  const retry = {
    ...stored(8, 'retry'),
    type: 'action.selected' as const,
    payload: {action: 'write', source: 'application' as const, retry: 1},
  };
  const unrelated = {...stored(9, 'new action'), action_id: 'other-action', attempt_id: 'first'};
  assert.deepEqual(
    timelineItems([retry, unrelated], 'errors', new Set()).map(item => item.cursor),
    [8, 9],
  );
  unrelated.type = 'action.started';
  unrelated.payload = {};
  assert.deepEqual(
    timelineItems([retry, unrelated], 'errors', new Set()).map(item => item.cursor),
    [8],
  );
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  NOT_PROVIDED,
  UNKNOWN,
  connectionState,
  formatClock,
  formatDuration,
  pickDefaultRun,
  statusText,
  statusTone,
  truncate,
} from '../src/renderer/view-model/common';

const now = Date.parse('2026-01-01T00:00:30.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

test('status text and tone follow the shared labels', () => {
  assert.equal(UNKNOWN, '未知');
  assert.equal(NOT_PROVIDED, '未提供');
  assert.equal(statusText('completed'), '任务结束');
  assert.equal(statusText('not-a-status'), UNKNOWN);
  for (const status of ['waiting', 'unknown', 'cancelled']) assert.equal(statusTone(status), 'neutral');
  for (const status of ['evaluating', 'selected', 'executing']) assert.equal(statusTone(status), 'active');
  assert.equal(statusTone('unverified'), 'warning');
  for (const status of ['passed', 'completed']) assert.equal(statusTone(status), 'success');
  for (const status of ['failed', 'verification_failed']) assert.equal(statusTone(status), 'danger');
  assert.equal(statusTone('other'), 'neutral');
});

test('formatClock uses local hours and formatDuration uses the compact units', () => {
  const date = new Date('2026-01-01T15:04:05.000Z');
  const pad = (value: number) => String(value).padStart(2, '0');
  assert.equal(
    formatClock(date.toISOString()),
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
  );
  assert.equal(formatDuration(0), '0秒');
  assert.equal(formatDuration(999), '0秒');
  assert.equal(formatDuration(12_000), '12秒');
  assert.equal(formatDuration(60_000), '1分00秒');
  assert.equal(formatDuration(3 * 60_000 + 5_000), '3分05秒');
  assert.equal(formatDuration(59 * 60_000 + 59_000), '59分59秒');
  assert.equal(formatDuration(3_600_000), '1时00分');
  assert.equal(formatDuration(3_600_000 + 2 * 60_000 + 9_000), '1时02分');
});

test('connectionState distinguishes ended, live, quiet, and stale', () => {
  assert.deepEqual(connectionState({ended_at: iso(now), last_received: iso(now)}, now), {
    kind: 'ended',
    text: '已结束',
  });
  assert.deepEqual(connectionState({last_received: iso(now - 10_000)}, now), {kind: 'live', text: '在线'});
  assert.deepEqual(connectionState({last_received: iso(now - 10_001)}, now), {kind: 'quiet', text: '10 秒无新事件'});
  assert.deepEqual(connectionState({last_received: iso(now - 30_000)}, now), {kind: 'quiet', text: '30 秒无新事件'});
  const staleAt = iso(now - 30_001);
  assert.deepEqual(connectionState({last_received: staleAt}, now), {
    kind: 'stale',
    text: `可能断开 · 最后更新 ${formatClock(staleAt)}`,
  });
});

test('truncate adds an ellipsis only past the limit', () => {
  assert.equal(truncate('hello', 5), 'hello');
  assert.equal(truncate('hello', 4), 'hell…');
  assert.equal(truncate('', 0), '');
});

test('pickDefaultRun prefers the newest open run', () => {
  assert.equal(pickDefaultRun([]), undefined);
  const endedNewer = {id: 'ended', last_received: '2026-01-01T00:00:09.000Z', ended_at: '2026-01-01T00:00:09.000Z'};
  const openOlder = {id: 'open-old', last_received: '2026-01-01T00:00:01.000Z'};
  const openNewer = {id: 'open-new', last_received: '2026-01-01T00:00:04.000Z'};
  assert.equal(pickDefaultRun([endedNewer, openOlder, openNewer])?.id, 'open-new');
  assert.equal(
    pickDefaultRun([
      {id: 'a', last_received: '2026-01-01T00:00:01.000Z', ended_at: '2026-01-01T00:00:02.000Z'},
      {id: 'b', last_received: '2026-01-01T00:00:08.000Z', ended_at: '2026-01-01T00:00:09.000Z'},
    ])?.id,
    'b',
  );
});

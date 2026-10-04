import assert from 'node:assert/strict';
import {test} from 'node:test';
import {armQuit} from '../src/main/lifecycle';

const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

test('a synchronous cleanup failure is reported and shutdown still quits once', async () => {
  const failure = new Error('cleanup threw synchronously');
  const closing = {current: false};
  const errors: unknown[] = [];
  let prevented = 0;
  let closes = 0;
  let quits = 0;
  const event = {preventDefault: () => prevented++};
  const close = () => {
    closes++;
    throw failure;
  };
  const quit = () => {
    quits++;
    // Electron emits before-quit again when app.quit is called after cleanup.
    armQuit(event, closing, close, quit, error => errors.push(error));
  };
  assert.doesNotThrow(() => armQuit(event, closing, close, quit, error => errors.push(error)));
  assert.equal(closes, 1);
  assert.equal(prevented, 1);
  assert.equal(closing.current, true);
  assert.equal(quits, 0);
  await nextTurn();
  assert.deepEqual(errors, [failure]);
  assert.equal(quits, 1);
  assert.equal(closes, 1);
  assert.equal(prevented, 1);
});

test('an asynchronous cleanup rejection uses the same error and quit path', async () => {
  const failure = new Error('cleanup rejected');
  const errors: unknown[] = [];
  let quits = 0;
  armQuit(
    {preventDefault() {}},
    {current: false},
    () => Promise.reject(failure),
    () => {
      quits++;
    },
    error => errors.push(error),
  );
  await nextTurn();
  assert.deepEqual(errors, [failure]);
  assert.equal(quits, 1);
});

test('a failing cleanup reporter still lets shutdown quit', async t => {
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (message: string) => warnings.push(message));
  let quits = 0;
  armQuit(
    {preventDefault() {}},
    {current: false},
    () => {
      throw new Error('close failure');
    },
    () => {
      quits++;
    },
    () => {
      throw new Error('reporter failure');
    },
  );
  await nextTurn();
  assert.equal(quits, 1);
  assert.deepEqual(warnings, ['jev-monitor: session cleanup reporter failed: reporter failure']);
});

test('cleanup starts immediately and reentrant quit events cannot start it twice', async () => {
  const closing = {current: false};
  let prevented = 0;
  let closes = 0;
  let quits = 0;
  let release = () => {};
  const event = {preventDefault: () => prevented++};
  const quit = () => quits++;
  const close = () => {
    closes++;
    armQuit(event, closing, close, quit);
    return new Promise<void>(resolve => {
      release = resolve;
    });
  };
  armQuit(event, closing, close, quit);
  assert.equal(closes, 1);
  assert.equal(prevented, 1);
  assert.equal(quits, 0);
  armQuit(event, closing, close, quit);
  assert.equal(closes, 1);
  release();
  await nextTurn();
  assert.equal(quits, 1);
  armQuit(event, closing, close, quit);
  assert.equal(closes, 1);
  assert.equal(quits, 1);
});

test('a synchronous cleanup failure without a reporter still quits', async () => {
  let quits = 0;
  armQuit(
    {preventDefault() {}},
    {current: false},
    () => {
      throw 'cleanup failure';
    },
    () => {
      quits++;
    },
  );
  await nextTurn();
  assert.equal(quits, 1);
});

test('a quit without a receiver leaves the normal quit event untouched', () => {
  const closing = {current: false};
  armQuit(
    {
      preventDefault() {
        assert.fail('there is no receiver to close');
      },
    },
    closing,
    undefined,
    () => assert.fail('the caller already initiated normal quit'),
    () => assert.fail('there was no cleanup failure'),
  );
  assert.equal(closing.current, false);
});

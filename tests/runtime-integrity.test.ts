import assert from 'node:assert/strict';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import {harmlessMainTamper, integrityRejected, supportsAsarIntegrity} from '../scripts/runtime-integrity.mjs';

test('ASAR tamper probe changes only a comment and preserves valid JavaScript behavior', () => {
  const original = Buffer.from('"use strict";\n// src/main/index.ts\nglobalThis.result = 41 + 1;\n');
  const tamper = harmlessMainTamper(original);
  const changed = Buffer.from(original);
  changed[tamper.offset] = tamper.after;
  assert.equal(changed.length, original.length);
  assert.equal(changed[tamper.offset], 'S'.charCodeAt(0));
  const before: {result?: number} = {};
  const after: {result?: number} = {};
  runInNewContext(original.toString(), before);
  runInNewContext(changed.toString(), after);
  assert.equal(before.result, 42);
  assert.equal(after.result, before.result);
  assert.throws(() => harmlessMainTamper(Buffer.from('globalThis.result = 42;')), /source comment/);
});

test('runtime integrity evidence excludes syntax errors and unrelated startup failures', () => {
  const exited = {code: 1};
  assert.equal(integrityRejected({exited, started: false, output: 'SyntaxError: Invalid or unexpected token'}), false);
  assert.equal(integrityRejected({exited, started: false, output: 'Missing display or permissions'}), false);
  assert.equal(integrityRejected({exited, started: false, output: 'Integrity check failed for asar archive'}), true);
  assert.equal(integrityRejected({exited, started: true, output: 'Integrity check failed'}), false);
  assert.equal(integrityRejected({exited: null, started: false, output: 'Integrity check failed'}), false);
  assert.equal(supportsAsarIntegrity('linux'), false);
  assert.equal(supportsAsarIntegrity('win32'), true);
  assert.equal(supportsAsarIntegrity('darwin'), true);
});

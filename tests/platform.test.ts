import {test} from 'node:test';
import assert from 'node:assert/strict';
import {detectPlatform, platformProfile, type WindowBehavior} from '../src/main/platform';

const WAYLAND_NOTE = 'Wayland：多数合成器不允许应用置顶或自行定位窗口，本窗口可能被遮挡，位置也可能无法恢复。';

function expectProfile(behavior: WindowBehavior, workspaces: boolean) {
  assert.equal(behavior.alwaysOnTopLevel, 'floating');
  assert.equal(behavior.visibleOnAllWorkspaces, workspaces);
  assert.equal(behavior.visibleOnFullScreen, workspaces);
  assert.equal(behavior.showInactive, true);
}

test('win32 x64 is tier 1 and does not span workspaces', () => {
  const info = detectPlatform('win32', 'x64', {});
  assert.deepEqual(info, {os: 'windows', arch: 'x64', tier: 1, alwaysOnTopSupported: true, notes: []});
  expectProfile(platformProfile(info), false);
});

test('win32 arm64 is tier 2', () => {
  const info = detectPlatform('win32', 'arm64', {});
  assert.deepEqual(info, {os: 'windows', arch: 'arm64', tier: 2, alwaysOnTopSupported: true, notes: []});
  expectProfile(platformProfile(info), false);
});

test('darwin is tier 2 and visible on all workspaces including fullscreen', () => {
  const info = detectPlatform('darwin', 'arm64', {});
  assert.deepEqual(info, {os: 'macos', arch: 'arm64', tier: 2, alwaysOnTopSupported: true, notes: []});
  expectProfile(platformProfile(info), true);
});

test('linux without a Wayland session is X11 tier 2', () => {
  const info = detectPlatform('linux', 'x64', {XDG_SESSION_TYPE: 'x11'});
  assert.deepEqual(info, {os: 'linux-x11', arch: 'x64', tier: 2, alwaysOnTopSupported: true, notes: []});
  expectProfile(platformProfile(info), false);
});

test('linux XDG_SESSION_TYPE=wayland is tier 3 and not always-on-top capable', () => {
  const info = detectPlatform('linux', 'x64', {XDG_SESSION_TYPE: 'wayland'});
  assert.deepEqual(info, {
    os: 'linux-wayland',
    arch: 'x64',
    tier: 3,
    alwaysOnTopSupported: false,
    notes: [WAYLAND_NOTE],
  });
  expectProfile(platformProfile(info), false);
});

test('linux WAYLAND_DISPLAY alone marks the session as Wayland', () => {
  const info = detectPlatform('linux', 'x64', {XDG_SESSION_TYPE: 'tty', WAYLAND_DISPLAY: 'wayland-0'});
  assert.equal(info.os, 'linux-wayland');
  assert.equal(info.tier, 3);
  assert.equal(info.alwaysOnTopSupported, false);
  assert.deepEqual(info.notes, [WAYLAND_NOTE]);
  expectProfile(platformProfile(info), false);
});

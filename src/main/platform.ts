import type {PlatformInfo} from '../ipc';

const WAYLAND_NOTE = 'Wayland：多数合成器不允许应用置顶或自行定位窗口，本窗口可能被遮挡，位置也可能无法恢复。';

export function detectPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  env: NodeJS.ProcessEnv = process.env,
): PlatformInfo {
  // Windows：未实机验证
  if (platform === 'win32') {
    return {os: 'windows', arch, tier: arch === 'x64' ? 1 : 2, alwaysOnTopSupported: true, notes: []};
  }
  // macOS：未实机验证
  if (platform === 'darwin') {
    return {os: 'macos', arch, tier: 2, alwaysOnTopSupported: true, notes: []};
  }
  // Linux：未实机验证
  if (platform === 'linux') {
    const wayland = env.XDG_SESSION_TYPE === 'wayland' || Boolean(env.WAYLAND_DISPLAY);
    if (wayland) {
      return {os: 'linux-wayland', arch, tier: 3, alwaysOnTopSupported: false, notes: [WAYLAND_NOTE]};
    }
    return {os: 'linux-x11', arch, tier: 2, alwaysOnTopSupported: true, notes: []};
  }
  // 其他平台：未实机验证
  return {os: 'other', arch, tier: 3, alwaysOnTopSupported: false, notes: ['未适配的平台']};
}

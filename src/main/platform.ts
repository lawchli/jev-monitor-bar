import type {PlatformInfo} from '../ipc';

const WAYLAND_NOTE = 'Wayland：多数合成器不允许应用置顶或自行定位窗口，本窗口可能被遮挡，位置也可能无法恢复。';

export interface WindowBehavior {
  alwaysOnTopLevel: 'floating';
  visibleOnAllWorkspaces: boolean;
  visibleOnFullScreen: boolean;
  showInactive: true;
}

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
  // Linux：X11 与 Wayland 分开。Wayland 未实机验证。
  if (platform === 'linux') {
    const wayland = env.XDG_SESSION_TYPE === 'wayland' || Boolean(env.WAYLAND_DISPLAY);
    if (wayland) {
      // Linux Wayland：未实机验证
      return {os: 'linux-wayland', arch, tier: 3, alwaysOnTopSupported: false, notes: [WAYLAND_NOTE]};
    }
    // Linux X11：置顶与不抢焦点已在 Linux VM 验证（2026-09-22）。位置恢复不在这句里记为已验证。
    return {os: 'linux-x11', arch, tier: 2, alwaysOnTopSupported: true, notes: []};
  }
  // 其他平台：未实机验证
  return {os: 'other', arch, tier: 3, alwaysOnTopSupported: false, notes: ['未适配的平台']};
}

function behavior(visibleOnAllWorkspaces: boolean): WindowBehavior {
  return {
    alwaysOnTopLevel: 'floating',
    visibleOnAllWorkspaces,
    visibleOnFullScreen: visibleOnAllWorkspaces,
    showInactive: true,
  };
}

/** How the shell should ask the OS to keep the window visible. Call sites stay platform-free. */
export function platformProfile(info: PlatformInfo): WindowBehavior {
  // macOS：未实机验证。Spaces 与全屏之上可见只在这里打开。
  if (info.os === 'macos') return behavior(true);
  // Windows：未实机验证
  if (info.os === 'windows') return behavior(false);
  // Linux X11：置顶与不抢焦点已在 Linux VM 验证（2026-09-22）。不跨工作区。
  if (info.os === 'linux-x11') return behavior(false);
  // Linux Wayland：未实机验证。仍按置顶调用，限制说明在 detectPlatform 的 notes 里。
  if (info.os === 'linux-wayland') return behavior(false);
  // 其他平台：未实机验证
  return behavior(false);
}

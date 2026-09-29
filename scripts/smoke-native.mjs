// 冒烟测试的系统层探针（--native）。只在测试进程里运行，应用本身不调用这些命令。
// macOS：osascript 的 JavaScript for Automation 读前台应用（NSWorkspace）与窗口层级（CGWindowList），
//   不需要辅助功能或屏幕录制权限，也不会弹授权提示（不读窗口标题，不截屏）。
// Windows：PowerShell 调 user32 的 GetForegroundWindow 与 GetWindowLongPtr(GWL_EXSTYLE) 读前台进程与 WS_EX_TOPMOST。
//   这段 Windows 代码尚未在 Windows 实机运行过。
// 其他平台暂未实现。
import {execFile} from 'node:child_process';
import {analyzeWindowStack} from './smoke-lib.mjs';

function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {timeout: 30_000, windowsHide: true, ...options}, (error, stdout, stderr) => {
      if (error) reject(new Error(`${error.message}${stderr ? `\n${stderr}` : ''}`));
      else resolve(stdout.trim());
    });
  });
}

const osascript = source => run('osascript', ['-l', 'JavaScript', '-e', source]);

const macFrontmost = `
ObjC.import('AppKit');
const app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
JSON.stringify({name: app.localizedName.js, pid: app.processIdentifier, bundleId: app.bundleIdentifier.js});
`;

const macWindows = `
ObjC.import('CoreGraphics');
ObjC.import('Foundation');
const list = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID);
const rows = ObjC.deepUnwrap(ObjC.castRefToObject(list)) || [];
JSON.stringify(rows.map(w => ({
  owner: w.kCGWindowOwnerName,
  pid: w.kCGWindowOwnerPID,
  layer: w.kCGWindowLayer,
  bounds: {x: w.kCGWindowBounds.X, y: w.kCGWindowBounds.Y, width: w.kCGWindowBounds.Width, height: w.kCGWindowBounds.Height},
})));
`;

const macScreenCapture = `
ObjC.import('CoreGraphics');
ObjC.bindFunction('CGPreflightScreenCaptureAccess', ['bool', []]);
String($.CGPreflightScreenCaptureAccess());
`;

const windowsProbe = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class JevSmokeWin32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int index);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
}
'@
$foreground = [JevSmokeWin32]::GetForegroundWindow()
[uint32]$foregroundPid = 0
[void][JevSmokeWin32]::GetWindowThreadProcessId($foreground, [ref]$foregroundPid)
$name = ''
try { $name = (Get-Process -Id $foregroundPid -ErrorAction Stop).ProcessName } catch {}
$result = [ordered]@{ frontmost = [ordered]@{ pid = [int64]$foregroundPid; name = $name; hwnd = [string]$foreground.ToInt64() } }
if ($env:JEV_SMOKE_HWND) {
  $hwnd = [IntPtr]::new([int64]$env:JEV_SMOKE_HWND)
  $exStyle = ([JevSmokeWin32]::GetWindowLongPtr($hwnd, -20)).ToInt64()
  $result['window'] = [ordered]@{ hwnd = $env:JEV_SMOKE_HWND; topmost = (($exStyle -band 0x8) -ne 0); visible = [JevSmokeWin32]::IsWindowVisible($hwnd) }
}
$result | ConvertTo-Json -Compress -Depth 4
`;

async function windowsSnapshot(hwnd) {
  const encoded = Buffer.from(windowsProbe, 'utf16le').toString('base64');
  const env = {...process.env};
  if (hwnd) env.JEV_SMOKE_HWND = hwnd;
  else delete env.JEV_SMOKE_HWND;
  const stdout = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    {env},
  );
  return JSON.parse(stdout);
}

export function nativeSupported(platform = process.platform) {
  return platform === 'darwin' || platform === 'win32';
}

/**
 * 统一的探针结果：frontmost {pid, name}；window {found, onTop, aboveOverlapping, raw}。
 * target.pid 为主进程 pid；Windows 另给 target.hwnd（十进制字符串）；macOS 用 target.expected 匹配窗口。
 */
export async function probe(target = {}, platform = process.platform) {
  if (platform === 'darwin') {
    const frontmost = JSON.parse(await osascript(macFrontmost));
    if (target.pid === undefined) return {frontmost};
    const stack = analyzeWindowStack(JSON.parse(await osascript(macWindows)), target.pid, target.expected);
    return {
      frontmost,
      window: {
        found: stack.found,
        onTop: stack.found ? stack.layer > 0 : undefined,
        aboveOverlapping: stack.aboveOverlapping,
        raw: stack,
      },
    };
  }
  if (platform === 'win32') {
    const snapshot = await windowsSnapshot(target.hwnd);
    if (!snapshot.window) return {frontmost: snapshot.frontmost};
    return {
      frontmost: snapshot.frontmost,
      window: {
        found: snapshot.window.visible === true,
        onTop: snapshot.window.topmost,
        aboveOverlapping: null,
        raw: snapshot.window,
      },
    };
  }
  throw new Error(`${platform} 暂未实现系统层探针`);
}

/** 只查询，不触发授权提示；非 macOS 返回 undefined。 */
export async function screenCaptureAllowed(platform = process.platform) {
  if (platform !== 'darwin') return undefined;
  return (await osascript(macScreenCapture)) === 'true';
}

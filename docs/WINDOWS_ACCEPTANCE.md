# Windows 实机验收

这份清单用于电脑打开后的复测。当前 Linux 验证不能替代这里的结果；每项记录执行日期、被测提交、Windows 版本与机器，不把跳过或不可观察记为通过。

先确认接收的 zip/提交与本轮交接记录一致，不覆盖开发电脑里已有的未提交或暂存改动。下面源码检查需要开发环境；「干净机器」只测试已打包程序，不要求先安装 Node/Python/pnpm。本轮是否已打出 Windows zip、SHA-256 与最终提交见 [`HANDOFF.md`](HANDOFF.md)，没有产物时不能把 Linux 包改名充当 Windows 包。

## 环境与自动检查

在可见、保持连接的 Windows 桌面会话里执行。远程桌面运行中断开会让前台窗口与整屏截图取证失效；前台进程为 Idle 或句柄为 0 时，不抢焦点测试不成立。

```powershell
git status --short
git rev-parse HEAD
Get-ComputerInfo | Select-Object WindowsProductName, WindowsVersion, OsBuildNumber
query session
node --version
pnpm --version
python --version

pnpm install --frozen-lockfile
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
python -m unittest discover -s python/tests -v
pnpm smoke --no-build --native

pnpm package
pnpm package:verify
pnpm package:runtime
pnpm smoke --no-build --native --app release/jev-monitor-bar-win32-x64/jev-monitor-bar.exe
pnpm loadtest --duration 30m --rate 25 --runtime node --no-probe
```

保留 `.runtime/smoke/win32-x64/report.json`、`.runtime/package-runtime/win32-x64/report.json`、负载目录里的报告和截图。发布包不能接主进程 inspector 时，导出/回放或窗口状态断言可能跳过；跳过项用源码 `pnpm smoke --native` 与下面的人工检查补齐。ASAR 篡改检查只修改合法注释，并要求明确的完整性失败证据，不能只根据程序退出判定通过。

源码 smoke 与发布包 smoke 使用相同报告路径，下一次执行会覆盖该目录；每轮运行结束先复制报告/截图到单独的取证目录再继续。只提交脱敏后的结果，不提交含 token 的 `session.json`、真实宿主事件或完整 `.runtime/`。测试运行器可以启动检查子进程，不代表监视器运行时会启动 PowerShell/cmd。

## 实际窗口

1. 先把记事本放在前台，再从另一个程序启动监视器。记录启动前后前台应用，确认焦点仍在记事本，而不是只确认监视器的 `isFocused` 为 false。
2. 让两个窗口重叠，分别打开/关闭置顶。截图显示两个窗口的实际前后关系；逐窗口 `PrintWindow` 图不替代整屏叠放截图。
3. 实际用鼠标拖动、缩放，切换紧凑与展开模式，关闭后重启，核对两种模式的位置和尺寸。
4. 在 100% / 200% 缩放及可用的混合 DPI 显示器上检查清晰度；移除外接显示器后重启，窗口应回到可见工作区。没有第二块显示器就记录未验证。
5. 演示应显示「模拟数据」。停止发送后检查无新事件/断开提示；恢复发送、重启监视器并更换会话凭证，宿主应重连。

## Defender

检查并记录当前状态；不替用户更改安全策略，也不向公开样本网站上传包。

```powershell
Get-MpComputerStatus | Select-Object AntivirusEnabled, RealTimeProtectionEnabled, AntivirusSignatureVersion, AntivirusSignatureLastUpdated
Get-FileHash release/jev-monitor-bar-0.1.0-win32-x64.zip -Algorithm SHA256
Start-MpScan -ScanType CustomScan -ScanPath (Join-Path $PWD 'release/jev-monitor-bar-win32-x64')
Get-MpThreatDetection
```

Defender 不可用、未启用或病毒库缺失时，这项仍是待办；不存在告警输出也不能替代成功完成扫描的记录。对检测结果只记录与当前包路径关联的条目，不把不相关旧告警算到本次包。

命令因策略/权限拒绝时保留原安全设置并记录阻断，不自动提权或关闭安全软件；由电脑所有者决定怎样启用/更新保护后复测。

## 干净机器

使用没有安装 Node.js、Python、额外运行时的干净 Windows 10/11 系统，解压已核对 SHA-256 的 zip，以普通用户启动 exe，不提升权限。检查窗口与本机事件接收，并记录 SmartScreen / UAC 的实际表现。

无需另装发送器运行时：普通 PowerShell 可以发送明确标为模拟的验收事件。先双击发布包 exe，等待它创建默认会话文件，再运行下列代码；如果启动前设置过 `JEV_MONITOR_HOME` / `JEV_MONITOR_SESSION`，将 `$jevSessionFile` 改为实际路径。不要打印 token。

```powershell
$jevSessionFile = Join-Path $env:LOCALAPPDATA 'jev-monitor-bar/session.json'
$jevSession = Get-Content -Raw $jevSessionFile | ConvertFrom-Json
$jevOrigin = [Uri]$jevSession.url
if ($jevOrigin.Scheme -ne 'http' -or $jevOrigin.Host -ne '127.0.0.1' -or $jevOrigin.UserInfo -or $jevOrigin.Query -or $jevOrigin.Fragment -or $jevOrigin.AbsolutePath -ne '/') { throw '拒绝非本机会话' }
$jevHeaders = @{ Authorization = "Bearer $($jevSession.token)" }
$jevRunId = "clean-check-$([Guid]::NewGuid().ToString('N'))"
$jevProducer = "powershell-$PID-$([Guid]::NewGuid().ToString('N'))"
$jevSteps = @(
    @{ type = 'run.started'; payload = @{ name = '模拟：干净机验收'; simulated = $true } },
    @{ type = 'progress.updated'; payload = @{ phase = '普通用户投递'; completed = 1; total = 1 } },
    @{ type = 'run.completed'; payload = @{} }
)
$jevSequence = 0
foreach ($jevStep in $jevSteps) {
    $jevSequence++
    $jevEvent = @{ schema_version = 1; event_id = [Guid]::NewGuid().ToString(); run_id = $jevRunId; producer_id = $jevProducer; sequence = $jevSequence; occurred_at = [DateTime]::UtcNow.ToString('o'); type = $jevStep.type; payload = $jevStep.payload }
    $jevBody = [Text.Encoding]::UTF8.GetBytes(($jevEvent | ConvertTo-Json -Depth 5 -Compress))
    Invoke-RestMethod -Uri ($jevOrigin.GetLeftPart([UriPartial]::Authority) + '/events') -Method Post -Headers $jevHeaders -ContentType 'application/json' -Body $jevBody -MaximumRedirection 0
}
```

三次响应应为 `accepted:true`，小窗列出「模拟：干净机验收」并结束。这只验证发布包接收和显示，不执行 TypeSafe/真实业务动作。

以上 PowerShell 示例是为待执行的 Windows 验收准备的步骤，本轮 Linux 文档检查没有执行它，不将预期响应记作实测结果。

已有 Node/Python 的开发电脑、只清空 PATH、GitHub Windows Server runner，都不能当作干净机器验收。签名证书与正式公开发布由仓库所有者决定；未提供证书的目录 zip 属于未签名包，本轮产物是否已生成见交接记录。

## 收尾记录

把实际结果和脱敏取证文件写入 `docs/reports/`，在 `docs/IMPLEMENTATION.md` 追加记录，再更新 README 的平台表。仍受环境限制的项保留待办，不宣称全部验收完成。

# JEV Monitor Bar

全平台、Windows 优先的只读决策监视小窗。宿主（运行 TypeSafe/JEV 的任务程序）发送摘要事件 → 本机鉴权接收 → 追加日志 → Electron/React 小窗。窗口里分开显示模型判断、应用选择、执行和验证，不控制宿主。此仓库独立于 `jev_zzz`。

> 状态（2026-09-30）：可以从源码运行。紧凑条、展开视图、时间线、导出与回放、Python 发送器和 `pnpm demo` 已在同一份代码里，审计 A1–A8 的修复已接入（实施记录 09、10、A8、11），并在 Linux X11 虚拟机上走过一次 `pnpm demo` 闭环（记录 11）。`pnpm package` 能打出未签名的目录 zip，`pnpm smoke` 在 macOS 上自动走完闭环验收并测了可见延迟（记录 18、19）。win32-x64 发布包在 Windows Server runner 上启动过，fuses 在运行时生效（记录 22、24）。30 分钟、45,000 条事件的合成负载在 macOS 上跑过（记录 23）。Windows 10/11 桌面实机、Defender 扫描和干净机器上解压即用还没做。进度以 [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md) 为准，已知问题见 [`docs/AUDIT.md`](docs/AUDIT.md)。

## 现在能做什么

- 紧凑条（默认 400×132，默认置顶，显示时不抢焦点）：任务名、「模拟数据」标记、连接状态（在线 / N 秒无新事件 / 可能断开 · 最后更新）、阶段 · 进度 · 运行时长、最新选择 → 实际动作（来源是模型、规则还是应用，是否覆盖）· 执行状态、最近事件。有多个运行时可以切换。按钮有「置顶」「展开」。
- 展开视图（默认 440×640），三个页签：
  - 决策：Choice、Score、Noul 各按自己的语义显示。请求没完成时概率写「未知」。confidence 写明「不是正确率」。说明只显示调用方提供的内容和来源，没有就写「未提供」。决策链把模型、规则或应用覆盖、执行、验证分开，例如「JEV 选择 A → 规则覆盖为 B（规则 X · 来源 Y） → 执行中 B」；只有选择时写「应用选择/待执行」。规则直接定下的动作标「规则决策」。
  - 执行：按动作分组显示每次尝试和验证检查项。验证计数写明分母，失败和未知单独列出，没验证的完成不算成功。
  - 时间线：默认跟随最新；向上滚动后暂停跟随，后台照常接收；一键回到最新；「仅错误与重试」筛选；发生时间与接收时间相差超过 5 秒标「迟到」；「加载更早」分页；点开一条事件看脱敏后的 JSON 纯文本。
- 导出与回放：导出为逐行校验、脱敏的 JSONL，跳过的损坏行会计数。回放打开 `.jsonl`（不超过 50 MiB，最多 20000 条），可以逐条、1× 或 10× 播放，不影响实时接收。
- 接收端：只监听 `127.0.0.1`，token 鉴权，单条事件上限 64 KiB，按 `event_id` 去重，序号冲突返回 409，写盘后才确认，重启后恢复。
- Python 发送器：Python 3.9+，只用标准库。有界队列、短超时、丢弃计数，不阻塞宿主。
- 窗口：两种模式各自记住位置和尺寸；显示器被移除时移回可见区域。
- `pnpm demo`：不需要 TypeSafe key，通过同一个 HTTP 接口播放 7 个标明「模拟」的场景。

## 安装与运行

需要 Node.js 22+ 和 pnpm 11（`package.json` 的 `packageManager` 为 `pnpm@11.19.0`，可以用 corepack 启用）。Python 发送器另需 Python 3.9+。

```bash
pnpm install   # 会下载 Electron 二进制
pnpm demo      # 构建并启动，循环播放 7 个模拟场景；数据在 .runtime/demo，启动前清空
pnpm start     # 构建并启动，等待真实宿主；数据在 .runtime/dev，或 JEV_MONITOR_HOME 指定的目录
```

`pnpm demo` 的 7 个场景是正常完成、概率分散、规则覆盖、失败后重试、验证失败、断线恢复、并发决策。关掉窗口就结束。

检查：

```bash
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
python -m unittest discover -s python/tests -v
pnpm smoke     # 用 Playwright 启动真实窗口，自动跑闭环验收、窗口断言和可见延迟；会在屏幕上开一个窗口
pnpm loadtest  # 合成负载，默认 30 分钟；--duration 60s 可以先跑一分钟
```

`pnpm loadtest` 在独立子进程里跑真实的接收端、存储、聚合与快照，经 HTTP 投递真实协议事件，报告写到 `.runtime/loadtest/<时间戳>-<运行时>/`；2026-09-30 的结果存档在 [`docs/reports/`](docs/reports/)。`pnpm smoke` 的报告、截图和导出文件在 `.runtime/smoke/<平台>-<架构>/`，任一断言失败时退出码非零。`--native` 另外读系统层的前台应用和窗口层级（macOS 不需要额外权限；Windows 版探针还没在 Windows 上跑过）。`--app <可执行文件或 .app>` 测打包后的程序：发布包关掉了 `--inspect`，这时只连渲染进程，读不到主进程窗口状态的断言和导出回放记为跳过。

只跑核心测试时可以设置 `ELECTRON_SKIP_BINARY_DOWNLOAD=1` 跳过 Electron 二进制下载，CI 就是这样做的。改了 `src/protocol.ts` 的 schema 后，用 `pnpm schema:export` 重新导出 `protocol/event.schema.json`。

## 接入宿主

宿主通过数据目录里的会话文件找到监视器，再把事件 POST 到本机接收端。Python 宿主最少这样：

```python
from jev_monitor import MonitorSender

with MonitorSender(host_name='my-host') as sender:
    sender.run_started('模拟：示例任务', simulated=True)  # 真实任务去掉 simulated
    sender.progress(phase='执行', completed=1, total=1)
    sender.run_completed()
```

- [`docs/INTEGRATION.md`](docs/INTEGRATION.md)：接入指南。会话文件与 token、Python 发送器、一次决策闭环的事件顺序、不要发送的内容、其他语言直接发 HTTP、时间与顺序的限制、不接 TypeSafe 怎么试。
- [`docs/PROTOCOL.md`](docs/PROTOCOL.md)：事件协议 v1 的完整规则。JSON Schema 在 [`protocol/event.schema.json`](protocol/event.schema.json)。
- [`python/README.md`](python/README.md)：Python 发送器的参数和测试。

从源码运行时，`pnpm start` 默认用仓库里的 `.runtime/dev`，不是下面的平台默认目录。宿主要设同一个 `JEV_MONITOR_HOME`（用绝对路径）。

## 平台支持

| 平台 | 级别 | 已验证 | 未验证 |
| --- | --- | --- | --- |
| Windows 10/11 x64 | Tier 1（优先） | GitHub Actions `windows-latest`：`format:check`、`typecheck`、`test`、`build`，以及 Python 3.9 / 3.13 测试通过（记录 13）。win32-x64 目录 zip 在 macOS 与 Windows runner 上打出并读回核对：fuses、版本资源、`asInvoker` 清单、asar 完整性、SHA-256（记录 18、20）。Windows Server 2025 runner 上 `pnpm smoke` 32 项通过，可见延迟 p95 87 ms；系统层探针确认窗口置顶、启动后不抢前台（记录 20） | Windows 10/11 桌面实机；在 Windows 上启动发布包（SmartScreen、无 UAC、fuses 与 asar 完整性是否生效）；拖动缩放、多显示器与混合 DPI；在 Windows 主机上打包与签名；Defender 扫描 |
| macOS | Tier 2 | `macos-latest` 上同一组 CI 通过（记录 13）。macOS 27 arm64 实机：脚本启动后前台应用不变、窗口未获得焦点；窗口层级 3（浮动层），在重叠的其他应用普通窗口之上，取消置顶后回到 0（记录 19）；`pnpm smoke` 37 项通过，可见延迟 p95 88 ms（记录 19）；darwin-arm64 发布包能启动并接收事件，`ELECTRON_RUN_AS_NODE`、`--inspect`、`NODE_OPTIONS` 不生效，改动 asar 后拒绝启动（记录 18） | 从 Finder 启动时是否抢前台；Spaces 与全屏应用之上是否可见；手动拖动缩放、多显示器；签名与公证 |
| Linux X11 | Tier 2 | Ubuntu 24.04.4 虚拟机（XFCE / xfwm4）：窗口带 `_NET_WM_STATE_ABOVE`，启动后焦点仍在原窗口（记录 P1-01、P1-04）；四轮重启后紧凑尺寸偏差不超过 1px（记录 P1-04 更正）；`pnpm demo` 闭环（记录 11）；`ubuntu-latest` CI | 多显示器、混合 DPI；打包 |
| Windows arm64 | Tier 2 | 无，CI 没有这个 runner | 全部 |
| Linux Wayland | Tier 3（尽力而为） | 无 | 全部。多数合成器不允许应用置顶或自行定位窗口，窗口里会显示这条提示 |

CI 通过只说明构建、纯函数和 DOM 测试通过，不等于原生窗口行为已验证。平台约束见 [`JEV_MONITOR_AGENT_PROMPT.md`](JEV_MONITOR_AGENT_PROMPT.md)「平台支持策略」。

## 数据目录与保留

默认数据目录：

- Windows：`%LOCALAPPDATA%\jev-monitor-bar\`
- macOS：`~/Library/Application Support/jev-monitor-bar/`
- Linux：`${XDG_STATE_HOME}/jev-monitor-bar/`（`XDG_STATE_HOME` 须为非空绝对路径），否则 `~/.local/state/jev-monitor-bar/`

`JEV_MONITOR_HOME` 覆盖整个目录，`JEV_MONITOR_SESSION` 单独覆盖会话文件。Windows 与 macOS 的默认目录还没有在对应系统上实机验收。

| 内容 | 位置 | 上限 |
| --- | --- | --- |
| 事件 | `events/events-NNNNNNNN.jsonl` | 每段不超过 4 MiB，只留最近 8 段（约 32 MiB）。每次启动新开一段，所以频繁重启会更快挤掉旧段 |
| 会话 | `session.json` | 每次启动重写，正常退出时删除 |
| 窗口状态 | `window-state.json` | 当前模式、置顶开关、两种模式各自的位置与尺寸、所在显示器与缩放 |
| Electron 配置 | `electron-profile/` | Electron 自己的缓存与配置 |

内存里只留最近 20000 条事件，并且序列化后不超过 32 MiB；去重也只在这个窗口里。最多保留 200 个运行，先淘汰已结束的。每个运行最多 500 个判断和 500 次尝试，超出时删掉最早的。时间线最多渲染 500 行，更早的用「加载更早」翻。

会话文件里有 token。POSIX 上以 0600 写入临时文件再改名覆盖，之后再 `chmod` 0600，已有文件也会被改回 0600。Windows 上 `mode` 不起作用，依赖用户目录（`%LOCALAPPDATA%`）本身的 ACL。

要清空数据，先关掉监视器，再删除数据目录。从源码运行的数据在 `.runtime/dev` 和 `.runtime/demo`，这两个目录不进 git。

## 打包与发布

```bash
pnpm package                                   # 默认 win32-x64
pnpm package --platform darwin --arch arm64    # 也支持 win32-arm64、darwin-x64、linux-x64、linux-arm64
pnpm package:verify [--platform p] [--arch a]  # 单独读回核对已打出的包
```

产物在 `release/`（不进 git）：

- `jev-monitor-bar-<platform>-<arch>/`：解压即用的目录。Windows 可执行文件固定叫 `jev-monitor-bar.exe`，macOS 为 `JEV Monitor Bar.app`。
- `jev-monitor-bar-<版本>-<platform>-<arch>.zip`：上面这个目录的 zip。不做单文件便携版、自解压、UPX 或混淆。
- `SHA256SUMS.txt`：`release/` 里现有 zip 的 SHA-256。正式发布前先清空 `release/`，免得混进旧版本。

打包时只带 `dist/`（不含 source map）和最小的 `package.json`，不带 `node_modules`；渲染端用 React 生产构建。Electron fuses：关掉 RunAsNode、`NODE_OPTIONS`、`--inspect`，打开 asar 完整性校验与只从 asar 加载。`GrantFileProtocolExtraPrivileges` 暂时保持打开，因为渲染页是用 `file://` 从 asar 里加载的，关掉后窗口空白。Windows 版本资源由纯 JS 的 resedit 写入，macOS 上打 Windows 包不需要 wine。`pnpm package` 结束时会自动跑一遍 `package:verify`，检查 fuses、asar 内容（只有 8 项，没有 `.node`、`node_modules`、source map）、asar 头哈希、Windows 版本资源与清单、zip 与目录逐项一致、SHA-256。

签名：只有在 Windows 主机上打 win32 包，并设置了 `WINDOWS_CERTIFICATE_FILE`（配 `WINDOWS_CERTIFICATE_PASSWORD`）、`WINDOWS_SIGN_WITH_PARAMS` 或 `WINDOWS_SIGN_HOOK_MODULE_PATH` 之一时才签名（SHA-256，`@electron/windows-sign`）。否则打印未签名提示。仓库里不放证书。签名流程还没有实际跑过。

CI 的 `package-windows` 作业在 `windows-latest` 上打 win32-x64 包并核对，zip 和 `SHA256SUMS.txt` 作为 artifact 保留 14 天。这只证明包的结构正确，不等于在 Windows 上启动过或做过 Defender 扫描。

设计目标是解压即用、不装额外组件、对 Windows 杀毒软件友好：最终用户不需要安装 Node.js、Python、.NET、VC++ 运行库或 WebView2，也不需要管理员权限；运行时依赖只用纯 JavaScript 包（`tests/deps.test.ts` 会检查）；运行时不启动子进程、不联网、只监听 `127.0.0.1`。签名、版本信息、Electron fuses 和 Defender 扫描的要求见 prompt「原生兼容、免额外组件与杀毒软件友好」。

发布包在签名之前都是未签名的：Windows 会弹 SmartScreen 提示，macOS 的 Gatekeeper 会拦下未签名、未公证的应用。只从仓库所有者发布的位置下载，并核对随附的 SHA-256。

## 限制

- 只读。不控制宿主，不暂停任务，不批准或纠正动作。
- 只显示宿主发来的事件。读不到模型的隐藏思考，不生成推理过程，也不补写理由；没有接入的宿主就没有数据。
- 只在本机。接收端只监听 `127.0.0.1`，不联网，没有遥测和账号。
- Linux Wayland 上多数合成器不允许应用置顶或自定位窗口，小窗可能被遮挡，位置也可能恢复不了。
- Windows 10/11 桌面实机没有验证，没有 Defender 扫描记录；Windows 上只在 GitHub 的 Windows Server runner 上跑过。macOS 只验证了表里列出的几项。
- 内存按条数封顶，不按字节（审计 A9，记录 23）：事件窗口最多 20000 条且不超过 32 MiB，但聚合状态（200 个运行 × 每个 500 个判断与 500 次尝试）会另外引用窗口外的事件。30 分钟常规负载下 GC 后 heap 约 38 MB；每个判断都带约 60 KB 正文的极端情况下，窗口外多占约 84 MB，所选运行的每次快照约 31 MB。
- 写盘是同步的：文件系统卡顿时整个接收端会停住（实测最长约 1 秒），发送端会超时重试（C10，记录 23）。导出、回放和重启恢复也同步读文件，30 MB 数据约 0.4–0.6 秒。回放超过 20000 条时保留最早的 20000 条。
- 去重只在内存窗口内，窗口外的旧事件重发可能被再次接受（C8）。跨 producer 的先后取决于发送端时钟（C11）。完全损坏的尾行不保留 cursor 高水位（C6）。详见 `docs/INTEGRATION.md` 第 6、7 节。
- 许可证由仓库所有者决定，暂未授予开源许可证。

## 已核实的边界（2026-09-23）

- [Python SDK](https://docs.typesafe.ai/sdk/python) 是 `typesafe-sdk`，`TypeSafeClient.system_one` 返回各问题答案；[JavaScript SDK](https://docs.typesafe.ai/sdk/javascript) 是 `@typesafe-ai/sdk`，使用 `systemOne`。监视器不发模型请求、不固定模型版本。
- [Choice](https://docs.typesafe.ai/primitives/choice) 有 `choice/probabilities/confidence`；[Score](https://docs.typesafe.ai/primitives/score) 是有序等级位置（可为小数），有概率、legend 和 confidence；[Noul](https://docs.typesafe.ai/primitives/noul) 为 yes 概率，没有独立 confidence。
- [Confidence](https://docs.typesafe.ai/confidence) 描述分布集中程度，不是任务成功率。请求期间不生成概率；不读取或生成模型隐藏思考。
- 查阅官方文档、[agent skill 索引](https://docs.typesafe.ai/agent-skill)及针对 monitor/observability/events 的检索，未找到可直接复用且具有独立置顶窗口、实际执行与验证关联的官方工具。这是有限调查，不声称此类工具不存在。`llms.txt` 的 web 抓取失败，使用官方各页面核对。
- 当前可用技能目录没有 TypeSafe skill。参考项目 `JevJudgment` 与架构已只读检查：判断含 next_action、概率、confidence、latency、request_id、goal/stuck Noul、danger Score。现有 JSONL 用 `ts/kind`，不是本项目协议，需要显式适配；未读取 `.env`，未修改参考项目。
- 采用 Electron 隔离窗口和 JSONL 有界保留；本地服务不接受浏览器跨域调用。Python 发送器仅用标准库。许可证由仓库所有者决定，暂未授予开源许可证。

## 协作

本项目由多个 AI 模型接力开发。每完成一个小任务先 `git add` 暂存在本地，每完成一个大功能或大方向再 commit 并 push 到 GitHub；云端 agent 在会话结束前推送到自己的分支。Cursor 云端 agent 直接用 Cursor Agent 账号提交；本地开发在提交里用小写记录 harness 和模型系列，不写版本号（如 `[cursor/claude-opus]`）。规则见 [`AGENTS.md`](AGENTS.md)。

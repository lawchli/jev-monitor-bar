# JEV Monitor Bar：交给实现 agent 的完整 prompt

> 用法：本文件是本仓库（https://github.com/lawchli/jev-monitor-bar）的总需求与实施指导，由多个 AI 模型接力实现。
> 本文件不表示产品已经开发、运行或发布；实际进度以 `docs/IMPLEMENTATION.md` 为准，已知问题以 `docs/AUDIT.md` 为准。
> 暂定名称 JEV Monitor Bar；用户口述的「manual bar」按实时决策监视条理解，不默认包含人工控制功能。
> 接手前必须先读 `AGENTS.md`（协作与提交规范）。

## 你的任务

在本仓库 `jev-monitor-bar` 中，为使用 TypeSafe/JEV 的长任务提供一块持续可见、实时更新的小窗口。用户希望随时知道：它正在判断什么、有哪些候选、最后选了什么、应用最终执行了什么、执行效果如何。

核心体验是：运行任务时，屏幕边缘始终有一个安静但持续更新的监视条；需要时展开查看某次决策的完整可观测记录。请完成可运行的 MVP，不要只交付方案、静态 UI 或随机跳动的演示图。

本仓库独立于 `jev_zzz`，不要把 `jev_zzz` 改造成监控产品，也不要复制整个现有项目。现有项目只用作首个适配参考。

仓库所有者已授权：每完成一个小任务先 `git add` 暂存在本地，每完成一个大功能或大方向再 commit 并 push 到 GitHub（规则见下文「多模型协作与提交规范」）。仍不得自行创建 GitHub Release、修改仓库设置、设定许可证或发布安装包到公开渠道。

## 先核实，再实现

1. 阅读当前 TypeSafe 官方文档与可用的 TypeSafe skill，核实实际 SDK、响应字段和限制，不要凭记忆写接口或锁死模型版本。
2. 简短调查官方是否已有符合需求的监视工具或可复用的事件接口。优先复用兼容接口；不要把调查变成无限选型。找到类似产品也必须核实是否支持本任务需要的独立窗口和执行结果关联。
3. 检查目标运行环境与已有日志。没有现成事件源时，用明确的接入 SDK/适配器提供事件，不要声称能自动读取任意 agent 的内部状态。
4. 把实现选择、已核实事实和待确认限制写进 README，然后继续开发；普通技术选型由你决定。

第 1–2 步已由前序模型完成并记录在 README「已核实的边界」。后续接手者只需在改动相关接口时复核，不必重复整轮调查。

参考文档：

- https://docs.typesafe.ai/llms.txt
- https://docs.typesafe.ai/concepts/system-one
- https://docs.typesafe.ai/primitives/choice
- https://docs.typesafe.ai/confidence
- https://docs.typesafe.ai/sdk/python
- https://docs.typesafe.ai/sdk/javascript

本 prompt 编写时已核实：Choice 返回选中项、候选概率分布和 confidence；confidence 与分布的集中程度有关，不等于整个任务的正确率。接手时仍须重新核对具体接口。

## 对「深思熟虑」的产品解释

用户想看的是决策过程的可观测信息。展示输入摘要、候选集合、实际返回的概率、选中项、规则是否覆盖选择，以及后续验证证据。

不能把一次响应包装成模型内部逐步思考，也不能生成虚假的实时概率变化。请求尚未完成时展示「正在评估候选」和已知候选，概率保持未知；收到响应后才更新实际结果。若上游确实提供多轮判断，逐轮展示真实事件。

「决策说明」只显示调用方明确提供的简短说明，或由已记录规则生成的解释，并标明来源。没有说明时显示「未提供」。默认不增加额外 LLM 调用来补写理由。模型判断、应用决策、执行反馈三者必须清楚分开。

## 平台支持策略

目标是全平台。Windows 是第一优先级，必须先做好；macOS、Linux 后续逐步适配，但从第一天起架构不能锁死在 Windows 上。

| 平台 | 级别 | 当前要求 |
| --- | --- | --- |
| Windows 10/11 x64 | Tier 1 | 功能完整；实机验证置顶、拖动、缩放、不抢焦点、多显示器/混合 DPI、安装或便携包 |
| macOS（arm64/x64） | Tier 2 | 代码可编译、核心测试在 CI 通过；窗口行为可后续实机验证，未验证时 README 标明 |
| Linux X11、Windows arm64 | Tier 2 | 同上 |
| Linux Wayland | Tier 3 | 尽力而为；多数合成器不允许应用自行置顶或定位窗口，须在 UI/README 标明限制 |

编码约束：

- 协议、存储、状态聚合、接收服务和 Python 发送器必须平台无关：路径一律用 `path` / `pathlib` 拼接，不硬编码分隔符、盘符或 `~`；不以 `.ps1` / `.sh` / `.bat` 作为唯一入口，启动、构建、演示统一用 `pnpm` scripts 调用 Node 脚本（`scripts/*.mjs`）。
- 平台差异集中在桌面壳的一个模块（建议 `src/main/platform.ts`），其他代码不散落 `process.platform` 判断。每个分支写明对应平台与已验证状态。
- 数据与会话目录只定义一次，桌面端与 Python 发送器必须一致，均可用 `JEV_MONITOR_HOME` 覆盖，会话文件可用 `JEV_MONITOR_SESSION` 单独覆盖：
  - Windows：`%LOCALAPPDATA%\jev-monitor-bar\`
  - macOS：`~/Library/Application Support/jev-monitor-bar/`
  - Linux：`${XDG_STATE_HOME:-~/.local/state}/jev-monitor-bar/`
  - 不要直接用 Electron 默认 `userData`：Windows 上它位于 Roaming 目录，会话凭证可能随漫游配置同步。
- 会话凭证文件：POSIX 用 `0600` 并在已存在时也校正权限；Windows 上 `mode` 无效，依赖用户目录 ACL，README 须说明。写入使用临时文件加重命名，读端容忍短暂缺失或旧文件（旧凭证会得到 401，发送端按离线处理）。
- 置顶级别、全屏应用之上是否可见、多桌面/Spaces 行为、`showInactive` 是否真的不抢焦点，均因平台而异，以实测为准并记录。
- 窗口位置持久化时同时记录所在显示器与缩放；恢复前用 `screen` API 校验窗口是否落在任一显示器 workArea 内，否则移回主显示器。
- Windows 上杀毒软件或其他进程可能短暂占用文件，段文件轮转与删除遇到 `EPERM` / `EBUSY` 要重试或延后删除，不能让接收服务崩溃。读 JSONL 时兼容 `\r\n`。
- 接收端只监听 `127.0.0.1`，不监听 `0.0.0.0`（后者会触发 Windows 防火墙提示并暴露到局域网）。
- Python 发送器支持 Python 3.9+，只用标准库，在三个平台上行为一致。
- 打包在对应系统上构建：首版只要求 Windows 包（便携版或安装包）；macOS 签名/公证、Linux AppImage/deb 后续再做。未签名会触发 SmartScreen / Gatekeeper 提示，README 须说明。
- CI 在 `windows-latest`（必须通过）、`ubuntu-latest`、`macos-latest` 上跑类型检查与测试。CI 通过不等于原生窗口行为已验证；有桌面冒烟测试后优先在 Windows runner 上运行并上传截图。

## 原生兼容、免额外组件与杀毒软件友好

目标：用户下载后直接运行，不需要另装任何组件；在 Windows 上不被 Microsoft Defender 等杀毒软件误报或拦截；在每个平台都遵循该平台的原生习惯。

### 免额外组件

- 最终用户运行监视器，不需要安装 Node.js、Python、.NET、VC++ 运行库、WebView2 或其他运行时。Electron 自带 Chromium 与 Node，这是选择它的理由之一（Tauri 在 Windows 依赖 WebView2 运行时，部分 Windows 10 环境需要另装或联网引导安装）。
- 运行时依赖（`package.json` 的 `dependencies`）只允许纯 JavaScript 包：不引入原生 Node 扩展（`.node` 文件、node-gyp / `binding.gyp`），也不引入带 install/postinstall 脚本的包。持久化继续用 JSONL；若改用 SQLite，只能用运行时内置模块，不用 better-sqlite3 等原生扩展。`tests/deps.test.ts` 会检查这一点。
- 宿主端 Python 发送器只用标准库，不要求宿主额外 `pip install` 第三方包，可以单文件复制接入。
- 不需要管理员权限：按用户安装在用户目录，Windows 清单使用 `asInvoker`；不安装服务、驱动或计划任务。
- 运行时不联网下载任何组件；首版不做自动更新。

### Windows 杀毒软件友好

- 发布包使用 Authenticode 代码签名。证书由仓库所有者决定并提供，CI 通过 Secrets 注入，不提交进仓库。未签名的版本须在 README 说明 SmartScreen 提示，并附发布文件的 SHA-256。
- 可执行文件填写完整版本信息（CompanyName、FileDescription、ProductName、FileVersion），文件名和安装路径固定，不随机命名。
- 首版发布为解压即用的目录 zip。不用「单文件便携版」（每次启动解压到临时目录再执行，容易被启发式拦截且启动慢）；不用 UPX 等加壳、自解压或代码混淆。具备签名后再提供 NSIS / MSIX 安装包。
- 运行时不做以下行为：启动 PowerShell / cmd 或其他子进程，从临时目录执行文件，写注册表 Run 键或启动文件夹（开机自启只能由用户明确开启，并通过 Electron 官方 API 实现），全局键盘/鼠标钩子，读写或注入其他进程，修改防火墙规则，截屏或录屏。
- 网络只连接 `127.0.0.1`，不监听 `0.0.0.0`，不访问外网，不带遥测。
- 文件写入限制在自己的数据目录内，写入总量有界、轮转平缓，避免高频创建和删除大量小文件。
- 打包时用 Electron fuses 关闭 `RunAsNode`、`NODE_OPTIONS`、`--inspect` 等调试入口，并启用 ASAR 完整性校验，避免发布包被滥用为可执行任意脚本的宿主程序。
- 每次发布前，在 Windows 实机用 Microsoft Defender 扫描发布包并记录结果；遇到误报，通过 Microsoft 安全情报门户提交。是否上传 VirusTotal 等公开服务由仓库所有者决定（上传即公开样本）。

### 各平台原生习惯

- 数据目录按上文各平台约定；跟随系统的深浅色、缩放和「减弱动态效果」设置；使用各平台常规窗口类型与标题栏行为，不做透明全屏覆盖层。
- 打包格式按平台原生：Windows 为目录 zip，签名后提供安装包；macOS 为 `.app` / `.dmg`（签名并公证后）；Linux 为 AppImage / deb。
- 快捷键、托盘/菜单栏图标等交互按各平台惯例实现，平台差异仍集中在平台模块。

## 必须实现的体验

### 常驻小窗

- 按上文「平台支持策略」优先完成 Windows；提供真正可置顶、可拖动、可调整大小的小窗口，支持紧凑和展开模式。浏览器网页本身不能当作已实现的系统置顶窗口。
- 紧凑模式建议宽约 360–440 px，显示任务名、连接状态、当前阶段、最新选择、实际动作、执行状态、最近事件时间和运行时长。
- 收起后仍可看见最新决策与结果；默认不抢焦点、不打断用户操作。记住位置和尺寸，并处理窗口落在已移除显示器之外的情况。
- 中文优先，内容简洁，长文本截断后可展开；状态同时有文字与颜色。

### 决策详情与时间线

- 按任务/run 分组，支持最新事件跟随、暂停滚动、历史查看，以及一键回到最新。暂停滚动不应暂停后台接收。
- 每次决策展示：问题/目标、输入状态摘要、候选及说明、概率条、选中项、模型标识、响应耗时，以及上游实际提供的 confidence。
- 清楚展示「JEV 选择 A → 策略覆盖为 B → 实际执行 B → 验证结果」，包括覆盖规则与来源。规则直接决策时标记为规则，不伪装成 JEV 调用。
- 支持一请求多问题与并发决策的关联；用稳定的 ID 连接请求、判断、执行尝试与验证。
- Choice、Score、Noul 按各自语义展示，不统一硬套成「信心百分比」。未知数据展示未知。
- 可查看经脱敏的事件详情、筛选错误与重试，并导出和回放事件记录。

### 执行效果

- 状态至少区分等待、评估中、已选择、执行中、已执行待验证、验证成功、验证失败、失败、取消、未知。
- 发出了动作或工具返回成功，不自动等于目标达成。验证事件要带检查项、观测结果和可选证据引用。
- 展示已完成步骤/总步骤（总数已知时）、耗时、重试数、验证成功/失败/未知次数。未知总量时显示阶段和已完成数量，不编造进度百分比。
- 若展示成功率，明确样本口径与分母；未验证动作不得默认为成功。模型概率不作为执行成功率。
- 可展示真实上游 usage；成本仅在具备可靠价格和用量时计算并注明口径，不做 MVP 必需项。

## 建议架构与边界

用「宿主任务 → 轻量事件发送器 → 本地接收与持久化 → 实时 UI」解耦。

已选定 TypeScript + React + Electron 做桌面窗口和本地服务，配一个标准库 Python 发送器。选 Electron 而非 Tauri 的主要理由是跨平台一致性和免额外组件：Tauri 在三个平台分别使用 WebView2、WKWebView、WebKitGTK，渲染与置顶行为差异更大，Windows 上还依赖 WebView2 运行时；Electron 自带 Chromium，置顶窗口 API 成熟。若后续要换，须说明理由并重新验证三个平台的置顶与安装流程。不要引入云服务、账号系统或付费监控依赖。

- 首版只读观测，不实现任务操控、自动纠错、暂停宿主或人工批准动作。
- UI 关闭、监视器离线或数据发送失败，不应阻塞或改变宿主任务。发送端使用有界队列、短超时，丢弃时记录计数。
- 接收端默认仅监听 loopback；提供本地会话凭证并验证来源，限制事件大小。桌面壳启用 `contextIsolation`、`sandbox`，禁用页面 Node 权限，UI 通过 preload 暴露的最小 IPC 读取数据，不直接访问接收端 HTTP；不把日志内容当 HTML 执行。
- 默认发送摘要与必要字段；密钥、Authorization、环境变量和敏感输入不进入 UI 或导出。原始 payload 为明确启用的诊断选项，仍须脱敏。
- 脱敏范围：自由文本字段按内容模式脱敏；`diagnostic` 中的对象按键名和内容脱敏；`candidates` / `probabilities` / `legend` / `usage` 的键是调用方定义的候选名，只脱敏值、不按键名替换（否则会破坏候选与概率的对应关系）。接入文档须提醒调用方不要把秘密放进候选名。
- 持久化可选 SQLite 或追加式 JSONL（当前实现为 JSONL），支持重启恢复、轮转和有界保留；UI 对长列表做虚拟化或限量渲染。
- 连接中断时显示断开与最后更新时间；重连支持去重和续传。保留事件发生时间与接收时间，不把迟到事件误当作当前执行状态。

## 事件协议要求

先定义带版本的 JSON Schema/类型，再实现发送器、存储与 UI。下面是本项目拟定协议，不是 TypeSafe 原生 API。当前定义在 `src/protocol.ts`，后续应导出为独立的 JSON Schema 文件供 Python 端校验与文档引用。

公共字段：`schema_version`、`event_id`、`run_id`、`producer_id`、`sequence`、`occurred_at`、`type`、`payload`。接收端另存 `received_at` 与单调递增的 `cursor`；相关事件带 `decision_id`、`request_id`、`question_id`、`action_id`、`attempt_id`，仅在适用时提供。

身份与去重规则：

- `producer_id` 在每个发送端进程实例内唯一（例如 `<宿主名>-<pid>-<随机串>`），发送端重启必须换新值；`sequence` 在同一 `producer_id` 内单调递增。
- 相同 `event_id` 视为重复，返回 `accepted:false`。相同 `run_id`+`producer_id`+`sequence` 却是新 `event_id`，视为冲突并返回 HTTP 409，发送端应记录为丢弃并告警，不能当作已送达。
- 去重只在接收端保留窗口内保证；超出保留范围的旧事件重发可能被再次接受，协议文档须写明。

事件至少覆盖：

- `run.started / run.completed / run.failed / run.cancelled`
- `decision.started / decision.resolved / decision.failed`
- `action.selected`（最终应用选择，可与模型选择不同）
- `action.started / action.completed / action.failed / action.cancelled`
- `verification.completed`（passed / failed / unknown，加证据与原因）
- `progress.updated / heartbeat / telemetry.dropped`

候选、判断、规则覆盖、执行、验证分别记录，不能反复覆盖一张「最新结果」而丢失历史。明确允许的状态转换与异常事件处理；支持重复、乱序、失败重试、缺失完成事件、多 run 并行，并防止终态被旧事件倒退。

## 当前项目的接入参考

原始参考目录：`C:\Users\lance\codespace\jev_zzz`。其他环境中可能不存在，缺失时不要阻塞独立产品开发。

- `src/zzz_agent/policy/jev.py` 中已有 `JevClient`、`JevRequest` 和 `JevJudgment`。
- 当前判断对象包含 next_action、probabilities、confidence、latency_ms、request_id，以及 goal_reached、stuck 和 danger 等判断信息。以实际代码为准。
- `docs/architecture.md` 描述状态 → 规则/JEV → 校验 → 动作 → 再观测的流程；运行产物目录为 `artifacts/runs/<id>/`，日志格式需实际检查（前序模型已确认现有 JSONL 使用 `ts/kind`，需要显式适配）。
- 交付一个独立的示例适配器/接入指南，展示在哪里发送判断、最终动作和验证事件。仅包装 JEV 请求无法知道实际执行结果，必须说明其余接入点。
- 不改动参考项目、不运行真实游戏输入、不读取 `.env` 秘密。使用 FakeJevClient 或自包含的模拟宿主完成演示；新项目不得依赖原始目录才能启动。

## 实施顺序

每个里程碑拆成可独立验证的小任务：每完成一项就 `git add` 暂存并在 `docs/IMPLEMENTATION.md` 登记；里程碑（或其中一个大功能）完成后再 commit 并 push。里程碑状态以该文件为准。

1. M0 核实与骨架：核实 API、环境和已有工具，确定最小架构。
2. M1 核心：定义事件协议与固定演示数据，完成接收、持久化和状态聚合，并有单元测试与三平台 CI。
3. M2 桌面壳：Electron 主进程、平台模块、preload、置顶小窗（Windows 先行），打通真实事件流到小窗。
4. M3 UI：紧凑/展开模式、详情、时间线、历史、断线提示、导出与回放。
5. M4 接入：轻量 Python 发送器（仅标准库）和示例宿主；无 API key 也能用一条命令（`pnpm demo`）启动演示。
6. M5 验证与交付：接入文档、延迟与长时负载测试、Windows 实机截图/录屏、Windows 打包（版本信息、fuses、可签名流程）与 Defender 扫描；再逐步补 macOS / Linux 实机验证。

演示必须明确标注「模拟数据」，至少包含正常完成、概率分散、规则覆盖、动作执行失败后重试、执行完成但验证失败、连接中断后恢复。演示通过与正式接入相同的协议发送事件，不绕过接收层硬写前端状态。

## 验收与交付

- 全新检出按照 README 可安装并运行（Windows 必须，macOS/Linux 在各自适配完成后）；无 TypeSafe key 可演示，有接入说明可连接真实宿主。
- 在未安装 Node.js / Python / 其他运行时的全新 Windows 10/11 上，解压发布包即可运行，不需要管理员权限；发布包经 Microsoft Defender 扫描无告警，记录系统版本、Defender 情报版本和日期。
- 独立小窗确实置顶并持续更新；提供截图或录屏，并注明平台与系统版本。若环境无法验证原生窗口（例如 Linux 云端 agent 无法验证 Windows 窗口），明确列为未验证，不得只凭构建成功宣称完成。
- 本地事件接收到可见更新目标 p95 ≤ 500 ms，记录测试机器、操作系统、事件量和测量方法；不把模型响应耗时算作 UI 延迟。
- 用至少 30 分钟、累计 10,000 条事件的合成负载检查内存、响应性与存储增长，报告实测结果、平台和限制。
- 有意义的测试覆盖：事件关联、去重乱序、终态保护、规则覆盖、重试、未验证状态、断线恢复、发送器不阻塞宿主，以及敏感字段脱敏。
- 交付源码、锁文件、README、协议说明、Python 接入示例、演示/回放数据、启动脚本、测试与构建结果，以及 `.env.example`（无真实凭证）。
- README 说明数据来源、不能读取模型隐藏思考、各平台置顶窗口支持范围、数据保留与接入边界。许可证由仓库所有者选择，不擅自设定。
- 最终报告以「已实现、如何启动、如何接入、验证结果、尚有限制」说明交付状态；不要把未经执行的测试或未在对应平台验证的行为写成已完成。

## 多模型协作与提交规范

本项目由多个 AI 模型/工具接力完成，完整规则见 `AGENTS.md`，要点：

- 每完成一个小任务：`git add` 暂存在本地，并在 `docs/IMPLEMENTATION.md` 登记，不单独 commit。
- 每完成一个大功能或大方向（通常是一个里程碑或其中一个可独立使用的功能）：确认类型检查和测试通过后 commit 并 push 到 GitHub，由 GitHub CI 在三个平台复验。
- 云端 agent（如 Cursor Cloud Agent）的虚拟机结束后本地暂存会丢失，所以会话结束前即使大功能未完成，也要 commit 并 push 到自己的功能分支，标题标 `WIP`。
- 署名：Cursor 云端 agent 直接用 Cursor Agent 账号提交，不另写署名；本地开发在提交标题末尾写 `[<harness>/<model>]`，正文末尾写 `agent-harness:` 与 `agent-model:` 两行，全部小写。model 只记厂商和模型系列、不写版本号，例如 `[cursor/claude-opus]`、`[codex/gpt-sol]`。
- 实施记录写明日期、harness、model、提交、完成内容、实际执行的验证、遗留问题。未执行的验证不得写成已通过。

请从阅读 `AGENTS.md`、`docs/IMPLEMENTATION.md`、`docs/AUDIT.md` 开始，接着推进下一个未完成的里程碑，直到可运行、可验证的 MVP。

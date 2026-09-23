# 全分支方向审计与 agent 接续建议

- 日期：2026-09-23；审计者：`codex/gpt-astra`。
- 基线：`main@cd99afb`。通过 GitHub API 分页列举全部现存远端分支、PR 和 Actions，再 fetch 对照源码与提交祖先关系。审计开始时工作区干净。
- 范围：13 个远端分支、11 个开放 draft PR；需求、协议、核心、桌面壳、两种 UI、发送器、演示、导出回放、CI 与实施记录。这里的“全部”指审计时仍存在的分支，不包含已删除分支或其他 fork。
- 本次只交付审计文档，没有合并功能 PR、修改应用代码或发布产品。本文是审计快照与建议，不替代总需求，也不授权后续 agent 擅自合并或发布。

## 判断：产品方向正确，开发需要从分散切片转向集成验收

继续做独立、本地、只读、Windows 优先的决策监视条是合理的。已审分支没有引入云服务、账号、额外模型调用、任务控制或游戏输入；Choice / Score / Noul 的区别、模拟标记、未知数据、执行与验证分离总体保留。Electron + React + TypeScript、标准库 Python、loopback 接收与 JSONL 的选择无需推倒重来。

主要偏离发生在交付方式：功能持续向外扩展，但 `main` 仍只有 M0 / 部分 M1；没有任何一个现有功能分支包含全部修复和体验。不要再把“多个 PR 分别绿灯”当成一个可运行 MVP。下一阶段应先让同一个提交完成“宿主 → HTTP → 持久化 → 紧凑条 → 展开 → 导出 → 回放”的闭环，再扩展功能。

另有一个直接违反产品语义的问题：详情把“已选择”写成“实际执行”。这是必须先修的真实性问题，不是措辞润色。其余高优先级问题集中在发送失败隔离、导出安全、历史可达性和开发脚本的数据边界。

## 全部分支盘点

以下每行都检查了该 HEAD 对应的 CI：Windows、Ubuntu、macOS 的 core job 均成功。Python 分支另有三平台 × Python 3.9 / 3.13 六个 job，均成功。运行号链接是本次核验依据；CI 成功不等于原生窗口已验收。

| 分支（`cursor/` 前缀除 main 外省略） | HEAD | PR / 基分支 | 实际内容与判断 | CI run |
| --- | --- | --- | --- | --- |
| `main` | `cd99afb` | 默认分支 | M0 / 部分 M1；无桌面入口。README 的“尚不可用”对 main 仍准确 | [35765378208](https://github.com/lawchli/jev-monitor-bar/actions/runs/35765378208) |
| `audit-plan-cross-platform-466a` | `279ae42` | [#1](https://github.com/lawchli/jev-monitor-bar/pull/1)，已合并 | 历史审计与平台约束，代码已在 main，无需再合并 | [35765147020](https://github.com/lawchli/jev-monitor-bar/actions/runs/35765147020) |
| `p1-00-format-boundaries-d8ab` | `32e2439` | [#2](https://github.com/lawchli/jev-monitor-bar/pull/2) → main | 独立格式化与源码边界守卫，方向合理；守卫只是静态辅助 | [35768238185](https://github.com/lawchli/jev-monitor-bar/actions/runs/35768238185) |
| `p1-01-walking-skeleton-8677` | `c5a3a18` | [#4](https://github.com/lawchli/jev-monitor-bar/pull/4) → main | 含 P1-00；构建、IPC、目录、最小窗口，正确的集成底座 | [35773266968](https://github.com/lawchli/jev-monitor-bar/actions/runs/35773266968) |
| `p1-02-core-robustness-fccb` | `46bc2b2` | [#5](https://github.com/lawchli/jev-monitor-bar/pull/5) → main | 基于 P1-01；cursor、run 淘汰、会话写入与退出修复，应优先集成；C6 仍有范围限制 | [35775050619](https://github.com/lawchli/jev-monitor-bar/actions/runs/35775050619) |
| `p1-03-protocol-artifacts-b73d` | `98a719a` | [#3](https://github.com/lawchli/jev-monitor-bar/pull/3) → main | 直接基于 main；schema、协议说明、7 个固定场景，方向正确，文档需随集成更新 | [35768760381](https://github.com/lawchli/jev-monitor-bar/actions/runs/35768760381) |
| `p1-04-window-platform-a4ff` | `b74a7c2` | [#9](https://github.com/lawchli/jev-monitor-bar/pull/9) → main | 基于 P1-01；置顶策略、窗口恢复、显示器处理；不能以纯函数测试代替 Windows 混合 DPI 实测 | [35775661532](https://github.com/lawchli/jev-monitor-bar/actions/runs/35775661532) |
| `p1-05-compact-bar-9236` | `fcf974d` | [#6](https://github.com/lawchli/jev-monitor-bar/pull/6) → main | 基于 P1-01；真正的紧凑条，最贴近核心产品体验，应保留并优先打通 | [35774973835](https://github.com/lawchli/jev-monitor-bar/actions/runs/35774973835) |
| `p1-06-expanded-view-9f65` | `8256599` | [#7](https://github.com/lawchli/jev-monitor-bar/pull/7) → main | 基于 P1-01，未含 P1-05；决策/执行/时间线已有，但存在下述 A1、A4 | [35775522395](https://github.com/lawchli/jev-monitor-bar/actions/runs/35775522395) |
| `p1-07-python-sender-52eb` | `c44e074` | [#8](https://github.com/lawchli/jev-monitor-bar/pull/8) → main | 基于 P1-01；标准库、有界条数队列、线程投递、示例与 CI；需要先修 A2、A3 | [35775218541](https://github.com/lawchli/jev-monitor-bar/actions/runs/35775218541) |
| `p1-08-demo-host-33a4` | `b862958` | [#11](https://github.com/lawchli/jev-monitor-bar/pull/11) → P1-05 | 含 P1-03 与 P1-05；真实 HTTP 模拟宿主，未含展开/窗口恢复/核心修复/Python | [35805893419](https://github.com/lawchli/jev-monitor-bar/actions/runs/35805893419) |
| `p1-09-export-replay-973f` | `94d1f01` | [#12](https://github.com/lawchli/jev-monitor-bar/pull/12) → P1-06 | 含 P1-06；导出与隔离回放，仍是占位版紧凑条，未含 P1-02/04/05/07/08；需修 A5–A7 | [35814549977](https://github.com/lawchli/jev-monitor-bar/actions/runs/35814549977) |
| `status-snapshot-a932` | `9537853` | [#10](https://github.com/lawchli/jev-monitor-bar/pull/10) → main | 纯文档；“8 个 PR、P1-08/09 未开工”的快照已经过时，不能作为当前派工依据 | [35803923429](https://github.com/lawchli/jev-monitor-bar/actions/runs/35803923429) |

审计时所有开放 PR 对各自 base 都显示 `MERGEABLE / CLEAN`，且都是 draft。这不意味着它们依次合并无冲突，也不意味着已准备好交付。提交祖先关系确认 P1-06/09 没有 P1-05：这是尚未集成，不是认定某位 agent 删除了已有功能。

在 `/tmp` 独立副本执行 `git merge-tree --write-tree`：P1-02 + P1-03 在 `package.json` 和 `docs/IMPLEMENTATION.md` 冲突；P1-05 + P1-09 只在实施记录冲突。没有修改原功能分支，没有把这些试合并称为完整集成通过。

## 必须修复或明确处理的问题

优先级：P1 = 集成 MVP 验收前修复；P2 = 收尾时落实或明确限制。每项给出可定位证据，修复时请在对应提交增加有意义的回归测试。

### A1 · P1：选择被展示成已经执行

位置：P1-06 / P1-09 的 `src/renderer/expanded/model.ts`，`decisionChain`（约 290–303 行）、`ruleCard`（约 429–438 行）。

仅有 `decision.resolved(choice=A)` 和 `action.selected(action=B)`，没有任何 `action.started/completed`，实测输出仍是 `JEV 选择 A → 实际执行 B`。规则直接决策也只看 selected 就写“实际执行”。违反总需求中模型判断、应用选择、执行事实的区分。

修复：selection 显示“应用选择/待执行”；有 started 才显示“执行中”；completed 显示“已执行待验证”；只有 verification 才报告验证结果。应用覆盖不只处理 `source=rule`，`source=application` 改选也应明确体现，但不可编造规则来源。

验收：分别覆盖只有 selected、started、completed 未验证、验证失败，以及规则直接选定但尚未启动；不能提前出现已经执行或成功的结论。

### A2 · P1：Python 一条不可序列化事件会杀死后台发送线程

位置：P1-07 `python/jev_monitor/sender.py`，`_emit`、`_loop`、`_post`（约 591 行）。

`_emit` 只浅复制 payload 后入队；`json.dumps(...).encode(...)` 在 `_post` 的 try 外，`_loop` 没有兜住这个错误。实测 `emit('progress.updated', {'summary': {1, 2}})` 返回 True，随后 worker 因未捕获 `TypeError` 退出。正常事件之后也无法发送。循环引用、不可编码字符串等也需要处理。嵌套对象被调用方在 emit 后修改会改变尚未发送的数据。

修复：定义可发送的不可变 JSON 快照；序列化、编码、单条大小校验失败计丢弃并继续 worker。限制单条及队列总字节，不只限制条数；避免把大对象序列化或慢日志 handler 引入宿主关键路径。不要让“监视失败不影响宿主”停留在正常输入测试。

验收：先发坏 payload，再发合法事件，合法事件可送达；循环对象、超大正文、emit 后修改嵌套字典、离线队列满都不导致 worker 退出或宿主长时间阻塞。

### A3 · P1：Python 只校验初始 URL，默认重定向可绕过 loopback 限制

位置：P1-07 `sender.py:191`，`build_opener(ProxyHandler({}))` 仍安装默认 `HTTPRedirectHandler`。

已在本机纯对象测试确认：对带 `Authorization` 的 POST，默认 handler 遇到 302 会构造指向另一主机的 GET，并保留 Authorization。测试目标用 `example.invalid`，没有发出任何外网请求。触发前提是会话指向的本地 HTTP 服务返回重定向；没有证据表明当前正常接收器会如此响应，也不声称凭证已经泄漏。

修复：事件投递直接拒绝全部 HTTP 重定向（接收端并不需要它），不只在读取 session 时校验 URL。P1-08 Node 模拟发送已使用 `redirect: 'manual'`，两者语义应一致。

验收：本机服务返回 301/302/303/307/308 时，发送器不请求 Location、不转发 token，记录投递失败并保持线程可用。

### A4 · P1：加载更早事件后，时间线仍只显示最新 500 条

位置：P1-06 / P1-09 `src/renderer/expanded/TimelineTab.tsx:54`，`filtered.slice(-renderLimit)`。

源码路径明确：初始 400 条，第一次加载 100 条可以显示；再加载更早 100 条虽然进入 `older`，却立即被 `slice(-500)` 排除。继续点击只增加内存，不能继续向前阅读。暂停跟随只停滚动，没有固定所读事件窗口；新快照也可能挤走正在读的条目。现有 DOM 测试主要检查切 run 时丢弃过期响应，没覆盖这个场景。

修复：保留 500 条渲染上限，但用可移动历史页/窗口或虚拟列表维护 cursor 锚点；实时接收继续，历史视口不随新事件淘汰。区分“保留窗口外不可取”与“没有更早事件”。

验收：同一 run 至少 1,200 条事件，连续加载能看到第 1 条；读历史时新增 600 条，视口与选中详情不跳走；返回最新后正常跟随。此次为源码确认，未把该交互写成实机复现。

### A5 · P1：导出绕过恢复时的脱敏与有效性检查

位置：P1-09 `src/main/ipc-api.ts` 的 `exportEvents` → `src/store.ts:137` 的 `exportLines`。其他核心分支的 exportLines 也直接读磁盘，但 P1-09 将它暴露为用户操作。

恢复路径会校验并 `sanitizeEvent`，导出却直接读取原始段文件。用含 `summary: 'password=audit-placeholder'` 的历史行复现：内存是 `password=[REDACTED]`，导出仍包含原值。条件是历史/手工/旧版本日志含未清洗内容；正常 ingest 的新事件已有脱敏，不把所有正常日志都说成泄漏。

修复：导出走共享的有界逐行读取、校验、脱敏和序列化流程；诊断默认剔除或明确控制，损坏行跳过并报告数量。不能仅以“写入时处理过”作为导出安全保证。

验收：历史未清洗 payload、diagnostic、无效行和正常事件混合时，导出无敏感值，合法事件可重新导入，损坏计数可见。

### A6 · P1：跨段直接拼接会使有效事件在回放时丢失

位置：同一 `exportLines` 的 `.join('')`。

实测第一段只写损坏尾部 `{"torn":`（无换行），重启后第二段 ingest 一条有效事件：实时存储里有效事件数为 1，但 `parseReplay(store.exportLines())` 得到 0。新段确实隔离了 torn write，导出又把两段黏回一行。

修复：与 A5 一起做逐行导出，每个有效事件独立输出并带换行；不要简单把文件当任意字符串相加。

验收：无末尾换行的有效段、损坏尾行的段、CRLF、空段连续出现时，后一段有效事件不丢失。

### A7 · P2：回放超过 200 个 run 时，默认焦点指向已淘汰 run

位置：P1-09 `src/replay.ts:74–99`，以及 `ReplayView.tsx` 的空状态分支。

实测 201 个不同 run 的合法 started 事件，`replaySnapshot` 返回 200 个 runs，但 `run` 为 undefined：focus 仍是第一条事件的 run，已被 FIFO 淘汰。UI 在无 run 时连选择器都不显示，用户看到“尚未回放到事件”。此外回放 FIFO 淘汰与 P1-02 的“优先结束 run”实现不同，集成后会进一步产生实时/回放差异。

修复：聚合后验证焦点仍存在，使用共享默认 run 选择；即使选中 run 不存在，也允许选择其他 run。统一可复用的保留/淘汰策略。

验收：201+ run、已选 run 被淘汰、回退到该 run 开始前，都可以恢复选择，实时与回放的差异有明确口径。

### A8 · P1：开发启动的 `--fresh` 可递归删除用户指定的数据目录

位置：P1-01 派生的 `scripts/launch.mjs`；P1-08 中第 17 行仍为 `if (fresh) fs.rmSync(env.JEV_MONITOR_HOME, {recursive: true, force: true})`。

这不是发布应用中的子进程违规，而是开发辅助脚本的数据边界问题。非 demo 模式继承外部 `JEV_MONITOR_HOME`；误设为实际日志目录甚至其他目录时，`--fresh` 会直接递归删除。本次只读检查，未执行删除复现。另一个隔离问题：demo 改了 HOME，却仍继承 `JEV_MONITOR_SESSION`，可能覆盖正式会话文件。

修复：fresh 只允许清理已识别的仓库 `.runtime/dev` / `.runtime/demo` 子目录，并处理真实路径/符号链接；自定义目录拒绝自动清空。demo 显式设置自己的 session 路径，避免污染正式实例。

验收：自定义 HOME、指向外部的符号链接、外部 SESSION 均保持原数据/会话；普通 demo fresh 仍可用。

### A9 · P2：事件字节上限不等于进程内存上限，快照与回放成本需实测

位置：各分支 `src/store.ts` 的 `remember` / `snapshot`、`src/state.ts` 的 decision/attempt 引用；P1-09 `replaySnapshot` 每次从头重算。

32 MiB 只统计 `events` 数组，聚合状态仍保存旧事件与合并 payload。受 200 run × 每 run 500 decision / 500 attempt 限制，不能称为完全无界；但它不受那 32 MiB 字节预算约束。小规模实测 `maxEvents=1`，写入 20 个含 4096 字问题的 decision 后，事件字节只有 4,399，仍保存 20 个 decision，所选 run 快照 JSON 长 186,091。这个数字是序列化长度，不是 RSS，也不是 30 分钟负载成绩。

修复：先对集成版本测实际 RSS、IPC 大小、主线程阻塞和可见更新 p95，再决定摘要投影、共享历史读取、批处理或回放 checkpoint；不要为此贸然改数据库或堆框架。回放导入/导出当前同步读写也要进入测量。

验收：按总需求 30 分钟、至少 10,000 条事件；增加接近单条上限、多 run、分页与回放并行的压力场景。写清 retained events、聚合状态、磁盘保留各自的上限与降级提示。

### A10 · P2：核心修复和文档的完成口径需要收紧

- P1-02 对 C6 保留的是“可解析 JSON 中的 cursor”，完全 torn、无法 JSON.parse 的行仍不保留高水位。如果要保证重启续传 cursor 永不复用，应增加可靠高水位或会话 epoch / 重同步约定；否则明确损坏恢复的限制，并用“客户端已见 cursor N、磁盘尾部损坏、重启后续传”验证。不要笼统写成所有损坏都已修复。
- P1-03 `docs/PROTOCOL.md` 如实描述其旧基线：没有 paths、会话非原子、run FIFO、只取有效行 cursor；这些在合并 P1-01/02 后必须改为集成后的事实。`usage`“非数字值会丢掉”也应更正为入口校验拒绝事件，而不是静默过滤。
- P1-08 的 reconnect 场景用 35 秒停发模拟静默，能展示“可能断开”，但未等价验证进程重启、凭证轮换和队列补发。发送器自身已有部分相关测试，还需完整闭环验收。
- P1-00 的边界守卫只扫描 `src` TypeScript 字符串，不覆盖 Python 重定向，也不能证明发布包不联网。保留它作为早期检查，增加实际边界测试，不必发展成大型自制静态分析器。
- #10 的状态快照和实施记录“未开工/待拍板”只代表写入当时；追加更正并更新当前状态入口。不要把旧快照里的固定模型派工当产品技术依赖，也不要改写已有历史记录。

## 建议的接续顺序与验收门槛

1. **先收拢基线。** 审阅并按依赖顺序集成 #2 → #4 → #5，再 #3、#9、#6、#7、#8，最后 #11、#12；#10 的历史信息保留但追加现状更正。实际合并要遵守当时用户授权；没有合并授权时，在自己的集成分支把结果做成可审阅 PR。不要直接改别人分支，不 force push，不因栈式 PR 包含祖先就重复 cherry-pick。同一产品提交必须同时包含核心修复、窗口恢复、真正紧凑条、展开、Python、demo 和回放。
2. **修真实性和边界缺陷。** A1、A2、A3、A5、A6、A8 与集成并行准备；A4、A7 作为历史浏览/回放可用性的验收门槛。合并 package scripts、CI jobs、锁文件和实施记录时逐项保留功能，不能选择整份 ours/theirs 丢另一侧。文档追加记录用标题/分支/提交辨认，不为消除编号冲突重写他人历史。
3. **在一个提交上走完真实闭环。** `pnpm demo` 无 key 启动；7 个场景通过 HTTP 入库；紧凑/展开显示同一 run；只选择不显示已执行；完成未验证不显示成功；暂停浏览不阻塞接收；导出回放后关键状态一致；退出回放可看到持续接收的实时数据。再用标准库 Python 假宿主对同一个接收器复验。
4. **保留 CI，补关键跨模块测试。** 集成 HEAD 上跑 typecheck、全部 TS 测试、build、Python 3.9/3.13 测试、schema/fixture 一致性检查和上述回归。三平台分别通过。CI 的 build/纯函数/DOM 结果单列，不写成原生桌面成功。
5. **Windows 优先收尾 M5。** 先做 Windows 10/11 x64 原生置顶、不抢焦点、拖动缩放、显示器移除与混合 DPI；再做实际可见延迟与负载。之后目录 zip、版本信息、fuses、签名条件、SHA-256、Defender 实测和无外部运行时机器验证。macOS/Linux 原生验证按分级补齐，不阻塞核心集成，也不以兼容代码冒充实测。

暂缓：换技术栈、SQLite 重构、云同步/账号、自动更新、宿主控制按钮、额外 LLM 理由生成，以及进一步堆叠未集成的 UI 功能。必要的故障修复、协议接入说明和 Windows 验收应继续推进。

## 本次验证与限制

- Linux 本地：系统自带 Node 20 且无 pnpm；为匹配仓库要求，在 `/tmp` 装 Node **22.23.2** / pnpm **11.19.0**。按锁文件安装，跳过 Electron 二进制下载，未修改 package 或 lockfile。
- `main@cd99afb`：`pnpm typecheck`、`pnpm test` **10/10 通过**。
- P1-09 `94d1f01` 的独立文件快照：`pnpm typecheck`、`pnpm test` **43/43 通过**、`pnpm build` 通过。
- P1-07 `c44e074` 的独立文件快照：Python **3.13.5**，`python3 -m unittest discover -s python/tests -v` **16/16 通过**。初次受限环境无法创建 socket，解除本机测试限制后完整重跑通过；该环境错误不计作代码缺陷。
- 另用临时探针直接调用生产函数复现 A1、A2、A5、A6、A7 和 A9 的小规模计数；A3 验证标准库默认重定向构造行为，未发送外网请求；A4、A8 为源码路径确认。探针使用假凭证，不读取真实 `.env` 或 token。临时文件未提交为产品代码。
- 已核验上表 13 个 HEAD 的 GitHub CI job；未在本地逐一重跑其余所有分支测试。两组试合并不等于全部分支集成测试。
- **未做** Windows/macOS 原生窗口实测、30 分钟负载、可见延迟测量、打包、Defender 扫描或发布；不能据本文把 M2–M5 标为完成。TypeSafe SDK 接口没有修改，此次未重复官方接口调查。

后续 agent 完成问题时，请引用 A 编号追加修复证据及对应提交；不要直接删去问题使历史看起来“从未存在”。本文件合并后，仍应重新 fetch 核对 HEAD，避免把今天的分支表当永久现状。

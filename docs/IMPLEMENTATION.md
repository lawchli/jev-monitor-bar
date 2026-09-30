# 实施记录

记录只追加、不改写。署名规则与提交流程见 `AGENTS.md`：小任务完成后 `git add` 暂存并在当前记录里补一项，大功能或大方向完成后再 commit 并 push。

## 里程碑状态

每次推进里程碑时更新本表，并在下方追加对应记录。

| 里程碑 | 内容 | 状态 |
| --- | --- | --- |
| M0 | 核实 TypeSafe 接口、参考项目与技术选型 | 完成（记录 01） |
| M1 | 协议、接收、持久化、状态聚合、脱敏；单元测试与三平台 CI | 集成分支已有核心模块、JSON Schema、协议文档与模拟场景（记录 08）。协议与审计里过时的句子在记录 A10 更正。A1–A8 已在集成分支修复（记录 09、10、A8），闭环验收在 Linux 窗口完成（记录 11），三平台 CI 通过（记录 13）。A9 留到 M5 |
| M2 | Electron 主进程、平台模块、preload、Windows 置顶小窗 | 集成分支已有主进程、平台模块、preload 与窗口位置恢复（记录 08）。原生 Windows 窗口未验证 |
| M3 | 紧凑/展开 UI、详情、时间线、断线提示、导出与回放 | 集成分支已有紧凑条、展开视图、导出与回放（记录 08） |
| M4 | Python 发送器、示例宿主、`pnpm demo` | 集成分支已有 Python 发送器、示例宿主与 `pnpm demo`（记录 08） |
| M5 | 接入文档、延迟与负载测试、Windows 实机验证与打包；macOS/Linux 适配 | 进行中：接入文档（记录 16）、目录 zip 打包与读回核对（记录 18、22）、桌面冒烟测试与可见延迟（macOS 与 Windows Server runner，记录 19、20、24）、30 分钟合成负载（macOS，记录 23）、写盘与回放后续（记录 26、27）、合并前审计（记录 28）已完成；Windows 11 实机上自动检查、打包与发布包启动已通过（记录 29）。Windows 真实桌面观察、Defender 扫描、干净机器解压即用未完成 |

## 记录模板

```markdown
## NN — 标题

- 日期：YYYY-MM-DD
- harness：<小写，如 cursor-cloud-agent、cursor、codex、claude-code>
- model：<小写，只记厂商和系列、不写版本号，如 claude-opus、gpt-sol；不确定写 unknown>
- 提交：<hash 列表，或「本条所在提交」>
- 内容：做了什么（按小任务逐项列出）
- 验证：实际执行的命令/操作、平台与结果；未执行的写「未验证」
- 遗留：未完成项与已知限制
```

## 01 — 需求与核实

- 日期：2026-09-23（原记录未写日期，按初始提交时间补记）
- 模型：GPT（具体工具与版本未记录）
- 提交：`e28b592`（由仓库所有者作为初始提交推送）
- 内容：编写 `JEV_MONITOR_AGENT_PROMPT.md`；核对官方 TypeSafe 文档和参考宿主的接口、日志，结论写入 README；选择 Electron + React + TypeScript、JSONL、本地 HTTP 接收器及标准库 Python 发送器；实现 `src/` 下协议、存储、状态聚合、接收服务与脱敏。
- 验证：原记录未写明执行过的验证。后续审计时 `pnpm typecheck` 未通过，且无测试文件。
- 遗留：见 `docs/AUDIT.md` 2026-09-22 审计。

## 02 — 审计、跨平台策略与协作规范

- 日期：2026-09-22
- 模型：Cursor-Claude
- 提交：`7913c71`、`b5bf548`、`c35fed3`、`e3b081e`，以及本条所在的文档提交
- 内容：审计计划、结构与代码，结论见 `docs/AUDIT.md`。清理失效脚本与误提交的 pnpm store；修复类型错误、脱敏损坏候选数据、序号冲突静默丢弃、413 响应可能丢失、Windows 文件占用导致 503；新增核心测试与 Windows/Linux/macOS CI；在 prompt 中加入平台支持策略、协议身份规则、脱敏范围和 M0–M5 里程碑；新增 `AGENTS.md` / `CLAUDE.md` 协作与署名规范。
- 验证：Linux（Node 22.14.0、pnpm 11.19.0）上 `pnpm typecheck` 通过，`pnpm test` 9 项全部通过。GitHub Actions 运行 35762476343 在 windows-latest、ubuntu-latest、macos-latest 上 typecheck 与 test 均通过。未做任何桌面窗口验证（桌面壳尚未实现）。
- 遗留：`docs/AUDIT.md` 中 C6–C12；M1 剩余项；M2–M5 全部。

## 03 — 更正提交节奏；原生兼容、免额外组件与杀毒软件友好

- 日期：2026-09-22
- 模型：Cursor-Claude（Claude Opus 5.5）
- 环境：Cursor Cloud Agent（Linux 虚拟机）
- 提交：本条所在提交
- 内容：
  - 更正 02 对提交规则的误解：小任务 `git add` 暂存，大功能/大方向完成后 commit 并 push；云端 agent 会话结束前推送到自己的分支。02 的细粒度提交保留，不改写历史。更新 `AGENTS.md`、prompt、README。
  - 提交信息格式加入执行环境与具体模型名称：标题 `[署名]`，正文 `Agent-Model` / `Agent-Env`。
  - prompt 新增「原生兼容、免额外组件与杀毒软件友好」：用户无需安装任何运行时、无需管理员权限；运行时依赖只用纯 JS；签名、版本信息、禁用单文件自解压与加壳、运行时行为禁区、Electron fuses、Defender 扫描；各平台原生打包格式。验收与 M5 相应补充。
  - 新增 `tests/deps.test.ts`：检查运行时依赖及其传递依赖没有原生扩展和安装脚本。
- 验证：Linux 上 `pnpm typecheck` 通过，`pnpm test` 10 项全部通过。临时把 esbuild、electron 加入运行时依赖时，依赖检查能正确报错（已还原）。三平台 CI 结果见推送后的 GitHub Actions。
- 遗留：杀毒软件友好的各项要求要到 M5 打包时才能实际验证；其余同 02。

## 04 — 按运行位置区分署名方式

- 日期：2026-09-22
- harness：cursor-cloud-agent
- model：claude-opus-5.5
- 提交：本条所在提交
- 内容：按仓库所有者要求重写署名规则。Cursor 云端 agent 直接用 Cursor Agent 账号提交，不另写署名；本地开发在提交标题写 `[<harness>/<model>]`、正文写 `agent-harness` / `agent-model`，全部小写。实施记录模板改为 harness / model 两个小写字段。更新 `AGENTS.md`、prompt、README、`docs/AUDIT.md`。03 中 `Agent-Model` / `Agent-Env` 的格式作废，已有提交保留不改写。
- 验证：纯文档改动；`pnpm typecheck` 与 `pnpm test` 仍通过。
- 遗留：同 03。

## 05 — 模型只记厂商和系列

- 日期：2026-09-22
- harness：cursor-cloud-agent
- model：claude-opus
- 提交：本条所在提交
- 内容：按仓库所有者要求，model 字段只记厂商和模型系列、不写版本号（如 `claude-opus`、`gpt-sol`、`gpt-terra`）。更新 `AGENTS.md`、prompt、README 与实施记录模板。04 中的 `claude-opus-5.5` 按新规则应为 `claude-opus`，旧记录保留不改写。
- 验证：纯文档改动；`pnpm typecheck` 与 `pnpm test` 仍通过。
- 遗留：同 03。

## 06 — 全部远端分支方向审计（codex）

- 日期：2026-09-23
- harness：codex
- model：gpt-astra
- 提交：本条所在提交
- 内容：按仓库所有者要求审计 GitHub 全部 13 个现存分支、11 个开放 draft PR、提交依赖及各 HEAD 的 CI；新增根目录 `AGENT_DIRECTION_AUDIT.md`，登记 A1–A10、复现证据、建议集成顺序与验收门槛。在 `docs/AUDIT.md` 追加入口。只改审计文档，未合并功能分支、未改应用代码，里程碑表保持 main 的实际状态。其他未合并分支也有编号 06，集成时保留各条标题和历史，不覆盖。
- 验证：Linux，临时 Node 22.23.2 / pnpm 11.19.0；main 基线 typecheck 与 test 10/10 通过；P1-09 独立快照 typecheck、test 43/43、build 通过；P1-07 独立快照 Python 3.13.5 测试 16/16 通过。GitHub 上 13 个分支当前 HEAD 的三平台 core job 均成功，P1-07 六个 Python job 均成功。另有针对性临时探针和两组 merge-tree 试合并，详见根目录报告。本提交推送后的 CI 以本提交 Actions 为准。
- 遗留：报告问题尚未修复；所有功能 PR 仍待集成。未执行原生 Windows/macOS 窗口、可见延迟、30 分钟负载、打包或 Defender 验证。

## 07 — 集成前复核 13 个分支 HEAD

- 日期：2026-09-23
- harness：cursor-cloud-agent
- model：grok
- 提交：本条所在提交
- 内容：按记录 06 与 `AGENT_DIRECTION_AUDIT.md` 开工前重新 fetch。13 个分支中 P1-01、P1-07、P1-08、P1-09 的 HEAD 已前进，其余与报告一致。在审计报告文末追加「集成前 HEAD 复核」表，并在 `docs/AUDIT.md` 追加同一事实。原审计表与记录 06 不改写。尚未开始合并功能分支。
- 验证：`git fetch` 后用 `git rev-parse` 对照报告中的 13 个短 SHA。不一致的是 `cursor/p1-01-walking-skeleton-8677` `81e0117`、`cursor/p1-07-python-sender-52eb` `cc0981f`、`cursor/p1-08-demo-host-33a4` `de08926`、`cursor/p1-09-export-replay-973f` `dcf879c`。未跑测试，未打开每个 CI job。
- 遗留：功能集成、A1–A8 回归与闭环验收都还没做。A9 与 Windows 原生窗口、打包、Defender 留到集成分支合并之后。

## P1-00 — 格式化与边界守卫

- 日期：2026-09-22
- harness：cursor-cloud-agent
- model：grok
- 提交：`3e9c654`，以及本条所在提交
- 内容：
  - 用 `pnpm add -D prettier` 加入 Prettier 3.9.8。`.prettierrc.json` 为 singleQuote、semi、printWidth 120、trailingComma all、arrowParens avoid、bracketSpacing false。`.prettierignore` 排除 `node_modules/`、`dist/`、`release/`、`.runtime/`、`pnpm-lock.yaml`、`*.md`、`protocol/`、`fixtures/`。
  - scripts 增加 `format`（`prettier --write .`）和 `format:check`（`prettier --check .`）。
  - 一次性格式化现有 `src/*.ts` 与 `tests/*.ts`，不改逻辑。`tsconfig.json` 不在切片文件清单里，但 `prettier --check .` 会检查它，因此一并格式化（见 PR「需要协调」）。
  - 新增 `tests/boundaries.test.ts`：递归扫描 `src/**/*.{ts,tsx}`，违规报告 `文件:行号`。`process.platform` 只允许出现在 `src/paths.ts` 与 `src/main/platform.ts`。禁止 `child_process`（含 `node:child_process`）、`0.0.0.0`、`globalShortcut`、`openExternal`、`setLoginItemSettings`、`eval(`、`new Function(`、`dangerouslySetInnerHTML`、`fetch(`、`XMLHttpRequest`、`WebSocket`，以及 `http(s)://` URL。允许主机名为 `127.0.0.1` 的 URL，以及 `http://json-schema.org/draft-07/schema#`。
  - CI 在 typecheck 之前增加 `pnpm format:check`。
- 验证：Linux（Node 22.14.0、pnpm 11.19.0）上 `pnpm typecheck`、`pnpm test`（11 项）、`pnpm format:check` 通过。语义核对：用 TypeScript 解析格式化前后的源文件，展开括号后比较词法叶子，忽略空白、换行和尾随逗号；唯一额外记号是接口末成员补上的分号（`src/protocol.ts` 1 处、`src/state.ts` 3 处），不改变类型。临时在 `src/state.ts` 第 171–172 行加入 `process.platform` 与 `node:child_process` 后，边界测试失败并报告 `src/state.ts:171 process.platform`、`src/state.ts:172 child_process`，随后已还原。Windows / macOS 未在本机执行。
- 遗留：C6–C12 未在本切片处理。README 未改。三平台 CI 结果见本 PR 的 GitHub Actions。

## P1-01 — 可运行骨架：构建、IPC 契约、数据目录、最小窗口

- 日期：2026-09-22
- harness：cursor-cloud-agent
- model：grok
- 提交：本条所在提交
- 内容：
  - `resolveMonitorPaths` 解析 `home`、`eventsDir`、`sessionFile`、`windowStateFile`、`electronProfileDir`。win32 用 `path.win32`，其他平台用 `path.posix`。非空 `JEV_MONITOR_HOME` 优先；相对路径按注入的 `cwd`（默认 `process.cwd()`）拼接，不用 `path.resolve`。空字符串视为未设置。`XDG_STATE_HOME` 只在非空绝对路径时采用。非空 `JEV_MONITOR_SESSION` 覆盖会话文件，相对路径同样按 `cwd` 拼接。结果去掉尾部分隔符，以便和 Python `normpath` 一致。用例在 `tests/fixtures/paths-cases.json`（19 条）。
  - `src/ipc.ts` 定下通道名和 `MonitorBridge`：`snapshot`、`page`、`status`、`onChanged`、`setMode`、`setPinned`。`status.url` 只有 `http://127.0.0.1:<port>`，不含 token。
  - `EventStore.page` 在内存窗口内按 `runId` 和 `cursor < beforeCursor` 过滤，升序返回最后 `limit` 条；`limit` 默认 100，截到 1–500。
  - `detectPlatform`：win32 x64 为 tier 1，其他 Windows 架构为 tier 2；darwin 为 tier 2；Wayland（`XDG_SESSION_TYPE=wayland` 或非空 `WAYLAND_DISPLAY`）为 linux-wayland、tier 3、不可置顶；其余 Linux 为 linux-x11、tier 2；其他平台为 `other`、tier 3。各分支注释为未实机验证。
  - 主进程顺序：解析路径、把 `userData` 指到 `electron-profile`、单实例锁、`EventStore` + `startServer`（失败写入 `storageError` 仍开窗）、拒绝权限请求、创建窗口、注册 IPC。`event` 在 50 ms 内合并成一次 `monitor:changed`。所有平台在 `window-all-closed` 时退出，`before-quit` 时关闭接收端。
  - 窗口：紧凑 400×132、展开 440×640；`show:false`，`ready-to-show` 时 `showInactive()`；`alwaysOnTop`、有边框、标题 `JEV Monitor Bar`；`contextIsolation`、`sandbox`、禁止 node、禁止新窗口和导航。preload 只暴露上述 6 个方法。
  - 渲染进程占位：根节点 `#app-root` 带 `data-cursor` 和 `data-mode`；紧凑视图显示运行数、最新事件类型和是否在监听；展开视图显示「展开视图（待实现）」。`useMonitor` 挂载时拉 status 和 snapshot，变更刷新最多一个在途请求、结束后再补一次，两次至少间隔 100 ms；`runId` 变化立即刷新；`now` 每秒、status 每 5 秒。
  - `scripts/build.mjs` 清空 `dist/` 后用 esbuild 产出 `dist/main.cjs`、`dist/preload.cjs`、`dist/renderer/app.js` 和 `app.css`，并复制 `index.html`。`scripts/launch.mjs` 先构建，未设置 `JEV_MONITOR_HOME` 时用 `.runtime/dev`，再启动 Electron。`package.json` 增加 `build` 和 `start`。CI 在 test 之后增加 `pnpm build`。
- 验证：Linux（Node 22.14.0、pnpm 11.19.0、Electron 42.11.6、`DISPLAY=:1`、X11）上 `pnpm format:check`、`pnpm typecheck`、`pnpm test`（21 项）、`pnpm build` 通过。`pnpm start` 写出 `.runtime/dev/session.json` 并显示标题为 JEV Monitor Bar 的窗口；POST 一条 `run.started` 后，运行数从 0 变为 1、最新事件为 `run.started`（Playwright 测量从 POST 到 DOM 更新 72 ms；桌面录屏里同一窗口在画面中更新）。`window.monitor` 只有 `snapshot`、`page`、`status`、`onChanged`、`setMode`、`setPinned`，页面和 status 里没有 token，`url` 为 `http://127.0.0.1:<port>`。同一次启动里 `isAlwaysOnTop()` 为 true，`isFocused()` 为 false。Windows / macOS 窗口未验证。
- 遗留：窗口位置记忆、正式 UI、托盘未做。`EventStore` 构造失败时窗口仍打开，但不注册 IPC（没有 store 可绑）；仅接收端失败时会注册 IPC 并带上 `storageError`。Linux 窗口管理器把请求的 400×132 报成外框约 403×136。默认应用菜单仍在。C6–C12 未处理。README 未改。三平台 CI 见本 PR。

## P1-01 — 更正 macOS 相对路径测试

- 日期：2026-09-22
- harness：cursor-cloud-agent
- model：grok
- 提交：本条所在提交
- 内容：相对 `JEV_MONITOR_HOME` 且未注入 `cwd` 时，测试改为对照 `process.cwd()`，并用 `realpath` 确认仍落在临时目录里。macOS 的 `/var` 是指向 `/private/var` 的符号链接，`mkdtemp` 给出的字符串和 `process.cwd()` 不一致；解析本身仍按 `process.cwd()`，没有改规则。
- 验证：Linux 上 `pnpm test` 的 paths 用例通过。macOS CI 见本提交之后的 GitHub Actions。
- 遗留：同上一则 P1-01。

## P1-01 — 存储失败仍可显示，并收紧窗口生命周期

- 日期：2026-09-22
- harness：cursor-cloud-agent
- model：grok
- 提交：本条所在提交
- 内容：
  - `EventStore` 或接收端启动失败时仍注册六个 IPC 处理函数。没有 store 时 `snapshot` 返回 `{cursor:0, runs:[], events:[], corruptLines:0}`，`page` 返回 `[]`，`status` 带上真实的 `storageError`。参数和发送方仍先校验。上一则里「构造失败不注册 IPC」由此更正。
  - `registerIpc` / `createMonitorHandlers` 增加必填 `contents`（该窗口的 webContents）。处理函数要求 `event.sender === contents`、`event.senderFrame === contents.mainFrame`，并且 frame URL 与渲染页完全相同。`MonitorBridge` 和通道名没有变。可测试的逻辑在 `src/main/ipc-api.ts`，不导入 Electron。
  - 先创建窗口并挂上 `ready-to-show` 与导航拒绝，注册 IPC 之后再 `loadFile`。
  - 有接收端时，第一次 `before-quit` 调用 `preventDefault`，等 `close()` 结束后再 `app.quit()`；没有接收端时不拦截。
  - 会话文件写入失败时关闭已监听的端口和连接再抛出。`listen` 成功后移除临时 `error` 监听，避免吞掉之后的服务器错误。
  - POSIX 只去掉 `path.posix.sep`。共享用例增加「posix trailing backslash is part of the name」：`/tmp/name\` 保持原样，`sessionFile` 为 `/tmp/name\/session.json`。用例现为 20 条。
  - 选中运行只有一个 id，同时用于查询和视图属性。还没收到该 id 的快照时隐藏 `run` 和 `events`，保留 `runs`、`cursor`、`corruptLines`。
  - `setMode` / `setPinned` 等待结果：成功采用返回值，失败则刷新 `status` 或回滚，并显示错误。进行中的命令不会被 status 轮询盖掉。
  - status 与 snapshot 的错误分开记录，各自在对应请求成功后清除。`runId` 变化后，已停止的请求不再写入错误。
- 验证：Linux（Node 22.14.0、pnpm 11.19.0、Electron 42.11.6、`DISPLAY=:1`）上 `pnpm format:check`、`pnpm typecheck`、`pnpm test`（27 项）、`pnpm build` 通过。Playwright 打开窗口：正常目录下标题为 JEV Monitor Bar，`window.monitor` 恰好 6 个方法，`status.url` 为 `http://127.0.0.1:<port>`，没有红色错误；把 `events` 做成文件后，窗口显示同一条 `EEXIST` `storageError`，snapshot 仍是空的且未在监听。Windows / macOS 窗口未验证。
- 遗留：窗口位置记忆、正式 UI、托盘未做。Linux 窗口管理器尺寸和默认菜单同上一则 P1-01。C6–C12 未处理。README 未改。

## P1-01 — --fresh 只删除本仓库的运行时目录

- 日期：2026-09-23
- harness：cursor-cloud-agent
- model：grok
- 提交：本条所在提交
- 内容：`scripts/launch.mjs` 的 `--fresh` 只删除本仓库 `.runtime/dev` 或 `.runtime/demo`。候选路径先收成仓库下的词法尾部，再用 `realpath` 和 `lstat` 确认中间没有符号链接指向别处；对不上就拒绝删除并退出，不删除任意 `JEV_MONITOR_HOME`。判断在 `scripts/fresh-runtime.mjs`，测试在 `tests/launch-fresh.test.ts`。本分支没有演示宿主。
- 验证：Linux（Node 22.14.0、pnpm 11.19.0）上 `pnpm format:check`、`pnpm typecheck`、`pnpm test`（35 项）、`pnpm build` 通过。Windows / macOS 见本 PR 的 GitHub Actions。
- 遗留：同上一则 P1-01。符号链接检查与删除之间仍有替换窗口。

## P1-02 — 核心健壮性（C6 / C7 / C9）

- 日期：2026-09-22
- harness：cursor-cloud-agent
- model：grok
- 提交：本条所在提交
- 内容：
  - C6：重启恢复时，`JSON.parse` 成功且 `cursor` 为安全整数的行计入高水位，即使 schema 或信封校验失败；完全无法解析的行只计入 `corruptLines`，不抬高 cursor。下一条写入使用高水位加 1。
  - C7：内存中的 run 超过 200 时，先淘汰 `ended_at` 已设置且 `last_received` 最早的一个；没有已结束的 run 时，再淘汰 `last_received` 最早的一个。`last_received` 相同则保留先插入的 run。
  - C9：新增 `src/session.ts`。`writeSessionFile` 先创建目录，写入 `<file>.<pid>.<随机hex>.tmp`（mode 0600），再 `rename` 覆盖目标；遇到 `EPERM`/`EBUSY`/`EACCES` 时最多再试 5 次，第 n 次前用 `Atomics.wait` 等待 20×n ms；失败则删除临时文件后抛错。成功后总是尝试 `chmod` 0600。`readSessionFile` 在文件缺失、JSON 损坏或 `url`/`token` 不是字符串时返回 `undefined`。`removeSessionFileIfOwned` 只在文件中的 token 与传入值一致时删除。`startServer` 改用 `writeSessionFile`；`close()` 在 server 关闭后调用 `removeSessionFileIfOwned`。写入失败时沿用 P1-01：关掉已监听的端口和连接再抛出，并且 `listen` 成功后移除临时 `error` 监听。
- 验证：Linux（Node 22.14.0、pnpm 11.19.0）上 `pnpm format:check`、`pnpm typecheck`、`pnpm test`（28 项，含边界测试）、`pnpm build` 通过。POSIX 上把已有 0644 会话文件重写后断言为 0600（本机 Linux 执行了该断言）。`renameSync` 用 mock 连续抛出两次 `EPERM` 后成功。Windows / macOS 未在本机执行，三平台 CI 见本 PR。
- 遗留：C8、C10–C12 未处理。Windows 上 `mode` 和 `chmod` 不改变 ACL，会话文件仍依赖用户目录权限。`last_received` 相同时保留先插入的 run（规格未规定并列）。非 `EPERM`/`EBUSY`/`EACCES` 的 rename 错误不重试，但会删除临时文件再抛错，避免 token 留在 `.tmp`。README 未改。

## P1-02 — 接上 P1-01 生命周期，并容错删除会话文件

- 日期：2026-09-22
- harness：cursor-cloud-agent
- model：grok
- 提交：本条所在提交
- 内容：
  - rebase 到 `cursor/p1-01-walking-skeleton-8677` 的 `c5a3a18`。`docs/IMPLEMENTATION.md` 保留 P1-01 与 P1-02 两段记录。
  - `startServer` 保留 P1-01 的命名 `error` 监听：`listen` 成功后移除；`writeSessionFile` 失败时关闭端口和连接再抛出。没有用旧的永久 `once('error')` 盖掉这段。
  - `removeSessionFileIfOwned` 在确认 token 后删除。`EPERM`/`EBUSY`/`EACCES` 最多再试 5 次，每次重试前重新读文件；token 已变或文件消失（`ENOENT`）就停止。读文件本身被锁住时同样重试，耗尽后抛错。
  - `armQuit` 接住 `close()` 的拒绝，调用 `recordCleanupFailure` 把消息并进 `storageError` 并 `console.warn`，然后仍然 `quit`。回调自己抛错时也只告警，不留下未处理拒绝。
- 验证：Linux（Node 22.14.0、pnpm 11.19.0）上 `pnpm format:check`、`pnpm typecheck`、`pnpm test`（38 项）、`pnpm build` 通过。会话发布失败会关掉监听；稍后的 `error` 事件不再被启动监听吞掉。删除重试、`ENOENT`、token 变化和退出时清理失败仍 quit 均有测试。Windows 文件锁用 mock，未在 Windows 实机占用文件。三平台 CI 见本 PR。
- 遗留：同上一则 P1-02。退出时的 `storageError` 只留在进程内状态；窗口正在退出，界面不一定来得及刷新。

## P1-03 — 协议制品：JSON Schema、协议文档与模拟场景

- 日期：2026-09-22
- harness：cursor-cloud-agent
- model：grok
- 提交：本条所在提交
- 内容：
  - `scripts/export-schema.ts` 与 `pnpm schema:export`：把 `src/protocol.ts` 的 `schema` 写成 `protocol/event.schema.json`（`JSON.stringify(schema, null, 2)` 加换行）。
  - `docs/PROTOCOL.md`：按当前接收、存储、状态聚合和脱敏代码写协议说明。数据目录只列需求里的默认位置，并写明路径解析尚未实现。
  - `fixtures/scenarios/`：7 个模拟场景（normal、dispersed、rule-override、retry、verify-failed、reconnect、concurrent），每个文件一条 run。
  - `tests/protocol-artifacts.test.ts`：schema 文件与代码一致；每个场景逐行 `validateEvent` 后写入新的 `EventStore`，状态与 `index.json` 的 `expect` 一致。
- 验证：Linux（Node 22.14.0、pnpm 11.19.0）上 `pnpm schema:export`、`pnpm typecheck`、`pnpm test` 通过，12 项测试全部通过。Windows / macOS 未在本机执行，交给 CI。未做桌面窗口验证。
- 遗留：演示播放属于 P1-08；README 里的协议文档链接留给 P1-10。`verify-failed` 不发送 run 终态，run 状态停在 `verification_failed`。`pause_after_index` 从 0 起算，不暂停的场景为 `null`；`reconnect` 的 `pause_ms` 为 35000。P1-00 尚未合并，新的 TypeScript 按计划中的 Prettier 选项排过版，没有改既有文件的格式，也没有把 Prettier 加进依赖。

## P1-04 — 桌面壳与平台模块（窗口行为、位置记忆、多显示器）

- 日期：2026-09-22
- harness：cursor-cloud-agent
- model：grok
- 提交：本条所在提交
- 内容：
  - `platformProfile` 返回 `{alwaysOnTopLevel:'floating', showInactive:true}`。macOS 的 `visibleOnAllWorkspaces` 与 `visibleOnFullScreen` 为 true，Windows、Linux X11、Linux Wayland 和其他平台为 false。各分支注释写明平台和验证状态。
  - `window-state.ts` 不导入 Electron。`loadWindowState` 在文件缺失、JSON 损坏、版本不是 1 或形状不对时返回 `undefined`。`saveWindowState` 先写 `<file>.<pid>.<hex>.tmp`（mode 0600），再 `renameSync`；`EPERM` / `EBUSY` / `EACCES` 重试 5 次，第 n 次前用 `Atomics.wait` 等 20×n ms，仍失败则删掉临时文件并抛错，成功后 `chmodSync(file, 0o600)`。`fitToDisplays` 看窗口顶部 32px 条带：与某个 workArea 横向重叠至少 64px 且纵向相交时保留坐标，并把宽高截到该 workArea 内（重叠更大的显示器优先）；否则在主显示器 workArea 里居中，主显示器不在列表中时用第一块屏。坐标保持 DIP，不乘 `scaleFactor`。`switchMode` 只改当前模式的 bounds。
  - 窗口默认紧凑 400×132（最小 360×96）、展开 440×640（最小 360×320）。启动读保存的状态，两种模式都经 `fitToDisplays` 校正。安全设置与 P1-01 相同；`ready-to-show` 时 `showInactive()`。置顶时 `setAlwaysOnTop(true, 'floating')`；仅当 profile 要求时再 `setVisibleOnAllWorkspaces(true, {visibleOnFullScreen:true})`。Wayland 仍走同一调用，限制说明留在 `detectPlatform` 的 notes。`move` / `resize` 防抖 500ms 后写入两种模式各自的 bounds，以及 `screen.getDisplayMatching` 的 id 和缩放。`setMode` 先记下当前模式的 bounds，再套用另一模式并设置对应最小尺寸。`display-removed` 与 `display-metrics-changed` 时重新 fit 并移动。页面仍由 `loadMonitorWindow` 在 `registerIpc({contents})` 之后加载。
  - `index.ts` 只把 `paths.windowStateFile` 传给 `createMonitorWindow`。
- 验证：Linux VM（Ubuntu 24.04.4，内核 6.12.94+，XFCE / xfwm4，`DISPLAY=:1`，1920×1200，Electron 报告 `scaleFactor` 0.984375，Node 22.14.0，pnpm 11.19.0，Electron 42.11.6）上 `pnpm format:check`、`pnpm typecheck`、`pnpm test`（43 项）、`pnpm build` 通过。启动后活动窗口仍是 Desktop，窗口带 `_NET_WM_STATE_ABOVE`。拖到约 (182,243) 并缩到约 469×184 后，`window-state.json` 记下紧凑 bounds，展开 bounds 仍是 440×640。`setMode('expanded')`、取消置顶再置顶、再回到紧凑后，两边 bounds 都没有被对方盖掉，`status.platform.os` 为 `linux-x11`。退出再打开，JSON 与退出前完全一致，活动窗口仍是 Desktop，置顶原子仍在。另开一个 `xmessage` 并让它获得焦点后，小窗仍画在它上面；展开后标题下可见「展开视图（待实现）」。Windows / macOS 窗口未验证。Wayland 未实机验证。
- 遗留：本机 `setBounds(getBounds())` 会按约 `1/scaleFactor` 把窗口放大，所以 show 之后 250ms 以及本进程自己的 `setBounds` 引起的几何事件不写入文件，保存的是请求的 DIP 矩形；用户拖动仍写入当时的 `getBounds`。因此视觉像素和文件里的 DIP 差几个像素，但重启不会越变越大。取消置顶时若 profile 打开了所有工作区，会再调用 `setVisibleOnAllWorkspaces(false)`。关闭窗口时会立刻把尚未防抖落盘的状态写完。没有历史文件时，两种模式都先放到屏幕外再居中，避免默认 (0,0) 被当成已经落在主屏上。README 未改。Windows、macOS 窗口未验证。

## P1-04 — 校正分数缩放下的位置回声

- 日期：2026-09-22
- harness：cursor-cloud-agent
- model：grok
- 提交：本条所在提交
- 内容：
  - 上一则把「重启不会越变越大」说早了。用户只移动窗口时，`getBounds()` 仍比刚应用的矩形大约 6px，下一次启动会把这个放大后的尺寸再存回去。审计在本机用 4 次「启动 → `windowmove` → 退出」从 400×132 放大到 422×155。
  - `boundsEcho` 记录 `getBounds()` 与刚应用到窗口的矩形之差。`userRect` 保存时减掉这个差。`move` 只改 x/y，`resize` 才改宽高。show 之后 250ms 以及每次 `applyBounds` 后再量一次回声，这段时间不再丢掉用户拖动；同步回声仍靠 `applying` 忽略。Linux X11 的回声可能要等窗口映射完才稳定；Windows / macOS 通常在 `setBounds` 里面就报出来。
  - `display-metrics-changed` / `display-removed` 只对已保存的 DIP 矩形做 `fitToDisplays`，结果与当前矩形不同才 `setBounds`。
  - 最小化、最大化或全屏时不把当时的 `getBounds()` 写入；退出时改读 `getNormalBounds()` 再减回声。窗口同时 `maximizable:false`、`fullscreenable:false`。
  - `setAlwaysOnTop` 改到 `ready-to-show` 才调用，不再在显示前先调一次。`setVisibleOnAllWorkspaces` 只在置顶状态真正变化、且该平台 profile 要求时调用。macOS 仍未实机验证。
  - `platform.ts` 里 Linux X11 的注释收窄为：置顶与不抢焦点已在 Linux VM 验证。位置恢复不写进那句注释。
- 验证：Linux VM（Ubuntu 24.04.4，XFCE / xfwm4，`DISPLAY=:1`，`scaleFactor` 0.984375，Electron 42.11.6）上 `pnpm format:check`、`pnpm typecheck`、`pnpm test`、`pnpm build` 通过。四轮探针（全新目录，每轮启动后 `xdotool windowmove`，等防抖写入，再 `SIGTERM`）：紧凑尺寸依次为 400×132、401×133、400×132、400×133，相对初始 400×132 的偏差不超过 1px，没有再按每轮约 6px 累加。展开 bounds 保持 440×640。Windows / macOS / Wayland 未验证。
- 遗留：P2-06 清单请加：Windows 上最小化、最大化、还原后再重启；macOS 上启动和切换置顶时不闪 Dock、不激活，以及全屏 Space 之上是否可见。`'floating'` 在 macOS 全屏应用之上往往不够，是否改用更高等级要协调者决定，这次没有改规格。README 未改。

## P1-05 — 紧凑模式 UI

- 日期：2026-09-22
- harness：cursor-cloud-agent
- model：grok
- 提交：本条所在提交
- 内容：
  - 新增 `compactModel(snapshot, status, now)`。任务名截断到 40 字；模拟数据、运行状态文字和颜色、连接状态来自已有的 `common` 纯函数。阶段取 `progress.phase`，没有则为「未知」。进度在有 `total` 时为 `completed/total`，只有 `completed` 时为「已完成 N 步」，否则为「未知」。运行时长从 `started_at` 到 `ended_at`，没有结束时间则到 `now`。
  - 最新选择按 `later()` 取最新 decision：评估中为「正在评估候选」；失败为「失败」；Choice 显示 choice；Score 显示分数，有 legend 时附等级名（精确键，否则四舍五入到整数等级，再否则取数值最近的等级）；Noul 显示「是 N%」（`Math.round(noul * 100)`）。
  - 实际动作为最新 attempt 的 `selected.payload.action`，来源标为「模型 / 规则 / 应用」。与对应 decision 的 choice 不同时标「已覆盖」。执行状态用该 attempt 的状态文字和颜色。最近事件取 `run.latest` 的发生时间和类型（心跳和丢弃计数本来就不进 `latest`）。其他未结束 run 的数量单独计数；下一个 run 按 `snapshot.runs` 顺序在未结束 run 中循环。
  - `CompactView` 四行：状态点加文字、任务名、模拟徽标、连接、「置顶」「展开」；阶段 · 进度 · 时长；选择 → 动作 · 执行状态；最近事件，另有运行时显示「另有 N 个运行」并可切换。没有 run 时显示「等待宿主连接…」和接收端状态。`storageError` 为红色行，平台 notes 为一行「提示：…」。长文本用 CSS 截断，`title` 为全文。`data-testid`：`compact-root`、`compact-status`、`compact-run-name`、`compact-connection`、`compact-choice`、`compact-action`、`compact-exec-status`、`compact-expand`、`compact-pin`。
  - 未改 `App.tsx`、`common.ts` 和构建脚本。`compact.css` 由 `CompactView` 引入，现有 esbuild 会打进 `app.css`。
- 验证：Linux（Node 22.14.0、pnpm 11.19.0、Electron 42.11.6、`DISPLAY=:1`、X11；`XDG_SESSION_TYPE` 与 `WAYLAND_DISPLAY` 均为空）上 `pnpm format:check`、`pnpm typecheck`、`pnpm test`（32 项，含边界测试）、`pnpm build` 通过。构建后用 Playwright 启动 Electron，向会话文件里的本机地址 POST 两条模拟 run。内容区约 403×107，四行都在视口内（末行 bottom 87）。界面为：状态「执行中」、任务名「模拟：整理季度报告」、「模拟数据」、连接「在线」、「汇总 · 2/5 · 1分09秒」、「打开完整报告 → 打开摘要 · 规则 · 已覆盖 · 执行中」、最近事件 `action.started`、「另有 1 个运行」。浅色背景 `rgb(246, 247, 249)`，深色背景 `rgb(20, 23, 28)`，合成截图在 Project 存储 `media/p1-05-compact-bar.png`。Windows / macOS 窗口未验证。
- 遗留：README 未改。展开视图仍是占位。分数小数落到 legend 等级、Noul 百分比取整、失败决策文案、下一个 run 的循环顺序，见本 PR「需要协调」。默认紧凑窗口内容区只有约 107px，错误行和平台提示靠单行省略号塞进剩余高度，超长提示不会换行。

## P1-05 — 跟随当前选择，覆盖只看关联决策

- 日期：2026-09-22
- harness：cursor-cloud-agent
- model：grok
- 提交：本条所在提交
- 内容：
  - rebase 到 P1-01 `c5a3a18`。`docs/IMPLEMENTATION.md` 的冲突保留「存储失败仍可显示」和「紧凑模式 UI」两段记录。
  - `compactModel` 增加 `selectedRunId`。已指定选择时只用该 id 的完整 run 或摘要；详情还没到时不回退到另一个 run，列表里也没有该 id 时显示「正在读取」。未指定选择时仍用 `snapshot.run`，否则 `pickDefaultRun`。
  - 「已覆盖」只比较最新 attempt 的 `decision_id` 所指向的 decision。没有关联，或该 decision 不是带 choice 的 Choice 时，不标覆盖。最新选择的展示仍按 `later()` 取最新 decision。
- 验证：Linux（Node 22.14.0、pnpm 11.19.0）上 `pnpm format:check`、`pnpm typecheck`、`pnpm test`（40 项，含边界测试）、`pnpm build` 通过。三平台 CI 见本提交之后的 GitHub Actions。Windows / macOS 窗口未验证。
- 遗留：同上一则 P1-05。Windows / macOS 窗口未验证。

## P1-06 — 展开模式：决策详情、执行与时间线

- 日期：2026-09-22
- harness：cursor-cloud-agent
- model：grok
- 提交：本条所在提交
- 内容：
  - `src/renderer/expanded/model.ts` 提供 `runSummary`、`decisionCards`、`decisionChain`、`attemptGroups`、`timelineItems`。决策卡按时间倒序，最多 50 张。Choice 未完成时概率为「未知」、标题为「正在评估候选」；完成后按概率从高到低排列。Score 在 legend 刻度上标位置，有概率则附上。Noul 只显示「是」的概率，不显示 confidence。confidence 仅在有值且不是 Noul 时写成「分布集中度 0.62（不是正确率）」。
  - 决策链省略缺失环节。规则覆盖为 `JEV 选择 A → 规则覆盖为 B（规则 X · 来源 Y） → 实际执行 B → 验证：失败`。不带 `decision_id` 且 `source` 为 rule 的 `action.selected` 单独成卡，徽标「规则决策」，链里不出现 JEV。
  - 执行页按 `action_id` 分组，组内按时间编号「第 N 次」，并表格展示验证 checks。摘要里的验证计数写明分母，并同时写出失败与未知：`验证成功 2 / 已验证 3；验证失败 1；未知 0；未验证 1`。进度规则与 P1-05 相同，阶段单独显示。
  - 时间线默认跟随最新，向上滚动后暂停并显示「已暂停跟随 · N 条新事件 · 回到最新」；暂停不停止接收。最多渲染 500 条。「加载更早」调用 `bridge.page({runId, beforeCursor, limit: 100})`。筛选「仅错误与重试」包含 `*.failed`、验证结果 failed、`telemetry.dropped`，以及同一动作的第二次及以后 attempt。发生时间与接收时间相差超过 5 秒标「迟到」。点击后用 `<pre>` 纯文本显示 `JSON.stringify(event, null, 2)`。概率条宽度用 React `style`，不插入 `<style>`。
  - 未改 `App.tsx`、`common.ts`。有 `storageError` 时展开视图用红色行显示。
- 验证：Linux（Node 22.14.0、pnpm 11.19.0、Electron 42.11.6、`DISPLAY=:1`；`XDG_SESSION_TYPE` 与 `WAYLAND_DISPLAY` 均为空，按 X11）上 `pnpm format:check`、`pnpm typecheck`、`pnpm test`（30 项，含边界测试）、`pnpm build` 通过。Playwright 启动 Electron，POST 模拟事件后切到展开模式。决策页 DOM 中选中项为「A 已选」，概率更高的 B 未标已选；时间线只有 1 个「迟到」。向上滚动后按钮为「已暂停跟随 · 0 条新事件 · 回到最新」，再 POST 一条 heartbeat 后变为「已暂停跟随 · 1 条新事件 · 回到最新」。内存窗口已含全部事件时「加载更早」变为「没有更早的事件」。截图：决策页 `/cursor/stores/bc-01a0ca4b-ddb2-7f09-8eb1-b447ce56da3c/media/p1-06-expanded-view.png`，执行页 `media/p1-06-tab-execution.png`，时间线 `media/p1-06-tab-timeline.png`。Windows / macOS 窗口未验证。
- 遗留：连接状态（在线 / 可能断开）只在紧凑模式规格里，展开摘要未重复，需要协调是否补上。计划示例的决策链在全角右括号和箭头之间没有空格（`）→`），实现在每个箭头两侧都留了空格（`） →`）。验证摘要比示例多写了「验证失败」和「未知」，避免失败被藏进分母。Score / Noul 的链分别是「JEV 评分」「JEV 判断 是 xx%」，示例只写了 Choice 的「JEV 选择」。`source: application` 不另造覆盖文案，只保留「实际执行」。README 未改。三平台 CI 见本 PR。

## P1-06 — 修正跨 run 分页、同值规则链和重试筛选

- 日期：2026-09-22
- harness：cursor-cloud-agent
- model：grok
- 提交：本条所在提交
- 内容：
  - 把分支 rebase 到 `cursor/p1-01-walking-skeleton-8677` 的 `c5a3a18`。`docs/IMPLEMENTATION.md` 的冲突保留 P1-01 审计修正和 P1-06 两段记录。
  - 「加载更早」记下请求时的 runId 和 epoch。run 改变或卸载后丢弃旧的 `page()` 响应，合并前再丢掉 `run_id` 不一致的事件。
  - Choice 的规则动作与 JEV 选择相同时不再写成「规则覆盖」，只保留「实际执行」。动作不同时仍写覆盖。
  - 「仅错误与重试」用 `laterAttemptKeys(run)`，按运行里全部 attempt 判断第二次及以后，不再只看当前已加载事件。
  - 组件测试需要 DOM，因此用 `pnpm add -D jsdom` 增加开发依赖。运行时依赖没有变。
- 验证：Linux（Node 22.14.0、pnpm 11.19.0）上 `pnpm format:check`、`pnpm typecheck`、`pnpm test`（38 通过）、`pnpm build` 通过。组件测试用延迟的 `page()`：切到另一个 run 并 resolve 后不出现原 run 的事件，切回去也不出现；同一次响应里别的 run 的事件被丢掉。Windows / macOS 窗口未验证。
- 遗留：同上一则 P1-06。三平台 CI 见本 PR。

## P1-07 — Python 发送器（仅标准库）

- 日期：2026-09-22
- harness：cursor-cloud-agent
- model：grok
- 提交：本条所在提交
- 内容：
  - `python/jev_monitor/paths.py` 的 `resolve_paths` 与 `src/paths.ts` 使用同一套规则，并复用 `tests/fixtures/paths-cases.json`。`win32` 用 `ntpath`，其他平台用 `posixpath`。返回 `home`、`events_dir`、`session_file`、`window_state_file`。
  - `MonitorSender` 只用标准库。`emit` 用 `put_nowait`，不阻塞、不抛异常。后台守护线程按会话文件发送；401、连接失败或没有会话时保留当前事件，从 0.5 秒起翻倍退避，上限 5 秒。409 记为 conflict 和 dropped 并告警，不重试。400 与 413 记为 rejected 和 dropped。队列满时丢弃并计入 `telemetry.dropped`，恢复后先发这条再发积压事件。超过 `heartbeat_interval` 没有成功发送时自动发 `heartbeat`。`close` 在超时内尽量发完，支持 `with`。`enabled=False` 时方法为空操作。
  - `python/examples/fake_host.py` 依次发送正常完成、规则覆盖、失败后重试、验证失败四个模拟运行，名称都以「模拟：」开头。
  - CI 新增 `python` job：`windows-latest` / `ubuntu-latest` / `macos-latest` × Python 3.9 / 3.13，运行 `python -m unittest discover -s python/tests -v`。
- 验证：
  - Linux（Python 3.12.3）上 `python -m unittest discover -s python/tests -v` 11 项通过，连续再跑 5 次仍通过。没有接收端时 1000 次 `emit` 约 6–18 ms。
  - Linux（Node 22.14.0、pnpm 11.19.0）上 `pnpm format:check`、`pnpm typecheck`、`pnpm test`（21 项）、`pnpm build` 通过。
  - 同一台 Linux 上用真实 `EventStore` + `startServer` 跑 `fake_host.py`：4 个运行共 37 条事件全部 `sent`，状态为 completed、completed、completed、failed，且 `simulated` 为 true。
  - Linux VM（`DISPLAY=:1`、Electron 42.11.6、X11）上 `pnpm start` 后运行 `JEV_MONITOR_HOME=.runtime/dev python3 python/examples/fake_host.py`。窗口从「运行数 0 / 最新事件 无 / 监听 是」变为「运行数 4 / 最新事件 run.failed / 监听 是」。
  - 本机没有 Python 3.9。Windows / macOS 未在本机执行，见本 PR 的 GitHub Actions。
- 遗留：根 README 未改（留给 P1-10）。规格没写明的 HTTP 状态码按连接失败重试，见 PR「需要协调」。Python 3.9 在 `macos-latest` 上能否装上，以 CI 为准。

## P1-07 — 会话 URL 只允许 127.0.0.1

- 日期：2026-09-22
- harness：cursor-cloud-agent
- model：grok
- 提交：本条所在提交
- 内容：
  - rebase 到 `c5a3a18`。实施记录保留 P1-01 的窗口生命周期更正和上一则 P1-07。
  - 会话 `url` 必须是 `http://127.0.0.1` 或带合法端口的同一主机，路径只能为空或 `/`。带用户名、查询串、片段、其他路径、`localhost`、IPv6 或其他主机都视为离线，不发请求。上一则里「忽略代理」仍保留，作为额外限制。
  - `queue_size` 必须是大于等于 1 的整数，`timeout` 和 `heartbeat_interval` 必须大于 0，否则构造时抛出 `ValueError`。不再把非正队列静默变成全部丢弃。
  - 成功入队后被 409 或 400/413 拒绝的事件也计入下一条 `telemetry.dropped`。参数不合法、没有入队的调用仍然只计入 `stats().dropped`。`telemetry.dropped` 自己被拒绝时不再排下一条，避免死循环。
- 验证：Linux（Python 3.12.3）上 `python -m unittest discover -s python/tests -v` 16 项通过。Linux（Node 22.14.0、pnpm 11.19.0）上 `pnpm format:check`、`pnpm typecheck`、`pnpm test`（27 项）、`pnpm build` 通过。Windows / macOS 见本提交之后的 GitHub Actions。
- 遗留：根 README 仍留给 P1-10。`python/README.md` 写了参数范围和 URL 限制。序号可以先于积压事件到达这一点，审计认为接收端可以接受，本切片没有改。

## P1-07 — 坏负载不终止发送线程，并拒绝重定向

- 日期：2026-09-23
- harness：cursor-cloud-agent
- model：grok
- 提交：本条所在提交
- 内容：
  - 入队前把事件编码成不可变的 UTF-8 JSON。`set`、循环引用、无法用 UTF-8 表示的字符串，或编码后大于 65536 字节（与接收端 64 KiB 上限相同）时丢弃该条，只计入 `dropped`，不占用序号，也不进入 `telemetry.dropped`。调用返回后再改 payload 不会改变已入队的字节。队列里若仍有无法编码的事件，工作线程丢掉该条并继续，而不是退出。
  - 事件 POST 对 301/302/303/307/308 一律不跟随 `Location`，避免标准库把 `Authorization` 复制出去。会话 URL 仍只接受 `http://127.0.0.1`。
- 验证：Linux（Python 3.12.3）上 `python -m unittest discover -s python/tests -v` 20 项通过，连续再跑 2 次仍通过。Linux（Node 22.14.0、pnpm 11.19.0）上 `pnpm format:check`、`pnpm typecheck`、`pnpm test`（27 项）、`pnpm build` 通过。Windows / macOS 与 Python 3.9 / 3.13 见本提交之后的 GitHub Actions。
- 遗留：根 README 仍留给 P1-10。重定向期间当前事件按未分类状态重试，不记为 rejected。

## P1-08 — 演示：`pnpm demo` 与 Node 模拟宿主

- 日期：2026-09-23
- harness：cursor-cloud-agent
- model：grok
- 提交：本条所在提交
- 内容：
  - 分支基于 P1-05（紧凑条才能显示「可能断开」），并合并 P1-03 的场景文件。`package.json` 保留 `schema:export`，并增加 `demo` 与 `demo:host`。
  - `scripts/demo-host.mjs`：`--fast`、`--once`、`--home`、`--scenario`。等待会话文件和 `GET /health` 最多 20 秒。会话 URL 只接受 `http://127.0.0.1`。按 `index.json` 顺序播放；每个场景重写 `run_id`、`producer_id`、从 1 开始的 `sequence`、`event_id` 和 `occurred_at`。同一毫秒内的事件时间戳加 1 毫秒，避免序号字符串比较把终态排乱。事件间隔为 `delay_ms`，`--fast` 时为 0。`pause_after_index` 之后暂停 `pause_ms`（`--fast` 时为 0），暂停期间不另发心跳。`ECONNREFUSED` 和 401 重读会话并退避重试（200 ms 起，上限 5 秒）。400、409 以及其他 HTTP 错误打印后以退出码 1 结束。
  - `scripts/launch.mjs`：`--demo` 把 `JEV_MONITOR_HOME` 设为 `.runtime/demo`；`--fresh` 先删掉该目录。Electron 启动后用同一环境启动演示宿主；Electron 退出时结束宿主，宿主非 0 退出时结束 Electron。
- 验证：Linux（Node 22.14.0、pnpm 11.19.0）上 `pnpm format:check`、`pnpm typecheck`、`pnpm test`（43 项）、`pnpm build` 通过。`--fast --once` 在 15 秒内跑完 7 个场景，最终状态与 `index.json` 的 `expect` 一致。桌面窗口上的「可能断开」见本条之后的补充（若还没有，则尚未验证）。Windows / macOS 窗口未验证。
- 遗留：README 未改。本分支包含尚未合并的 P1-03 与 P1-05，PR 基线是 P1-05 分支。`docs/PROTOCOL.md` 仍写着路径解析未实现，那是 P1-03 的原文，本切片不改。

## P1-08 补充 — 审计修复：序号、回环、超时与断线录屏

- 日期：2026-09-23
- harness：cursor-cloud-agent
- model：grok
- 提交：本条所在提交
- 内容：
  - 每个场景新建 `producer_id`，该场景的 `sequence` 从 1 递增。同一 producer 不再把序号打回 1。
  - 会话 URL 只接受 `http://127.0.0.1` 的 origin：拒绝用户名、密码、非根路径、查询和片段，保存 `url.origin`。
  - `GET /health` 与 `POST /events` 都使用 `redirect: 'manual'`。健康检查把 3xx 当作未就绪；事件的 3xx 和其他非 401 状态打印后以退出码 1 结束，不访问重定向目标。
  - 健康检查的单次请求用剩余截止时间做超时，20 秒到点就退出。事件 POST 超时 5 秒，超时后按连接失败重试。
  - `occurred_at` 改为发送当时的时间。同一 producer 的先后由 `sequence` 决定。上一则里「加 1 毫秒以免序号字符串比较把终态排乱」不成立，本条更正。
- 验证：Linux（Node 22.14.0、pnpm 11.19.0、Electron 42.11.6、`DISPLAY=:1`、X11；`XDG_SESSION_TYPE` 与 `WAYLAND_DISPLAY` 均为空）上 `pnpm format:check`、`pnpm typecheck`、`pnpm test`（51 项）、`pnpm build` 通过。`pnpm demo` 放到 reconnect 暂停时，紧凑条先显示「N 秒无新事件」，随后变为「可能断开 · 最后更新 …」，暂停结束后连接恢复为「在线」（下一条场景「模拟：并发决策」）。录屏在 PR #11。Windows / macOS 窗口未验证。
- 遗留：README 未改。本分支仍包含尚未合并的 P1-03 与 P1-05。

## P1-08 补充 — `--fresh` 只删除仓库内的运行时目录

- 日期：2026-09-23
- harness：cursor-cloud-agent
- model：grok
- 提交：本条所在提交
- 内容：
  - `scripts/runtime-fresh.mjs`：`--fresh` 只允许删除本仓库的 `.runtime/dev` 或 `.runtime/demo`。删除前用 `lstat` 拒绝路径上的符号链接，再用 `realpath` 确认目标仍是这两个目录之一。对不上就抛错，不调用 `rm`。
  - `scripts/launch.mjs`：目录按仓库根解析，不再用当前工作目录的 `path.resolve('.runtime/...')`，也不再删除继承来的 `JEV_MONITOR_HOME`。`pnpm demo` 把 `JEV_MONITOR_HOME` 和 `JEV_MONITOR_SESSION` 固定到 `.runtime/demo` 与其中的 `session.json`。未加 `--demo` 且已有外部 home 时，`--fresh` 拒绝删除并退出。
  - `scripts/demo-host.mjs`：会话文件固定为 home 下的 `session.json`，不再读取继承的 `JEV_MONITOR_SESSION`。重定向、每个场景的序号和 20 秒就绪超时没有改。
- 验证：Linux（Node 22.14.0、pnpm 11.19.0）上 `pnpm format:check`、`pnpm typecheck`、`pnpm test`（57 项）、`pnpm build` 通过。Windows / macOS 未在本机执行，交给 CI。未做桌面窗口验证。
- 遗留：README 未改。本分支仍包含尚未合并的 P1-03 与 P1-05。

## P1-09 — 导出与回放

- 日期：2026-09-23
- harness：cursor
- model：grok
- 提交：本条所在提交
- 内容：
  - 本条由 Cursor 云端 agent 完成。git 作者沿用环境里已经设好的 Cursor Agent（`cursoragent@cursor.com`），没有改 `user.name` / `user.email`，提交信息里也不另加署名。
  - 分支从 `cursor/p1-06-expanded-view-9f65` 拉出，没有改 P1-04 或其他开放分支。保存对话框挂在当前窗口的 `webContents` 上，不依赖 P1-04 的位置记忆模块。
  - 新增 `src/replay.ts`：`parseReplay` 只接收校验和脱敏函数，不导入 `node:*`。按行解析，兼容 `\r\n` 和文件开头的 BOM。普通事件缺少 `received_at` / `cursor` 时，用 `occurred_at` 和 1 起的行号补上。先校验再脱敏，坏行计数，最多保留 20000 条。`replaySnapshot` 用 `applyEvent` 重放到第 N 条，去重和 200 个 run 的淘汰与 `EventStore` 一致。
  - IPC 只新增 `monitor:export`、`monitor:open-replay`。`exportEvents` 弹出保存框，默认文件名 `jev-monitor-export-<YYYYMMDD-HHMMSS>.jsonl`，写入 `store.exportLines()`。`openReplay` 只打开 `.jsonl`，超过 50 MiB 拒绝。取消对话框时导出返回 `{saved:false}`，回放返回 `null`。
  - 展开视图增加「导出」「打开回放」。回放横幅为「回放：<文件名>（不影响实时接收）」，有进度条、上一条、下一条、播放/暂停、1×（800 ms/条）和 10×（80 ms/条）。三个页签复用 P1-06 的组件。退出回放回到实时视图。回放期间实时接收继续，时间线分页不读实时存储。
- 验证：Linux（Node 22.14.0、pnpm 11.19.0）上 `pnpm format:check`、`pnpm typecheck`、`pnpm test`（43 项，含原先 38 项）通过，`pnpm build` 通过。同一环境 Electron 42.11.6、`DISPLAY=:1`：POST 三条模拟事件后切到展开模式，导出 923 字节的 JSONL（含「演示任务」），再打开该文件。横幅为「回放：jev-monitor-export-check.jsonl（不影响实时接收）」，位置从「第 3 / 3 条」变为「第 2 / 3 条」，`#app-root` 的 `data-cursor` 仍是 3。截图：展开页 `/opt/cursor/artifacts/p1-09-expanded.png`，回放页 `/opt/cursor/artifacts/p1-09-replay.png`。Windows / macOS 窗口未验证。
- 遗留：P1-04 尚未并入本分支，多显示器位置记忆不在这次里。回放时间线的「加载更早」只查当前回放前缀，不查实时库。播放间隔是实现选择，计划没有写毫秒数。README 未改。三平台 CI 见本 PR。

## P1-09 — 修正超过 200 个运行的空白回放，以及更早事件分页

- 日期：2026-09-23
- harness：cursor
- model：grok
- 提交：本条所在提交
- 内容：
  - 本条由 Cursor 云端 agent 完成，仍在 `cursor/p1-09-export-replay-973f` 上，不另开 PR。git 作者沿用环境里的 Cursor Agent，没有改 `user.name` / `user.email`。
  - 未指定运行时，`replaySnapshot` 每个事件都把焦点移到该事件的运行，这样超过 200 个运行、最旧的被淘汰后，打开文件仍落在还在的运行上。指定的运行已经不在窗口里时，不再把事件滤成那个 id。
  - 回放运行选择器在 `snapshot.runs` 非空时就显示，包括当前焦点运行已经不在前缀里的情况；没有焦点时用 `pickDefaultRun` 作为选择器的值。
  - 「加载更早」改为对播放头之前的回放前缀分页（同一 `runId`、`cursor < beforeCursor`、按 cursor 排序、取最后 `limit` 条，`limit` 截到 1–500），不调用实时 bridge，也不调用 `EventStore.page`。时间线先只收到该运行最近 400 条，和实时快照一样。
  - `parseReplay`：缺少 `cursor` 仍用 1 起的行号，缺少 `received_at` 仍用 `occurred_at`。字段在但 `cursor` 不是安全整数（含小数），或 `received_at` 不是字符串，记为无效行并跳过。空字符串 `received_at` 保留。负的安全整数仍保留。
- 验证：Linux（Node 22.14.0、pnpm 11.19.0）上 `pnpm format:check`、`pnpm typecheck`、`pnpm test`（49 项）通过，`pnpm build` 通过。Windows / macOS 窗口未验证。三平台 CI 见本 PR。
- 遗留：主进程仍同步读取未超过 50 MiB 的回放文件。50 MiB 边界没有走真实 `readBounded` 的临时文件测试。`replaySnapshot` 仍在 `src/replay.ts`。播放间隔未改。README 未改。

## P1-09 — 导出改为逐行校验并脱敏

- 日期：2026-09-23
- harness：cursor
- model：grok
- 提交：本条所在提交
- 内容：
  - 本条由 Cursor 云端 agent 完成，仍在 `cursor/p1-09-export-replay-973f` 上，不另开 PR。git 作者沿用环境里的 Cursor Agent，没有改 `user.name` / `user.email`。
  - `exportLines` 不再把分段文件原文拼在一起。每一段单独按行解析（去掉 BOM 和行尾 `\r`），校验通过后用 `sanitizeEvent(..., false)` 脱敏并丢掉 `diagnostic`，再写成自带换行的一行。损坏行、残缺行尾、以及已出现但不是安全整数的 `cursor` 都跳过，并在返回值 `skipped` 里计数。
  - `monitor:export` 把 `skipped` 交给界面。成功导出时，跳过数大于 0 会写在「已导出 …」后面。
  - 回放决策链和时间线仍用展开视图的 `decisionChain` / `TimelineTab`，本分支没有另写一份。超过 200 个运行的焦点、回放前缀分页、以及非整数 `cursor` 的拒绝都保持上一则的行为。
- 验证：Linux（Node 22.14.0、pnpm 11.19.0）上 `pnpm format:check`、`pnpm typecheck`、`pnpm test`（50 项）通过，`pnpm build` 通过。Windows / macOS 窗口未验证。三平台 CI 见本 PR。
- 遗留：同上一则。导出仍同步读取全部分段。README 未改。

## 08 — 集成 P1-00 至 P1-09

- 日期：2026-09-23
- harness：cursor-cloud-agent
- model：grok
- 提交：本条所在提交。合并提交：`c8f35b9`、`23ccdc9`、`c84b582`、`95aa9ef`、`25485d3`、`dc1c510`、`afd3e53`、`f3ed986`、`94d6ce5`、`258ca02`
- 内容：在 `cursor/integrate-mvp-83b9`（起点 `e594e36`）上按固定 SHA `git merge`，不 cherry-pick。未合并 `9537853`。没有改 A1–A10 的产品逻辑，也没有改写记录 01–07。
  - `32e2439` P1-00（PR #2）→ `c8f35b9`。冲突：`docs/IMPLEMENTATION.md`。保留记录 01–07，并追加 P1-00。
  - `81e0117` P1-01（PR #4）→ `23ccdc9`。无冲突。祖先里的 P1-00 已在历史上，没有重放。
  - `46bc2b2` P1-02（PR #5）→ `c84b582`。冲突：`docs/IMPLEMENTATION.md`。`docs/AUDIT.md` 自动合并：C6/C7/C9 的处理栏追加 P1-02 说明，main 上的问题、codex 审计附录和记录 07 的 HEAD 复核都还在。
  - `98a719a` P1-03（PR #3）→ `95aa9ef`。冲突：`docs/IMPLEMENTATION.md`、`package.json`。脚本取并集，加入 `schema:export`。`docs/PROTOCOL.md`、`protocol/event.schema.json`、fixtures 采用 P1-03。
  - `b74a7c2` P1-04（PR #9）→ `25485d3`。冲突：`docs/IMPLEMENTATION.md`。`src/main/index.ts` 自动合并，同时有 P1-02 的退出生命周期和 `windowStateFile`。
  - `fcf974d` P1-05（PR #6）→ `dc1c510`。冲突：`docs/IMPLEMENTATION.md`。紧凑条是 `src/renderer/compact/`。
  - `8256599` P1-06（PR #7）→ `afd3e53`。冲突：`docs/IMPLEMENTATION.md`。展开视图是 `src/renderer/expanded/`。`package.json` 并入 `jsdom`，并保留已有脚本。
  - `cc0981f` P1-07（PR #8）→ `f3ed986`。冲突：`docs/IMPLEMENTATION.md`。CI 保留三平台 typecheck/test/build/format:check，以及 Python 3.9 与 3.13。
  - `de08926` P1-08（PR #11）→ `94d6ce5`。冲突：`docs/IMPLEMENTATION.md`、`package.json`、`scripts/launch.mjs`。`scripts/fresh-runtime.mjs` 与 `scripts/runtime-fresh.mjs`，以及 `tests/launch-fresh.test.ts` 与 `tests/runtime-fresh.test.ts` 都留下。启动用 `applyLaunchEnv`：`pnpm demo` 把 `JEV_MONITOR_HOME` 和 `JEV_MONITOR_SESSION` 固定到仓库内 `.runtime/demo`。`--fresh` 先经 `freshRuntimeTarget` / `removeFreshRuntime`，再经 `deleteFreshRuntime(home, repoRoot)`；自定义 HOME 和外指符号链接都不删。两套实现还没收成一份。
  - `dcf879c` P1-09（PR #12）→ `258ca02`。冲突：`docs/IMPLEMENTATION.md`。`src/store.ts` 自动合并：P1-02 的 cursor 高水位、run 淘汰和会话恢复还在，P1-09 逐行校验、脱敏、跳过损坏行的 `exportLines` 也在。没有用回放分支的占位紧凑条覆盖 P1-05。
  - 仓库里原来没有 `docs/STATUS.md`。放入 `9537853` 的历史快照，并在文末追加更正：快照里「8 个 PR、P1-08/09 未开工」只代表写入当时，不能当派工依据。快照原文未删。
- 验证：Linux（Node 22.14.0、pnpm 11.19.0）上 `pnpm install` 报告锁文件已一致；`pnpm typecheck` 通过；`pnpm test` 116 项通过；`pnpm format:check` 通过。同一台机器 Python 3.12.3 上 `python -m unittest discover -s python/tests` 20 项通过。未跑 Python 3.9 / 3.13。未做原生 Windows / macOS 窗口、可见延迟、30 分钟负载、打包或 Defender。三平台 CI 以本提交推送后的 Actions 为准。
- 遗留：A1–A10 未修。`--fresh` 两套实现并存。M5 未开始。原生 Windows、打包、Defender 未完成。

## A10 — 更正协议与审计里过时的集成描述

- 日期：2026-09-23
- harness：cursor-cloud-agent
- model：grok
- 提交：本条所在提交
- 内容：只改文档，不改 `src/`、`python/`、`scripts/`，也不改应用行为。记录 01 到记录 08 未改写。
  - `docs/PROTOCOL.md` 按当前代码改写：cursor 高水位在 `JSON.parse` 成功且 `cursor` 为安全整数时计入，即使 `validateEvent` 失败；无法解析的行只计 `corruptLines`。会话写入改为临时文件再 `rename`，POSIX `chmod` 0600，`EPERM`/`EBUSY`/`EACCES` 会重试。`resolveMonitorPaths` 的路径规则已落地。`usage` 的非数字值由入口 `dictionary(num)` 拒绝整条事件。run 淘汰改为最多 200 个，优先结束且 `last_received` 最早的。补上 `exportLines` 的逐行校验、脱敏、丢掉 `diagnostic` 和损坏行计入 `skipped`。会话 URL 以接收端只听 `127.0.0.1` 和 Python 发送端的 loopback 校验为准。
  - `docs/AUDIT.md` 只追加。C6 原行保留，并写明 P1-02 与集成分支仍没有完全 torn 行的高水位。
  - `docs/STATUS.md` 在已有「快照过时」更正之后再追加一句：集成分支已包含 P1-08 与 P1-09，快照原文仍保留。
  - 里程碑表只把 M1 的文档更正和「A1–A9 未修、闭环验收未做」写进去。M5、原生 Windows、打包、Defender 仍是未完成。
- 验证：对照 `src/store.ts`、`src/session.ts`、`src/paths.ts`、`src/protocol.ts`、`src/server.ts`、`python/jev_monitor/sender.py` 和 `tests/boundaries.test.ts` 核对句子。未改应用代码，未重跑 `pnpm typecheck` / `pnpm test`。未做进程重启、凭证轮换、队列补发的闭环验收，也未做 30 分钟负载、原生 Windows 窗口、打包或 Defender。三平台 CI 通过不等于原生窗口已验收。
- 遗留：完全无法 `JSON.parse` 的尾行仍没有高水位。演示 reconnect 若只是停发几十秒，并不等于验证了进程重启、凭证轮换和队列补发。P1-00 的边界守卫只扫描 `src` 里的 TypeScript 字符串，不覆盖 Python 重定向，也不能证明发布包不联网。M5 未开始。原生 Windows、打包、Defender 未完成。A1–A9 未修。

## 09 — 核对并补齐 Python 发送器 A2、A3 的验收断言

- 日期：2026-09-23
- harness：cursor-cloud-agent
- model：grok
- 提交：本条所在提交
- 内容：起点 `8e1eb65`。`cc0981f` 已经在入队前做不可变 UTF-8 JSON、超过 65536 字节丢弃，并用 `_RejectRedirect` 拒绝 301/302/303/307/308。对照 A2、A3 验收后没有改 `python/jev_monitor/sender.py`，也没有改 `python/README.md`。这次新加的只有测试断言：
  - `test_queue_overflow_counts_dropped`：离线且队列满之后，工作线程仍存活；再 `emit` 200 次都返回 false、计入 `dropped`，并且在 0.2 秒内返回。
  - `test_event_post_does_not_follow_redirects`：相对 `Location`（302，`/exfil`）和绝对 `Location`（301/303/307/308，`http://127.0.0.1:<port>/exfil`）上，没有任何一次请求带 Bearer。原先的 `POST /events` 仍带会话 token。日志里出现 `retrying status=<code>`，用来确认投递失败被记下。
  - 坏 payload（set、循环引用、无法用 UTF-8 编码的字符串）、emit 后修改嵌套对象、超大 body、队列里混入无法编码的事件，原有测试已经覆盖，这次没有改这些用例的预期。
- 验证：Linux，系统 Python 3.12.3，`python3 -m unittest discover -s python/tests -v`，20 项通过（约 15 秒）。测试只访问 `127.0.0.1`。未跑 Python 3.9 / 3.13，未跑 Windows / macOS，未跑 `pnpm`。
- 遗留：重定向仍按未分类状态重试，不记入 `rejected`。队列只限制条数和单条 64 KiB，没有队列总字节上限。丢弃时仍在调用线程打警告，慢日志 handler 仍可能拖住 `emit`。相对 Location 只在 302 上覆盖，绝对 Location 覆盖其余四个状态码。

## 10 — 接入展开视图修正：选择不写成已执行

- 日期：2026-09-23
- harness：cursor-cloud-agent
- model：grok
- 提交：本条所在提交。来源：`edad472`（`cursor/p1-06-expanded-view-9f65`，PR #7）
- 内容：集成分支当时停在 P1-06 的 `8256599`，没有 `edad472`。仅有 `action.selected` 仍写成「实际执行」，时间线也只能看最近 500 条，所以不是已有的等价修复。用 `git merge edad472` 把该提交接进来，没有另写一份。记录号用 10，因为同一时段的 Python 验收断言已经占用 09。
  - 决策链只把选定写成「应用选择/待执行」；有 `action.started` 才写「执行中」；`action.completed` 且尚未验证写「已执行待验证」；失败与取消分别写「执行失败」「执行取消」。验证结果只在有 `verification.completed` 时追加。`source: application` 且与 Choice 不同时写「应用覆盖为 B」，不写规则名或来源。与 Choice 相同则不写覆盖。`source: rule` 且动作不同时仍写「规则覆盖为 B（规则 X · 来源 Y）」。
  - 时间线仍最多渲染 500 条。跟随最新时窗口在末尾；「加载更早」先在已加载事件里把窗口前移，到已加载的起点才向 `page()` 要更早的 100 条。暂停跟随时记住当前视口里的事件，之后的快照即使不再包含这些行，视口和已选详情也不跳走。`page` 的 IPC 结果改为 `{events, truncated}`。该 run 的事件曾被移出内存窗口，且这次更早分页为空时，`truncated` 为 true，按钮写「更早的事件已超出保留窗口」。
  - 冲突在 `docs/IMPLEMENTATION.md`、`src/main/ipc-api.ts`、`src/store.ts`。保留 P1-09 逐行校验并脱敏的 `exportLines`，并加上 `historyTruncated`。回放的 `pageReplay` 仍只读播放头之前的前缀，桥接成 `{events, truncated: false}`，空页写「没有更早的事件」，不把回放文件的截断说成内存窗口淘汰。
- 验证：Linux（Node 22.14.0、pnpm 11.19.0）上 `pnpm format:check`、`pnpm typecheck`、`pnpm test`（123 通过）、`pnpm build` 通过。未再启动 Electron 窗口。Windows / macOS 未在本机执行。三平台 CI 以本提交推送后的 Actions 为准。
- 遗留：同记录 08。展开视图的连接状态、决策链空格和 README 仍未改。

## 09 — 导出空段与回放焦点

- 日期：2026-09-23
- harness：cursor-cloud-agent
- model：grok
- 提交：本条所在提交
- 内容：在 `cursor/fix-replay-a5-a7-83b9`（起点 `8e1eb65`）上处理 A5、A6、A7。未改 `src/renderer/expanded/model.ts` 和 `TimelineTab`。记录 01–08 未改写。
  - A5/A6：`exportLines` 仍按段逐行解析、`sanitizeEvent(..., false)`、跳过损坏行并计数，没有改回原文拼接。无末尾换行的有效段已由 `export redacts secrets and keeps one validated event per line` 里的第二段覆盖。该夹具补上一份夹在两段有效事件之间的空段；后一段仍在导出里。脱敏没有放宽。
  - A7：`replaySnapshot` 在请求的焦点不在剩余 run 里时，用 `pickDefaultRun` 选一个仍在的 run。返回的 `run` 属于 `runs`，事件列表只含这个 run。前缀里一个 run 都没有时，`run` 仍为空，界面才显示「尚未回放到事件」。
  - 淘汰收成 `src/state.ts` 的 `selectRunToEvict`。已结束的 run 里丢掉 `ended_at` 最早的，否则丢掉 `last_received` 最早的；时间相同则保留先出现的。`EventStore.evictRun` 和 `replaySnapshot` 都调用它。实时存储原先用 `last_received` 给已结束 run 排序，现与这条规则对齐。
- 验证：Linux（Node 22.14.0、pnpm 11.19.0）上 `pnpm typecheck` 通过；`pnpm exec tsx --test tests/replay.test.ts tests/store-recovery.test.ts` 16 项通过。未跑完整 `pnpm test`。未做原生 Windows / macOS 窗口、可见延迟、30 分钟负载、打包或 Defender。
- 遗留：A1–A4、A8–A10 未在本分支处理。导出仍同步读取全部分段。回放主进程仍同步读取未超过 50 MiB 的文件。未做原生 Windows / macOS 窗口、可见延迟、30 分钟负载、打包或 Defender。

## A8 — 收成一份 --fresh

- 日期：2026-09-23
- harness：cursor-cloud-agent
- model：grok
- 提交：本条所在提交
- 内容：启动只删除一次，两套保护都还在。`freshRuntimeTarget` 先拒绝和本次目标不一致的自定义 `JEV_MONITOR_HOME`，不删除仓库外的目录。通过后只调用 `deleteFreshRuntime`：删除前用 `lstat` 拒绝路径上的符号链接，再用 `realpath` 确认目标是本仓库 `.runtime/dev` 或 `.runtime/demo`。对不上就抛错，不调用 `rm`。指向仓库外的符号链接和它外面的目录都保持原样。`removeFreshRuntime` 仍按原词法路径和符号链接规则拒绝，实际删除改为调用 `deleteFreshRuntime`。`applyLaunchEnv` 不变：`pnpm demo` 只在返回给子进程的环境里把 `JEV_MONITOR_HOME` 和 `JEV_MONITOR_SESSION` 设到 `.runtime/demo` 与其中的 `session.json`，不改写原来的外部会话文件。普通 `pnpm demo`（带 `--fresh`）仍会清掉仓库内 `.runtime/demo` 再启动。
- 验证：Linux（Node 22.14.0、pnpm 11.19.0）上 `pnpm typecheck` 通过；`pnpm exec tsx --test tests/launch-fresh.test.ts tests/runtime-fresh.test.ts tests/demo-host.test.ts` 24 项通过。未做 Windows / macOS。
- 遗留：符号链接检查与删除之间仍有替换窗口。A1–A7、A9、A10 未在本分支处理。

## 11 — 闭环验收，并放宽队列满的墙钟上限

- 日期：2026-09-23
- harness：cursor-cloud-agent
- model：grok
- 提交：本条所在提交
- 内容：没有合并 `cursor/fix-expanded-a1-a4-83b9` 的 `c7f46d0`。它的基线不是集成分支的祖先，三方差异会碰到已经接入的 `TimelineTab`、`{events, truncated}` 和 `historyTruncated`。集成分支上的 A1/A4 仍是记录 10 的 `edad472`：选择写「应用选择/待执行」，`started` 写「执行中」，`completed` 且未验证写「已执行待验证」，`source: application` 写「应用覆盖为」，不编造规则来源。`c7f46d0` 用的是「待执行 / 应用改选为」，没有接进来。
  - `test_queue_overflow_counts_dropped` 的 200 次满队列 `emit` 上限从 0.2 秒改为 2.0 秒。记录 09 的原文不改。Windows 上 Python 3.13 的 CI（提交 `e5ca5c8`，run `35819183951`）测到 0.57 秒，断言失败；同一次里其余 core 与 Python 作业通过。默认 HTTP `timeout` 是 0.5 秒，200 次若堵在工作线程上大约是 100 秒。2 秒仍要求调用方不等待这次投递。线程存活、返回 false、`dropped` 计数没有放宽。
- 验证：Linux（`DISPLAY=:1`，X11，Electron 42.11.6）上对当时的 `b5d2897` 执行 `pnpm demo`（`node scripts/launch.mjs --demo --fresh`），启动命令没有 API key。会话文件由接收端写到仓库内 `.runtime/demo/session.json`。演示宿主经 HTTP 写入 7 个场景：正常完成、概率分散、规则覆盖、失败后重试、验证失败、断线恢复、并发决策；同一轮里都能在 `events-00000001.jsonl` 里对上。窗口标题为 JEV Monitor Bar。
  - 紧凑条与展开视图都停在「闭环：只选择」。展开决策链为「JEV 选择 A → 应用覆盖为 B → 应用选择/待执行 B」。紧凑条状态与执行状态都是「已选择」，最新事件是 `action.selected`，没有写成已执行或成功。
  - 「闭环：完成未验证」的状态是「已执行待验证」，摘要为「验证成功 0 / 已验证 0；验证失败 0；未知 0；未验证 1」，决策链为「JEV 选择 go → 已执行待验证 go」。没有显示验证成功。
  - 时间线滚离底部后是「已暂停跟随 · 0 条新事件 · 回到最新」，视口第一条仍是 `run.started`。暂停期间再 POST 5 条 `heartbeat`，文件从 740 行增到 745 行，按钮变为「已暂停跟随 · 5 条新事件」，并写「正在查看较早事件（46 条）」，第一条仍是 `run.started`。
  - 导出保存为 `/tmp/jev-closed-loop-export.jsonl.jsonl`（对话框在名字后加了过滤后缀），289272 字节、770 行。其中 `password=hunter2` 变成 `password=[REDACTED]`，文件里没有 `hunter2`。接收端入库时已经写成脱敏后的正文，原始 JSONL 同样没有 `hunter2`。窗口提示「已导出 jev-closed-loop-export.jsonl.jsonl」。
  - 打开该文件回放，横幅为「回放：jev-closed-loop-export.jsonl.jsonl（不影响实时接收）」，位置停在「第 770 / 770 条」。回放期间 POST `run.started`「闭环：回放期间仍在接收」得到 `{"accepted":true,"cursor":903}`，事件文件增到 903 行，横幅仍是回放。退出回放后紧凑条回到「闭环：完成未验证 / 已执行待验证」。再向该 run POST 一条 `heartbeat` 后，连接从「可能断开」变为「在线」，最新事件为 `heartbeat`，执行状态仍是「已执行待验证」。
  - 同一会话上用系统 Python 3.12.3 运行 `python python/examples/fake_host.py`（`JEV_MONITOR_HOME` 指向 `.runtime/demo`）。四个场景 `sent` 分别为 10、8、11、8，`dropped=0`，`offline=False`。事件文件里的 `producer_id` 前缀是 `fake-host-`，终态分别是 `run.completed`、`run.completed`、`run.completed`、`run.failed`。当时窗口仍停在先前手选的 run，没有自动改选到这四条。
  - 同一工作树在改这处断言之前，`pnpm format:check`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm schema:export`（协议与 `event.schema.json` 无差异）和系统 Python 3.12 的 unittest 已通过。Python 3.9.25 与 3.13.15（uv）的 `unittest discover` 也已通过。本条只改 Python 测试的时限后，再跑 3.9、3.12、3.13 的 unittest。未把这次 Linux Electron 窗口写成 Windows 或 macOS 原生验收。
- 遗留：A9 的 30 分钟负载、Windows 原生置顶与 DPI、打包、Defender 留到本分支合并之后。GitHub Actions 在 `b5d2897` 上全部作业未启动，注解是账户付款失败或支出上限，不是测试失败。`e5ca5c8` 的 Windows Python 3.13 失败就是上面的 0.2 秒断言。本条推送后的三平台 CI 以 Actions 为准；CI 通过也只表示 build、纯函数和 DOM，不是原生窗口已验收。`c7f46d0` 未合并。

## 12 — 公开仓库后重跑 Actions 的方式

- 日期：2026-09-23
- harness：cursor-cloud-agent
- model：grok
- 提交：本条所在提交
- 内容：仓库所有者已把 `lawchli/jev-monitor-bar` 改为 public。`8eb0e25` 的 push run `35820950738` 和 pull_request run `35820954146` 没有被重跑成功。当时 9 个作业都在 2–7 秒内失败，runner 为空，步骤为空，注解是账户付款失败或支出上限。本环境的 GitHub App 令牌没有 Administration，也没有 Actions 写权限：`gh run rerun` 和 `POST /repos/lawchli/jev-monitor-bar/actions/runs/35820950738/rerun` 都返回 403 `Resource not accessible by integration`。没有空提交。
  - 重跑这两次旧 run 需要仓库所有者，或带 Actions 写权限的身份：`gh run rerun 35820950738 --repo lawchli/jev-monitor-bar`，以及 `gh run rerun 35820954146 --repo lawchli/jev-monitor-bar`。也可以在这两个 run 的页面上选择 Re-run all jobs。
  - 本条 push 会按 `.github/workflows/ci.yml` 的 `push` 和 `pull_request` 再启动一次 ci。作业仍是 Windows、Ubuntu、macOS 的 core（`format:check`、`typecheck`、`test`、`build`）和 Python 3.9 / 3.13。
- 验证：`gh repo view lawchli/jev-monitor-bar --json visibility,isPrivate` 得到 `visibility` 为 `PUBLIC`、`isPrivate` 为 false。重跑接口未执行成功。这次 push 之后的 CI 以 Actions 上的新 run 为准，本条不把它们写成已通过。
- 遗留：A9 的 30 分钟负载、Windows 原生置顶与 DPI、打包、Defender 仍留到 PR #14 合并之后。PR #14 仍是 draft，未合并。CI 通过也只表示 build、纯函数和 DOM，不是原生窗口、30 分钟负载、打包或 Defender 已验收。

## 13 — 记下 b6ce074 的三平台 CI

- 日期：2026-09-23
- harness：cursor-cloud-agent
- model：grok
- 提交：本条所在提交
- 内容：记录 12 的 push 启动了新的 ci。提交 `b6ce074` 上 push run `35829372457` 与 pull_request run `35829375092` 都成功。各 9 个作业都有 runner，并且步骤跑完：Windows、Ubuntu、macOS 的 core 通过 `pnpm format:check`、`pnpm typecheck`、`pnpm test`、`pnpm build`；同一三个系统上 Python 3.9 与 3.13 的 `python -m unittest discover -s python/tests -v` 通过。没有改产品代码。
- 验证：以上作业的结论来自 GitHub Actions API，runner 名非空，对应步骤结论为 success。这次通过只表示 build、纯函数和 DOM。没有把 Windows 或 macOS 原生窗口、置顶、DPI、30 分钟负载、打包或 Defender 写成已验收。
- 遗留：A9 的 30 分钟负载、Windows 原生置顶与 DPI、打包、Defender 仍留到 PR #14 合并之后。PR #14 在本条之后改为可审阅，不在这里合并进 main。

## 14 — CI 去掉重复运行，仓库改为公开

- 日期：2026-09-30
- harness：claude-code
- model：claude-opus
- 提交：`011046e`、`05df30e`、`f834d64`（分支 `claude/m5-integration`，起点 `826c5a8`）
- 内容：
  - 仓库在记录 12 之后又变回私有。私有仓库的 Actions 分钟按 macOS 10 倍、Windows 2 倍计，原来每次推送功能分支会同时触发 push 与 pull_request，9 个作业跑两遍。改为 push 只在 main 上触发、PR 只走 pull_request，同一 ref 的新运行取消旧运行，保留 `workflow_dispatch`。Python 矩阵从 6 个作业减到 4 个：Linux 跑 3.9 与 3.13，Windows 与 macOS 只跑 3.9。
  - 按仓库所有者要求，用 `gh repo edit --visibility public` 把仓库改为公开。改之前扫过全部分支的历史：没有提交过 `.env`、证书或私钥文件，`.env.example` 只有注释掉的占位；按常见 key、token、私钥格式检索全部 diff，没有命中。仓库仍没有许可证。
  - 新增 `package-windows` 作业（记录 18）与 `smoke` 作业（记录 19）。
  - `.gitignore` 加 `.claude/worktrees/`：Claude Code 的并行 agent 把 worktree 放在仓库里，prettier 会扫到它们。
  - 里程碑表 M1 一行更正为 A1–A8 已修、闭环验收已做。
- 验证：`gh repo view --json visibility` 为 `PUBLIC`。改过的 `ci.yml` 通过 `prettier --check`。这些作业在 Actions 上的结果以推送后的运行为准，本条不写成已通过。
- 遗留：公开仓库没有许可证，别人可以看但无权复用，由仓库所有者决定。

## 15 — A1/A4/A7 验收测试，并结论 c7f46d0

- 日期：2026-09-30
- harness：claude-code
- model：claude-opus
- 提交：`ee37fa4`（分支 `claude/m5-a1-a4-review`，起点 `826c5a8`），合并 `a352a23`
- 内容：
  - 按审计 A1、A4、A7 的验收逐条写 `tests/audit-acceptance.test.ts`（9 项）。测试走真实 `EventStore`、`page` IPC，并在 jsdom 里渲染 `ExpandedView` 与 `ReplayView`。在 `826c5a8` 上 3 项未通过，其余 6 项通过。
  - A1：`action.completed` 后已有 verification 时，决策链仍写「已执行待验证 X → 验证：失败」，和 PROTOCOL.md「已执行待验证＝尚未验证」矛盾，demo 场景都会出现。改为有验证写「已执行 X」；没有终态却有验证时省略执行环节。`expanded-model` 测试里两处链文案随之更新。
  - A4：快照只带最近 400 条，暂停时新增 600 条只显示「400 条新事件」。`TimelineTab` 新增 `eventCount`，展开视图和回放都传 `run.event_count`。
  - A4：回到最新后，读历史时留下的旧行和最新快照之间缺一段，跟随的尾部静默跳过事件（实测 702…1800 中间缺 802–1400）。回到最新或滚回尾部时丢掉历史行，重置「没有更早的事件」判断，并丢弃在途的更早分页。
  - A7：201 个 run 的回放焦点有效；选中的 run 被淘汰后仍可改选；退回到该 run 开始前再前进可恢复。未改代码。
  - c7f46d0（`cursor/fix-expanded-a1-a4-83b9`）：同一组测试在它的导出上只过了 A1 验证文案和 A4 平稳刷新两项。一次快照带来 600 条时仍只数到 400；不区分超出保留窗口；基于 A7 修复之前的 `8e1eb65`。唯一独有的语义（有验证不写待验证）已移植，结论是被取代，可关闭。
- 验证：macOS 27 arm64、Node 22.23.2、pnpm 11.19.0：`pnpm format:check`、`pnpm typecheck`、`pnpm test`（134 通过）、`pnpm build` 通过。视口不跳按「渲染行不变且 scrollTop 零写入」判断，未测像素位置。合并进 `claude/m5-integration` 后在同一台机器上重跑，134 项通过。
- 遗留：实时模式下显式选中的 run 被淘汰后，展开视图显示「正在读取运行…」且选择器保留；回放则回落到其他 run。两者口径不同，未统一。回到最新后重新阅读历史需要重新分页。

## 16 — 接入文档、协议补充与集成后的 README

- 日期：2026-09-30
- harness：claude-code
- model：claude-opus
- 提交：`a092cea`（分支 `claude/m5-docs`，起点 `826c5a8`），合并 `c18f976`
- 内容：
  - 新增 `docs/INTEGRATION.md`：会话文件、平台路径与 `JEV_MONITOR_HOME` / `JEV_MONITOR_SESSION`、`pnpm start` 用 `.runtime/dev`、只走 127.0.0.1、监视器离线与 token 轮换、会话文件权限；Python 发送器用法与失败隔离；一次决策闭环的事件顺序（Choice / Score / Noul、多问题、规则直接决策、规则与应用覆盖、重试、稳定 ID、验证）；不要发送的内容；直接发 HTTP 的请求格式与每个状态码的处理，Node 与 curl 示例；时钟与顺序（C11、C8）；残行 cursor（C6）；不接 TypeSafe 的试法。
  - `docs/PROTOCOL.md` 文末追加「补充（2026-09-30）」：`Bearer ` 前缀实际可省、路径全等与 Content-Type 大小写、Node 的 408、`received_at` 不参与排序、残行 cursor 可能复用且没有 fsync、桌面端没有诊断开关。前文不改。
  - `README.md` 改写现状、功能、安装运行、平台验证表（只按实施记录写）、数据目录与保留、会话文件权限、未签名说明、限制；「已核实的边界」原文保留。
  - `docs/STATUS.md` 追加更正，指向本文件。
- 验证：macOS 27 arm64，Node 22.23.2，Python 3.13.13 与 uv 的 3.9.6。临时 tsx 脚本（未提交）用 `EventStore` + `startServer` 起接收端，没有启动 Electron。从文档里抽出的代码原样运行：第 2 节示例两个版本各 10 条 sent；第 3 节片段两个版本各 22 条 sent，判断与尝试状态符合预期、anomalies 为 0；Node 示例三条 200；curl 覆盖 200、重复 200、409、两种 400、401、403、404、413（带与不带 Content-Length）、415，只读段文件得到 503，慢速正文约 10.7 秒得到 408。停掉接收端再以同一目录重启（新端口与 token）：`queue_size=5` 的发送器离线丢 19 条，恢复后先发 `telemetry.dropped` count=19，其余 34 条写入。脱敏用假值核对。`fake_host.py` 与 `pnpm demo:host --fast --once` 状态与预期一致。Windows、Linux 与 Electron 窗口未验证；PowerShell 那一行未执行。
- 遗留：接收端接受不带 `Bearer ` 前缀的 token；桌面端没有诊断模式开关；请求超时实际约 10 秒才生效；`appendFileSync` 确认前不 fsync；`.prettierignore` 排除 `*.md`，格式检查不覆盖文档。

## 17 — Python 发送器 close 超时后把未送达事件计入 dropped

- 日期：2026-09-30
- harness：claude-code
- model：claude-opus
- 提交：`4650f4a`
- 内容：记录 16 核对文档时发现，`close(timeout)` 超时后队列里剩下的事件和正在投递的那一条会被直接丢掉，`stats()['dropped']` 不变。现在 `close` 停止线程后清空队列并计数，线程退出时未送达的 pending 也计一次。新增 `test_close_timeout_counts_unsent_events_as_dropped`。`docs/INTEGRATION.md` 相应更正，原来的观测结果保留并注明是修复前。
- 验证：macOS arm64，uv 的 Python 3.9 与 3.13：`python -m unittest discover -s python/tests` 21 项通过。去掉修复后新测试失败（`2 != 5`），恢复后通过。
- 遗留：不调用 `close` 就退出进程时，队列里的事件仍会丢掉且不计数（守护线程随进程结束）。

## 18 — Windows 优先的目录 zip 打包与读回核对

- 日期：2026-09-30
- harness：claude-code
- model：claude-opus
- 提交：`cbf6b57`（分支 `claude/m5-package`，起点 `826c5a8`），合并 `9613c79`，CI 作业 `05df30e`
- 内容：
  - `pnpm package`（`scripts/package.mjs`），默认 win32-x64，`--platform/--arch` 支持 win32-arm64、darwin-arm64/x64、linux-x64/arm64。构建时设 `JEV_BUILD_MODE=production`（`scripts/build.mjs` 只对渲染端 define `NODE_ENV=production`，`pnpm build/start/demo` 不变）；app 目录只有 dist（去掉 source map）和最小 package.json，不带 node_modules；@electron/packager 开 asar，Electron zip 按 electron 包的 checksums.json 校验，临时目录在 `release/.stage`；输出 `release/jev-monitor-bar-<platform>-<arch>/`（0755）、`release/jev-monitor-bar-<ver>-<platform>-<arch>.zip`（yazl，顶层固定目录，保留权限位与符号链接，支持 SOURCE_DATE_EPOCH）和 `release/SHA256SUMS.txt`（coreutils 格式）。不做单文件便携版、自解压、UPX 或混淆。
  - Windows 版本资源：CompanyName/FileDescription/ProductName「JEV Monitor Bar」、FileVersion 0.1.0.0、ProductVersion 0.1.0、InternalName jev-monitor-bar、OriginalFilename jev-monitor-bar.exe、LegalCopyright。packager 19.1.1 用 resedit（纯 JS，macOS 上不需要 wine）。不传 `requested-execution-level`：它把 `Buffer.from(str).buffer` 写进清单，1425 字节的清单后面多出约 6.7 KB 缓冲池垃圾（在 exe 副本上复现）。Electron 自带清单已是 asInvoker，由 verify 读回。
  - Fuses（@electron/fuses，strictlyRequireAllFuses）：RunAsNode、EnableNodeOptionsEnvironmentVariable、EnableNodeCliInspectArguments 关；EnableEmbeddedAsarIntegrityValidation、OnlyLoadAppFromAsar 开；EnableCookieEncryption 关；GrantFileProtocolExtraPrivileges 保持开：关掉后渲染页 `app.asar/dist/renderer/index.html` 报 ERR_FILE_NOT_FOUND（macOS arm64 实测），要关它须先改自定义协议加载。macOS 主机上翻 fuses 后重做 ad-hoc 签名。
  - 签名钩子：仅 Windows 主机 + win32 目标 + 设了 `WINDOWS_CERTIFICATE_FILE` / `WINDOWS_SIGN_WITH_PARAMS` / `WINDOWS_SIGN_HOOK_MODULE_PATH` 时调用 @electron/windows-sign（sha256）；否则打印未签名并提示用 SHA256SUMS 核对。仓库不含证书。
  - `pnpm package:verify`（`scripts/verify-package.mjs`）：读回 fuse wire；asar 只含 package.json 与 dist 共 8 项，包内无 `.node`、node_modules、source map；bundle 只 require electron 与 Node 内置模块；asar 头哈希与 exe INTEGRITY 资源或 Info.plist 一致；exe 版本资源与清单（asInvoker、uiAccess=false、清单后无多余字节）；macOS 上 codesign --verify --deep --strict；zip 与目录逐项一致；SHA256SUMS 与重算一致。
  - 新增 devDependencies（纯 JS）：@electron/fuses、@electron/asar、@electron/windows-sign、resedit、plist、yazl、yauzl。新增 `tests/package-config.test.ts`、`tests/release-zip.test.ts`，只测纯函数和小目录 zip 往返，不跑完整打包。
  - CI 新增 `package-windows` 作业：在 `windows-latest` 上打包、核对并上传 zip 与 SHA256SUMS。
- 验证（macOS 27 arm64，Node 22.23.2，pnpm 11.19.0，Electron 42.11.6）：`pnpm format:check`、`pnpm typecheck`、`pnpm test`（139 通过）、`pnpm build` 通过。`pnpm package` 与 `pnpm package:verify` 在 win32-x64、win32-arm64、darwin-arm64、linux-x64 上全部 ok；`shasum -a 256 -c SHA256SUMS.txt` 通过。把 exe 的 RunAsNode 翻回开启后 verify 报 FAIL，恢复后通过。启动 darwin-arm64 包（隔离的 JEV_MONITOR_HOME）：会话文件 0600，`/health` 200/401，POST 事件得到 `{"accepted":true,"cursor":1}` 并落盘，窗口在屏幕上（400×132，floating 层），渲染页显示该事件，SIGTERM 后退出码 0 并删掉会话文件；用 ditto 解压的 zip 副本同样可运行，codesign 校验通过。`ELECTRON_RUN_AS_NODE=1 … -e`、`--inspect=127.0.0.1:<port>`、`NODE_OPTIONS=--require` 在发布包上都不生效（开发版 Electron 对照组三项都生效）。改 asar 头或 main.cjs 一个字节后，应用拒绝启动。合并进 `claude/m5-integration` 后在本机重跑：148 项测试通过，`pnpm package`（win32-x64）核对全部 ok。
- 遗留：Windows exe 未在 Windows 上运行（SmartScreen、无 UAC、fuses 与 asar 完整性、Defender 扫描、Windows 主机打包与签名均未验证）。Linux 包只构建与核对，未运行；chrome-sandbox 无法经 zip 保留 setuid。CompanyName、LegalCopyright 与 macOS bundle id（packager 默认 com.electron.jev-monitor-bar）待仓库所有者确认。发布包仍接受 `--remote-debugging-port`，没有对应的 fuse。GrantFileProtocolExtraPrivileges 须等渲染页改成自定义协议后才能关。

## 19 — 桌面冒烟测试与可见延迟（pnpm smoke）

- 日期：2026-09-30
- harness：claude-code
- model：claude-opus
- 提交：`ae6777f`（分支 `claude/m5-desktop-smoke`，起点 `826c5a8`），合并 `bb0447c`，CI 作业 `f834d64`
- 内容：
  - 新增 `pnpm smoke`（`scripts/smoke.mjs`、`smoke-lib.mjs`、`smoke-native.mjs`）。用 Playwright 启动真实窗口，数据目录固定在 `.runtime/smoke/<platform>-<arch>/home`，报告、截图、日志、导出文件写在同一目录，任一断言失败退出码非零，有总超时。默认测 `pnpm build` 的产物；`--app` 测打包后的可执行文件或 `.app`。发布包关掉 `--inspect` 的 fuse 时改用 CDP，只连渲染进程，主进程窗口断言与导出回放记为跳过。
  - 把记录 11 的人工闭环验收改成自动断言：7 个 fixture 场景经 `demo-host.mjs --once --fast` 用真实 HTTP 发送；紧凑条与展开视图是同一个 run；只选择不显示已执行或成功；完成未验证只显示「已执行待验证」；暂停跟随期间继续接收，视口不动；导出后回放，关键状态与实时一致；回放期间继续接收；退出回放能看到实时数据；输入摘要里的密码在界面和导出里都已脱敏。
  - 窗口断言：置顶；启动后未获得焦点；在显示器工作区内；contextIsolation、sandbox 开，nodeIntegration 关；可缩放；紧凑宽度 360–440；紧凑与展开切换；置顶开关。
  - 可见延迟：紧凑条模式下逐条 POST 带唯一标记的 `progress.updated`，页面里用 MutationObserver 加两个动画帧记可见时刻。报告 POST 开始到可见、接收到可见、POST 开始到 DOM 出现、POST 往返的 p50/p95/max，按最近秩法取百分位，缺一条即不通过。
  - `--native`：macOS 用 NSWorkspace 与 CGWindowList 读前台应用和窗口层级，不需要系统权限；Windows 用 user32 读前台进程与是否置顶（未在 Windows 上运行过）。
  - `tests/smoke-lib.test.ts` 11 项。`src/main/platform.ts` 只改两处 macOS 注释。
  - CI 新增 `smoke` 作业：Windows 必须通过，Linux（xvfb）先 continue-on-error；Windows 上另跑一次 `--native`，只记录结果。
- 验证：macOS 27.0（Darwin 27.0.0）arm64，Apple M2、8 GB，Node 22.23.2，Electron 42.11.6，Playwright 1.63.0。
  - 分支上：`pnpm format:check`、`pnpm typecheck`、`pnpm test`（136 项）、`pnpm build` 通过。`pnpm smoke --native` 37/37 通过，N=200 时 POST 开始到可见 p50 80 ms、p95 88 ms、最大 134 ms，接收到可见 p95 86 ms。这次运行时会话已锁屏（前台为 loginwindow），不能当作画面已上屏的证据。会话活动时的 10–20 条短运行 p50 80–81 ms。
  - 会话活动时 `--native` 验证了：启动后前台应用不变、窗口未获得焦点；窗口层级 3，在重叠的其他应用普通窗口之上；取消置顶后层级 0，再置顶回到 3。
  - 合并进 `claude/m5-integration`（含记录 15 的 A1 文案修改）后在本机重跑：159 项测试通过；`pnpm smoke --native` 37/37 通过，p50 80 ms、p95 88 ms、最大 121 ms。再用 `pnpm package --platform darwin --arch arm64` 打出的正式发布包跑 `pnpm smoke --native --no-build --app "release/jev-monitor-bar-darwin-arm64/JEV Monitor Bar.app"`：自动识别 `--inspect` 已关、改用 CDP，25 项通过、0 失败、8 项跳过，p95 89 ms。
  - 未跑 Windows 和 Linux。没有屏幕录制权限，未做整屏截图。
- 遗留：Windows runner 上的冒烟测试与截图以 Actions 结果为准；Windows 探针第一次实跑；xvfb 下的焦点语义；经 Finder 启动是否抢前台；Spaces、全屏之上、拖动缩放、多显示器；展开模式时间线的延迟没有单独测。

## 20 — M5 集成分支第一次 CI：Windows runner 上的冒烟测试与系统层探针

- 日期：2026-09-30
- harness：claude-code
- model：claude-opus
- 提交：`0cbeead` 的 CI 结果，以及本条所在提交
- 内容：
  - PR #15 在 `0cbeead` 上的 pull_request 运行 [36631651279](https://github.com/lawchli/jev-monitor-bar/actions/runs/36631651279) 10 个作业全部成功：core 三平台、python 4 个、`package-windows`、`smoke` 两个。
  - `smoke (windows-latest)`（runner 镜像 `windows-2025-vs2026`，Microsoft Windows Server 2025）：`pnpm smoke --no-build` 32 项通过、0 失败，可见延迟 N=200，p50 78 ms、p95 87 ms、最大 133 ms。随后 `--native` 一轮 36 项通过、1 项跳过：Windows 系统层探针第一次实跑，`native.foregroundNotTaken`、`native.windowFound`、`native.onTop` 通过；`native.aboveOtherAppWindow` 跳过，因为 runner 上没有与它重叠的其他应用窗口。该轮可见延迟 p95 89 ms。
  - `smoke (ubuntu-latest)`（xvfb，没有窗口管理器）：32 项通过、0 失败，p95 83 ms。这个作业仍按记录 19 设为不阻塞，等再跑几次稳定后再改为必须通过。
  - `package-windows` 在 Windows 主机上第一次打包：`pnpm package` 与 `pnpm package:verify` 通过。
  - 本条在 `package-windows` 作业里加一步：用 `pnpm smoke --no-build --native --app release/jev-monitor-bar-win32-x64/jev-monitor-bar.exe` 在 runner 上启动发布包。结果以推送后的运行为准。
- 验证：结论来自 GitHub Actions 的作业日志（`gh run view --log`）。这些是 Windows Server runner 上的窗口，不是 Windows 10/11 桌面；没有多显示器与混合 DPI，没有手动拖动缩放，也没有 Defender 扫描。冒烟测试用的是开发构建，不是发布包（发布包的那一步是本条新加的）。
- 遗留：Windows 10/11 实机验收（发布包启动、SmartScreen、无 UAC、置顶与混合 DPI、Defender、干净机器解压即用）。

## 21 — 接收端必须带 Bearer 前缀，408 不再迟到

- 日期：2026-09-30
- harness：claude-code
- model：claude-opus
- 提交：本条所在提交
- 内容：记录 16 核对接收端时发现两处与协议不符，都在 `src/server.ts`：
  - 鉴权用 `replace(/^Bearer /, '')` 取 token，所以不带前缀、直接给 token 也能通过，和 PROTOCOL.md「`Authorization: Bearer <token>`」不一致。改为只在以 `Bearer ` 开头时取后面的部分，否则按错误凭证 401。仓库里的发送端（Python 发送器、`demo-host.mjs`、`pnpm smoke`、负载测试）都带前缀。
  - `requestTimeout = 2000` 只在 Node 的周期检查（`connectionsCheckingInterval`，默认 30 秒）时生效，正文发一半的请求约 10.7 秒、最坏 30 秒才得到 408，期间占着一个连接（上限 32）。改为 `http.createServer({connectionsCheckingInterval: 500}, …)`。
  - `tests/core.test.ts`：鉴权测试加上不带前缀和小写 `bearer` 两种 401；新增「正文发一半在 5 秒内得到 408」。
  - `docs/PROTOCOL.md` 追加「更正（2026-09-30，接收端修复后）」，`docs/INTEGRATION.md` 的状态码表与发送端说明随之更正，原来的观测结果保留并注明是修复前。
- 验证：macOS arm64：去掉修复时两个测试失败（408 在 30007 ms 后才到；不带前缀得到 200），恢复后通过。`pnpm format:check`、`pnpm typecheck`、`pnpm test`（160 项）通过；Python 3.9、3.13 的 unittest 通过。
- 遗留：桌面端仍没有诊断模式开关，`diagnostic` 入库时总被删掉（安全的一侧）；`appendFileSync` 确认前不 fsync，断电可能丢掉已确认的尾行。

## 22 — 在运行时核对发布包的 fuses 与 asar 完整性（pnpm package:runtime）

- 日期：2026-09-30
- harness：claude-code
- model：claude-opus
- 提交：本条所在提交
- 内容：
  - 记录 20 之后的 CI 运行 [36632136736](https://github.com/lawchli/jev-monitor-bar/actions/runs/36632136736) 在 Windows Server 2025 runner 上第一次启动打出的 `jev-monitor-bar.exe`：`pnpm smoke --native --app …` 自动识别 `--inspect` 已关、改用 CDP，22 项通过、0 失败、9 项跳过，可见延迟 p95 89 ms，`native.foregroundNotTaken` 通过。`native.onTop` 跳过：CDP 模式下拿不到原生窗口句柄。
  - smoke 判断「发布包关了 `--inspect`」是读可执行文件里的 fuse，不是看运行时是否生效。新增 `pnpm package:runtime`（`scripts/verify-runtime.mjs`），在同平台主机上实际启动 `release/` 里的包，各用独立的 `JEV_MONITOR_HOME`：
    - `ELECTRON_RUN_AS_NODE=1` 加 `-e` 写标记文件：标记没有出现，应用照常启动并写出会话文件。
    - `NODE_OPTIONS=--require <脚本>`：脚本没有执行，应用照常启动。
    - `--inspect=127.0.0.1:<空闲端口>`：应用启动后该端口连不上，输出里没有「Debugger listening」。
    - 复制一份包，把 `app.asar` 里 `dist/main.cjs` 中间的一个字节改掉再启动：进程退出，会话文件没有出现。
  - CI 的 `package-windows` 作业在 `package:verify` 之后跑 `pnpm package:runtime`。
- 验证：macOS 27 arm64，darwin-arm64 发布包：4 项全部通过，篡改的包退出码 1，整轮约 3.7 秒。开发版 Electron 上这三种入口都生效，是记录 18 的对照组，本条没有重复。Windows 上的结果以推送后的 CI 为准。
- 遗留：CDP 模式下的 `native.onTop` 可以改为按进程号找窗口，还没做；Windows 10/11 桌面、Defender 扫描、干净机器解压即用仍要在 Windows 实机上做。

## 23 — M5 合成负载（A9 / C10）

- 日期：2026-09-30
- harness：claude-code
- model：claude-opus
- 提交：`555e37b`（分支 `claude/m5-loadtest`，起点 `826c5a8`），合并 `f82b05e`，以及本条所在提交
- 内容：
  - 新增 `pnpm loadtest`（`scripts/loadtest/`）：接收端在独立子进程里按 `src/main/index.ts` 接好 EventStore、startServer 与 50 ms 合并通知，按 useMonitor 的 100 ms 节流经 `createMonitorHandlers` 拉快照，用 v8.serialize 近似 IPC；父进程经 HTTP 投递真实协议事件，含突发、近 64 KiB 事件与七类被拒请求；采样 RSS、GC 后 heap、事件循环阻塞、ELU、ingest/appendFileSync/readdirSync/快照/分页耗时、磁盘段；结束后测负载中导出、导出、回放、重启恢复和最坏情况探针。报告写到 `.runtime/loadtest/<时间戳>-<运行时>/`。
  - 新增 `tests/loadtest-generator.test.ts`：生成的事件全部通过协议校验且 ≤ 64 KiB，覆盖 16 种事件类型，被拒请求确实非法，EventStore 全部接收。长负载不进 `pnpm test`。
  - `tsconfig.json` 把 `scripts/loadtest` 纳入 typecheck；`package.json` 只加 `loadtest`。未改 `src/`。
  - 三份报告原文存到 `docs/reports/`：`2026-09-30-loadtest-30min-electron.md`、`2026-09-30-loadtest-30min-node.md`、`2026-09-30-loadtest-probe-electron.md`。
  - 新增 `.github/workflows/loadtest.yml`：只手动触发，三平台各跑一次，报告作为 artifact 上传，不作为合并门槛。
- 验证：macOS 27.0（26A428），Apple M2 8 核 8 GB，Node 22.23.2。分支上 `pnpm format:check`、`pnpm typecheck`、`pnpm test`（130 项）、`pnpm build` 通过。30.0 分钟、45,000 条有效事件（25/s，每 5 分钟突发 400 条，795 个 run，近上限 906 条，另有约 3% 被拒请求），Electron 42.11.6 as node 与 Node 22 各一次并行：
  - 有效事件失败 0、异常响应 0；被拒请求都得到预期状态（400、401、409、413，重复为 `accepted:false`）。HTTP p50 0.75 / p95 5.7 / p99 11.9 ms；ingest p50 0.29 / p99 1.35 ms；主进程侧更新延迟（入库到快照序列化完成）p95 102 ms。
  - 跟随 500 决策 + 500 尝试的长 run 时，每次快照 v8 约 4.3–5.8 MB，序列化 p50 8 ms，占主线程 8.8%；ingest 共占 1.1%。
  - 内存窗口 13.5 分钟到 20,000 条（26.35 MB）后持平；磁盘峰值 31.79 MB、保留 8 段后持平；GC 后 heap 14 分钟 33 MB → 29 分钟 38 MB（Node 41 → 46 MB），增量来自未结束 run 在聚合状态里保留的窗口外事件（1,123 条 / 1.9 MB），受 200 个 run 限制，30 分钟内未到稳态。macOS 内存紧张时 RSS 波动大，不作为保留内存依据。
  - 导出 30.45 MB 同步 637 ms；负载中导出 515 ms，期间 HTTP 最长 505 ms，超过 Python 发送端默认 0.5 秒超时（发送端会重试）。回放打开 422 ms，完整导出 23,243 条，回放只保留最早 20,000 条；每步 replaySnapshot 最长 159 ms。重启恢复 589 ms。
  - 探针 4 个 run × 520 个约 60 KB 的决策：窗口仍是 32 MiB，聚合状态在窗口外多保留 2,897 条 / 84 MB，GC 后 heap 121.5 MB；所选 run 每次快照 31 MB。
  - 30 分钟内两个接收端在相同时刻出现 appendFileSync 卡顿（100–180 ms 六次、约 1 s 两次），为系统级文件系统卡顿（磁盘 96% 满，其他 agent 同时运行），同步写使整个进程停住。微基准：384 B 行 appendFileSync 约 28 µs，常开 fd + writeSync 约 3–4 µs。
  - 合并进 `claude/m5-integration`（含记录 21 的接收端修复）后在本机重跑：165 项测试通过；`pnpm loadtest --duration 60s --rate 25 --runtime node --no-probe` 1,500 条有效事件失败 0，401 等被拒状态照旧，HTTP p95 3.0 ms，主进程侧更新延迟 p95 99 ms。
  - 未在 Windows / Linux 执行；未含渲染进程（可见延迟见记录 19、20）；未测打包版本与杀软。
- 遗留：A9 聚合状态只有条数上限、没有字节上限；快照每次带整个所选 run；`droppedRuns` 只增不减；导出、回放、恢复同步阻塞主线程；回放丢最新的超限事件；C10 同步写会把文件系统卡顿传给主线程，每条事件还有一次 readdirSync。建议依次考虑所选 run 投影与按需详情、聚合字节预算、每段常开 fd、只在轮转时清理旧段、回放 checkpoint；不改数据库、不加框架。Windows 实测待做。

## 24 — Windows runner 上运行时核对发布包的 fuses

- 日期：2026-09-30
- harness：claude-code
- model：claude-opus
- 提交：`d3e83e3` 的 CI 结果（记录在本条所在提交）
- 内容：CI 运行 [36632809142](https://github.com/lawchli/jev-monitor-bar/actions/runs/36632809142) 全部成功。`package-windows` 作业在 Windows Server 2025 runner 上打包后跑 `pnpm package:runtime`（记录 22）：`ELECTRON_RUN_AS_NODE` 不生效、`NODE_OPTIONS` 不生效、`--inspect` 不生效、改动 `app.asar` 的副本退出码 1 拒绝启动，4 项通过。随后 `pnpm smoke --native --app release/jev-monitor-bar-win32-x64/jev-monitor-bar.exe` 通过。
- 验证：结论来自该运行的作业日志。这是 Windows Server runner，不是 Windows 10/11 桌面；没有 SmartScreen（CI 里下载的包没有网络来源标记）、没有 Defender 扫描。
- 遗留：Windows 10/11 实机（SmartScreen、无 UAC、Defender、干净机器解压即用、混合 DPI）。

## 25 — 发布包署名改为仓库所有者确认的值

- 日期：2026-09-30
- harness：claude-code
- model：claude-opus
- 提交：本条所在提交
- 内容：仓库所有者同意替换记录 18 留下的占位值。`scripts/package-config.mjs`：CompanyName 为 `lawchli`，LegalCopyright 为 `Copyright (C) 2026 lawchli`，新增 `BUNDLE_ID = io.github.lawchli.jev-monitor-bar` 并作为 macOS 的 `appBundleId`（原来是 packager 默认的 `com.electron.jev-monitor-bar`）。ProductName、FileDescription 仍是「JEV Monitor Bar」。`pnpm package:verify` 在 macOS 包上新增 `bundle identifier` 一项；`tests/package-config.test.ts` 断言新的署名与 bundle id。
- 验证：macOS arm64：`tests/package-config.test.ts` 12 项通过；重新 `pnpm package`（win32-x64）与 `pnpm package --platform darwin --arch arm64`，核对全部 ok；用 resedit 读回 exe：CompanyName `lawchli`、LegalCopyright `Copyright (C) 2026 lawchli`、ProductName `JEV Monitor Bar`、FileVersion 0.1.0.0；`Info.plist` 的 CFBundleIdentifier 为 `io.github.lawchli.jev-monitor-bar`，codesign 校验通过；`pnpm package:runtime` 在 darwin 包上 4 项通过。
- 遗留：无。

## 26 — C10：段文件常开、只在换段时清理，droppedRuns 有界

- 日期：2026-09-30
- harness：claude-code
- model：claude-opus
- 提交：`446c734`（分支 `claude/c10-store-writes`，起点 `c6681e5`），合并 `0bb132d`
- 内容：
  - `src/store.ts`：每个段在第一次写入时 `openSync(…, 'a')` 一次，之后每条事件 `writeSync` 循环写完整行才确认，仍不 fsync。换段（4 MiB 条件不变）、写入出错、`close()` 时关闭当前段。写入出错时抛出原错误，接收端照旧回 503、不确认、cursor 不前进，下一条重新打开；如果已写出半行，下一条换新段，残行留在旧段，重启时计入 `corruptLines`。每次启动新开一段、保留 8 段、CRLF 读取、残行恢复不变。
  - 旧段只在启动时和新段写入第一行后清理；删除失败（ENOENT 以外）至少 1 秒后的下一次写入再试；列目录失败不再让已写入的事件变成 503。
  - `droppedRuns` 最多 200 个（与 run 上限同一常量 `MAX_RUNS`）。事件移出窗口时把 run 移到最新一端；超出时先去掉已不在 run 列表里、最早移出窗口的 run，仍在列表里的 run 保留标记，时间线「更早的事件已超出保留窗口」与「没有更早的事件」的区分不变。
  - 新增 `EventStore.close()`；`src/main/index.ts` 在接收端关闭后关闭当前段。
  - 新增 `tests/store-writes.test.ts`（8 项，在旧 `store.ts` 上全部失败）；已有测试未改。负载脚本同时计时 `appendFileSync`、`writeSync`、`openSync`。`docs/PROTOCOL.md` 追加「更正（2026-09-30，段文件常开）」，`docs/AUDIT.md` 追加 C10 说明。
- 验证：macOS 27 arm64（Apple M2 8 GB，Node 22.23.2），机器上同时有其他 agent，负载 3–20。
  - 分支上：`pnpm format:check`、`pnpm typecheck`、`pnpm test`（173 项）、`pnpm build` 通过；`pnpm smoke` 32 项通过。
  - 隔离基准（20,000 条 403 B 行）：ingest p50 48–55 µs → 11.6–12.5 µs，总耗时 1.16–2.08 s → 0.34–0.47 s，readdirSync 20,002 → 4 次。
  - `pnpm loadtest --duration 3m --rate 25 --runtime node --no-probe`，基线 3 次与分支 2 次交替，各 4,500 条有效事件，失败 0：单次落盘 p50 0.18–0.24 ms → 0.04–0.07 ms，落盘总耗时 1.7–4.1 s → 0.46–1.24 s，readdirSync 4,504 → 6 次，ingest p50 0.40–0.53 ms → 0.14–0.29 ms。
  - 与记录 27 合并后见记录 27 的验证。
  - 未在 Windows、Linux 与杀软环境执行；未跑 30 分钟负载。
- 遗留：写入仍同步，分支第二轮出现一次 518 ms 的 writeSync 卡顿，文件系统卡顿仍会停住主进程；仍不 fsync；当前段打开期间被外部删除时，写入会进入已删除的文件直到下次换段；run 被移出列表后又收到新事件时，它的 droppedRuns 标记可能已被去掉，时间线会写「没有更早的事件」。

## 27 — 回放保留最近的事件，拖动从检查点接着算（A9）

- 日期：2026-09-30
- harness：claude-code
- model：claude-opus
- 提交：`0932f9a`（分支 `claude/replay-window`，起点 `c6681e5`），合并 `ee128be`，以及本条所在提交
- 内容：
  - `parseReplay` 从文件末尾往前读，超过 20000 条时保留最近的有效事件（原先保留最早的）。更早的行照样校验，计入无效行或新的 `omitted`（略过数），不脱敏也不保留；50 MiB 上限、逐行校验与脱敏、缺 cursor 用行号不变。
  - 回放横幅「已截断，只保留前 20000 条」改为「只保留最近 N 条，已略过更早的 M 条」。`ReplayData` 增加可选的 `omitted`。
  - 新增 `ReplayTimeline`：去重、cursor、焦点和每个 run 的事件下标一次算好；每 1000 条存一个聚合状态检查点，跳到第 p 条最多在最近检查点上再应用 999 条，往后一步只应用一条。检查点里的 run 不再改动，之后第一次改到才复制一层；没变的决策/尝试与上一个检查点共用，事件和 payload 始终共用。检查点最多 21 个，事件更多时加大间隔。`ReplayView` 改用它；`replaySnapshot` 保留为从头计算的对照。
  - 新增 `tests/replay-timeline.test.ts`（10 项）：带种子的混合事件流（260 个 run、重复、乱序、关联冲突、超过 500 个决策）在随机位置、检查点边界、每次淘汰前后、连续播放与倒退、越界 count 上与 `replaySnapshot` 逐项 deepStrictEqual；A7 的 201 个 run；事件不被改动；导出再回放与实时内存窗口的事件集合一致。10 种故意改坏的实现有 9 种被测出，剩下一种在只追加、只删最早键的表里不会出现。
  - 新增 `pnpm bench:replay`（不进 `pnpm test`）；loadtest 报告同时记从头重算与检查点耗时和略过数。
  - 导出未改：保留段是内存窗口的超集，回放取最近 20000 条后通常与内存窗口相同。平均事件大于约 1.4 KB、窗口外重发的重复事件、以及窗口前开始的 run 的聚合状态仍有差异。回放打开的 IPC 未改（26.66 MB，其中 payload 20.3 MB）；要再降需要按需读取详情。
- 验证：
  - 分支上（macOS 27 arm64，M2 8 GB，Node 22.23.2，另一个 agent 同时运行）：`pnpm test`（176 项）等通过；`pnpm smoke` 32 项通过（含 replay.matchesLive）。`pnpm bench:replay`，3 分钟负载导出的最后 20,000 / 23,000 行，前后对比（ms，中位数）：跳到 50% 21.0 → 0.08，100% 70.8 → 0.06，检查点后 999 条 25.8 → 5.1，前进一条 21.3 → 0.49，后退一条 20.9 → 3.6，随机 200 次 p95 66.5 → 4.6；首次全量 83.7 → 92.9；检查点常驻 2.8 MB。23,000 行文件改为保留最近 20,000 条、略过 3,000。极端合成（42 万个表格键）检查点约 27 MB，首次全量 112 → 263 ms。
  - 与记录 26 合并后（`claude/m5-followups`）在本机重跑：`pnpm format:check`、`pnpm typecheck`、`pnpm test`（184 项）、`pnpm build` 通过；Python 3.9、3.13 unittest 通过；`pnpm smoke --native` 37/37，可见延迟 p95 92 ms；`pnpm loadtest --duration 60s --rate 25 --runtime node --no-probe` 1,500 条失败 0，writeSync 1,501 次、openSync 2 次、readdirSync 5 次，回放跳到一半 0.53 ms；`pnpm package --platform darwin --arch arm64` 核对全部 ok，`pnpm package:runtime` 4 项通过。
  - 只在 macOS 上测量；未测 Windows、Linux。
- 遗留：后退一步最多重放 999 条；极端情形首次全量变慢；`state.ts` 的 `bound()` 每条决策/尝试事件都做一次 `Object.keys`，大表时每条约 40 µs，实时存储同样受影响；IPC 未减小；回放聚合状态不含窗口之前的事件。

## 28 — 合并前审计与修复

- 日期：2026-09-30
- harness：claude-code
- model：claude-opus
- 提交：`015996c`，以及本条所在提交
- 内容：
  - 由一个只读 agent 审计 PR #14 + #15 的集成结果和记录 26、27 的两个分支，结论与完整问题表追加到 `docs/AUDIT.md`「2026-09-30 合并前审计」。没有严重或高危问题。
  - 修掉 M1（脱敏后按码点截回 4096，重启与导出不再丢已确认的事件）、B1（写出部分内容后烧掉 cursor）、L1（401/403 带 `Connection: close`）、L2（CSP 加 `frame-src 'none'`、`worker-src 'none'`，拦下所有 `will-frame-navigate`）、I2（`setPermissionCheckHandler` 返回 false）、L7（按时间点比较 `ended_at`）。
  - 新增回归测试：`tests/core.test.ts` 的超长脱敏重启导出、拒绝后断开连接、带时区的淘汰顺序；`tests/store-writes.test.ts` 的整行未写换行时 cursor 不重复，原有半行测试的期望 cursor 随之改为 3。
  - M2、M3、L3–L6、I3、I4 列为合并后的后续项。
- 验证：macOS 27 arm64，`claude/m5-followups`：去掉修复时 M1、B1 的三个测试失败，恢复后通过；`pnpm format:check`、`pnpm typecheck`、`pnpm test`（188 项）、`pnpm build` 通过；`pnpm smoke --native` 37/37，可见延迟 p95 93 ms。用审计留下的 Electron 探针对新构建复测：`navigator.permissions.query({name:'geolocation'})` 从 granted 变为 denied；iframe 加载 `file:///etc/hosts` 被拦下（只剩 `chrome-error://`）；页面里注入的 `<script src="file://…">` 仍能加载（见 AUDIT 的 L2）。
- 遗留：见 `docs/AUDIT.md` 该节的「待办」。

## 29 — Windows 11 实机第一次运行（LANCE-GAMEPC）

- 日期：2026-09-30
- harness：claude-code（Windows 上的 Claude Code 会话，经 Remote Control 由本会话派发）
- model：claude-opus（本条由集成会话记录；Windows 会话的模型系列以它自己的提交为准）
- 提交：`5e29c78`（demo-host 修复），以及本条所在提交
- 内容：
  - 机器：Windows 11 IoT 企业版 LTSC 10.0.26100，i5-12400（12 线程）、31.7 GB，Node 24.19.0（winget 安装），pnpm 11.19.0（用户范围安装），git 2.52，Python 3.12.10。仓库原来停在 Initial commit，`git fetch` 后切到 `claude/m5-integration@4841493`；`core.autocrlf=true`，但 `.gitattributes` 生效，工作区全是 LF。
  - `pnpm test` 165 项里 2 项失败：demo-host 在 fetch 刚完成时 `process.exit(1)`，Node 24 在 Windows 上 libuv 断言失败，以 0xC0000409 崩溃（3/3 复现）。Windows 会话对照了几种改法，确认改为 `process.exitCode = 1` 并结束循环后 3/3 退出码 1。`5e29c78` 按这个改。
  - 其余检查全部通过：`format:check`、`typecheck`、`build`；Python 3.12 unittest 21 项；`pnpm smoke --native` 36 通过、1 跳过（没有可比较的重叠窗口），可见延迟 p50 84 ms、p95 92 ms；`pnpm package` 与 `package:verify` 全部 ok（exe 版本资源、asInvoker、asar 完整性、zip 与 SHA-256）；`package:runtime` 4 项通过；发布包 `pnpm smoke --native --app …\jev-monitor-bar.exe` 22 通过、9 跳过，p95 92 ms。
  - `pnpm loadtest --duration 5m --rate 25 --runtime node --no-probe`（记录 26 之前的写盘方式）：7,500 条有效事件失败 0，HTTP p95 1.86 ms，4 次超过 500 ms；appendFileSync p50 0.38 ms、占 ingest 74.2%，最长 789 ms 的磁盘写入停顿；主进程更新延迟 p95 99.7 ms；导出 170 ms、重启恢复 204 ms。
  - 阶段 C（真实桌面观察）受阻：用户会话 1 处于断开状态（`query session` 为 Disc，SM_REMOTESESSION=1，`OpenInputDesktop` 与 `GetForegroundWindow` 返回 0，`CopyFromScreen` 抛「句柄无效」）。所以 smoke 的「不抢焦点」在这台机器上是空验证（前台为 Idle），截屏做不了，注册表 200% 缩放没有生效（Electron 读到 scaleFactor 1，1300×653 的占位显示）。
  - Defender：`RealTimeProtectionEnabled` 为 False，病毒库版本为空，Defender 扫描没有做。
- 验证：以上数字来自 Windows 会话回报的命令输出。
- 遗留：需要用户在本机登录或用远程桌面连进会话 1 后，再做置顶、不抢焦点、200% 缩放清晰度、拖动与位置恢复和截图；Defender 需要用户自己开启并更新病毒库后再扫描；干净机器（无 Node/Python）解压即用未做；记录 26 的写盘改动还要在 Windows 上重测负载。

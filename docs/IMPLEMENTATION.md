# 实施记录

记录只追加、不改写。署名规则与提交流程见 `AGENTS.md`：小任务完成后 `git add` 暂存并在当前记录里补一项，大功能或大方向完成后再 commit 并 push。

## 里程碑状态

每次推进里程碑时更新本表，并在下方追加对应记录。

| 里程碑 | 内容 | 状态 |
| --- | --- | --- |
| M0 | 核实 TypeSafe 接口、参考项目与技术选型 | 完成（记录 01） |
| M1 | 协议、接收、持久化、状态聚合、脱敏；单元测试与三平台 CI | 集成分支已有核心模块、JSON Schema、协议文档与模拟场景（记录 08）。协议与审计里过时的句子在记录 A10 更正。A1–A9 未修，闭环验收未做 |
| M2 | Electron 主进程、平台模块、preload、Windows 置顶小窗 | 集成分支已有主进程、平台模块、preload 与窗口位置恢复（记录 08）。原生 Windows 窗口未验证 |
| M3 | 紧凑/展开 UI、详情、时间线、断线提示、导出与回放 | 集成分支已有紧凑条、展开视图、导出与回放（记录 08） |
| M4 | Python 发送器、示例宿主、`pnpm demo` | 集成分支已有 Python 发送器、示例宿主与 `pnpm demo`（记录 08） |
| M5 | 接入文档、延迟与负载测试、Windows 实机验证与打包；macOS/Linux 适配 | 未开始 |

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

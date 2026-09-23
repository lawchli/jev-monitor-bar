# 实施记录

记录只追加、不改写。署名规则与提交流程见 `AGENTS.md`：小任务完成后 `git add` 暂存并在当前记录里补一项，大功能或大方向完成后再 commit 并 push。

## 里程碑状态

每次推进里程碑时更新本表，并在下方追加对应记录。

| 里程碑 | 内容 | 状态 |
| --- | --- | --- |
| M0 | 核实 TypeSafe 接口、参考项目与技术选型 | 完成（记录 01） |
| M1 | 协议、接收、持久化、状态聚合、脱敏；单元测试与三平台 CI | 部分完成：核心模块与测试已有；缺独立 JSON Schema 文件、协议说明文档、固定演示数据 |
| M2 | Electron 主进程、平台模块、preload、Windows 置顶小窗 | 未开始 |
| M3 | 紧凑/展开 UI、详情、时间线、断线提示、导出与回放 | 未开始 |
| M4 | Python 发送器、示例宿主、`pnpm demo` | 未开始 |
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

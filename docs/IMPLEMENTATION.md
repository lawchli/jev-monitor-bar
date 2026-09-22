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
- model：<小写，如 claude-opus-5.5；不确定写 unknown>
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

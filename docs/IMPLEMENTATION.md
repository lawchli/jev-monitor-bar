# 实施记录

记录只追加、不改写。署名规则与提交流程见 `AGENTS.md`。

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
- 模型：<工具>-<模型家族>（可选：具体版本）
- 提交：<hash 列表，或「本条所在提交」>
- 内容：做了什么
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

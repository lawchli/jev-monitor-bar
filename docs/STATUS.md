# 现状

日期：2026-09-23。基线：`main` @ `cd99afb`（已合并 [PR #1](https://github.com/lawchli/jev-monitor-bar/pull/1)）。下面的开放 PR 都还未合并。

## 已在 main

- M0 完成。M1 部分完成：事件协议与校验、接收服务（只监听 `127.0.0.1`，带 token 鉴权）、JSONL 持久化、状态聚合、脱敏，以及 10 项单元测试。Windows / Linux / macOS CI（typecheck 与 test）已通过。这部分代码平台无关。
- 数据目录解析、构建脚本、Electron 桌面壳与平台模块、UI、Python 发送器、演示和打包还在开放 PR 或后续切片里。
- 里程碑表里 M2–M5 仍是未开始。
- `docs/AUDIT.md` 里 C6、C7、C9、C10–C12 在 `main` 上仍是待办。C6 / C7 / C9 的修复在 PR #5。

## 开放 PR

`gh pr list`（2026-09-23）：8 个 PR 都是 draft。相对当前 `main` 均为 `MERGEABLE` / `CLEAN`，检查结论都是 SUCCESS。GitHub 上没有 review 评论。项目记录写明这 8 个 PR 都已审计通过，blocker 已修：[#9](https://github.com/lawchli/jev-monitor-bar/pull/9) 由 Claude 复审，[#4](https://github.com/lawchli/jev-monitor-bar/pull/4)–[#8](https://github.com/lawchli/jev-monitor-bar/pull/8) 由 GPT 审查。

建议合并顺序：[#2](https://github.com/lawchli/jev-monitor-bar/pull/2) → [#4](https://github.com/lawchli/jev-monitor-bar/pull/4) → [#5](https://github.com/lawchli/jev-monitor-bar/pull/5) → [#3](https://github.com/lawchli/jev-monitor-bar/pull/3)（先 rebase）→ [#9](https://github.com/lawchli/jev-monitor-bar/pull/9) → [#6](https://github.com/lawchli/jev-monitor-bar/pull/6) → [#7](https://github.com/lawchli/jev-monitor-bar/pull/7) → [#8](https://github.com/lawchli/jev-monitor-bar/pull/8)。

本地按该顺序在临时 worktree 试合并（未推送）：#2、#4、#5 可以依次干净合并。其后 #3 与 `package.json`、`docs/IMPLEMENTATION.md` 冲突，合并前要 rebase。#9、#6、#7、#8 接到 #2 + #4 + #5 之上时，冲突只在 `docs/IMPLEMENTATION.md`（实施记录只追加，合并时保留双方）。

| 顺序 | PR | 切片 | 审计与 CI |
| --- | --- | --- | --- |
| 1 | [#2](https://github.com/lawchli/jev-monitor-bar/pull/2) | P1-00 格式化与边界守卫 | 审计通过。`core`：windows-latest / ubuntu-latest / macos-latest SUCCESS |
| 2 | [#4](https://github.com/lawchli/jev-monitor-bar/pull/4) | P1-01 可运行骨架 | GPT 审查通过，blocker 已修。`core` 三平台 SUCCESS |
| 3 | [#5](https://github.com/lawchli/jev-monitor-bar/pull/5) | P1-02 存储健壮性（C6 / C7 / C9） | GPT 审查通过，blocker 已修。`core` 三平台 SUCCESS |
| 4 | [#3](https://github.com/lawchli/jev-monitor-bar/pull/3) | P1-03 协议 Schema 与演示场景 | 审计通过。`core` 三平台 SUCCESS。相对当前 `main` 可合并；按上表顺序需先 rebase |
| 5 | [#9](https://github.com/lawchli/jev-monitor-bar/pull/9) | P1-04 桌面壳与平台模块 | Claude 复审通过，尺寸漂移已修。`core` 三平台 SUCCESS。Windows / macOS 窗口行为未实机验证 |
| 6 | [#6](https://github.com/lawchli/jev-monitor-bar/pull/6) | P1-05 紧凑条 UI | GPT 审查通过，可以合并。`core` 三平台 SUCCESS |
| 7 | [#7](https://github.com/lawchli/jev-monitor-bar/pull/7) | P1-06 展开视图 | GPT 审查通过，可以合并。`core` 三平台 SUCCESS |
| 8 | [#8](https://github.com/lawchli/jev-monitor-bar/pull/8) | P1-07 Python 发送端 | GPT 审查通过，可以合并。`core` 三平台 SUCCESS；`python`（windows / ubuntu / macos × Python 3.9 / 3.13）SUCCESS |

## 还没开始的切片

P1-08（`pnpm demo`）、P1-09（导出与回放）、P1-10（阶段 1 收尾）等第一波 PR 合并后再开工。合并权限仍待用户拍板，后续切片停在这里。

## 实机窗口

Windows 与 macOS 上的真实窗口行为仍未验证，包括置顶、是否抢焦点、位置恢复和多显示器。`main` 上还没有桌面壳。PR #9 把这两端标为未验证。

## 模型分工

2026-09-23 起：

- 代码操作（编写、修改、rebase、修 CI、提交、推送）用 Grok 4.7，fast + 最高推理：`grok-4.7-xhigh-fast`。
- 规划与架构用 Claude Opus 5.5 high：`claude-opus-5-5-high`。
- 审计先 GPT（默认 `gpt-5.6-sol-high`），再 Claude（`claude-opus-5-5-high`）。GPT 月度 API 额度在 2026-09-22 报过用尽，目前是否还能用不确定。

## 待用户拍板

合并权限、真机测试人、签名与图标、Windows arm64 / macOS x64 的付费 runner。

## 更正（集成之后）

上面的快照只代表写入当时：当时记的是 8 个开放 PR，并且写明 P1-08、P1-09 还没开工。那段文字不能再当派工依据。当前集成以 `cursor/integrate-mvp-83b9` 为准；P1-00 到 P1-09 已按固定 SHA 合并进该分支。快照原文保留，不改写。

当前集成分支已经包含 P1-08（`pnpm demo`）和 P1-09（导出与回放）这些模块；快照原文仍保留。

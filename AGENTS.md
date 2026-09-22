# AGENTS.md：多模型协作与提交规范

本仓库由多个 AI 编码工具/模型接力开发。所有接手者（无论使用 Cursor、Codex、Claude Code 或其他工具）都必须遵守本文件。

## 开始前

1. 读 `JEV_MONITOR_AGENT_PROMPT.md`（总需求、平台策略、原生兼容与杀毒软件友好要求）、`docs/IMPLEMENTATION.md`（进度与历史）、`docs/AUDIT.md`（已知问题与待办）。
2. 拉取最新代码，确认最近一次 CI 状态；不要在别人未合并的分支上直接改动，除非仓库所有者指定。
3. 用 `git status` 检查是否有上一位留下的暂存改动；有的话先读懂再继续，不要直接丢弃。

## 署名

- 署名格式：`<工具>-<模型家族>`，例如 `Cursor-Claude`、`Cursor-GPT`、`Codex-GPT`、`ClaudeCode-Claude`、`GeminiCLI-Gemini`。括号里补充具体模型名称，例如 `Cursor-Claude (Claude Opus 5.5)`。
- 执行环境：写实际运行的环境，例如 `Cursor Cloud Agent`、`Cursor IDE (Windows)`、`Codex CLI (macOS)`。
- 不确定的部分写「未记录」，不要编造工具名、模型名或版本。

## 提交节奏

1. **每完成一个小任务**（一个 bug 修复、一个模块、一份文档改写等）：运行相关验证，在 `docs/IMPLEMENTATION.md` 的当前记录里补上这一项，然后 `git add` 暂存在本地。不单独 commit。
2. **每完成一个大功能或大方向**（通常是一个里程碑，或里程碑中一个可独立使用的功能）：确认 `pnpm typecheck` 和 `pnpm test` 通过，然后 commit 并 push 到 GitHub。push 后查看 GitHub CI（Windows / Linux / macOS）结果，失败要修复后再推送。
3. **云端 agent 例外**：Cursor Cloud Agent 等云端环境的虚拟机结束后，本地暂存会丢失。会话结束前，即使大功能未完成，也要 commit 并 push 到自己的功能分支，标题以 `WIP:` 开头，并创建或更新 PR。
4. push 到仓库所有者指定的分支；未指定时推送自己的功能分支并创建或更新 PR。
5. 不 force push，不改写、删除他人的提交或实施记录。实施记录只追加；更正以前的内容时写一条新记录说明。

暂存区不是备份：本地工具如果需要中途离开，也可以先 commit 到本地，但仍按大功能的节奏 push。

## 提交信息格式

```text
<type>: <做了什么> [<署名>]

<为什么这样做、主要改动>

Agent-Model: <署名> (<具体模型名称>)
Agent-Env: <执行环境>
```

示例：

```text
feat: Windows 置顶小窗与平台模块 [Cursor-Claude]

...

Agent-Model: Cursor-Claude (Claude Opus 5.5)
Agent-Env: Cursor Cloud Agent
```

标题里的 `[署名]` 让 GitHub 提交列表里直接能看到是谁做的。查某个模型做过的提交：

```bash
git log --grep='^Agent-Model: Cursor-Claude' --format='%h %ad %s' --date=short
```

部分工具会在提交信息末尾自动追加自己的 trailer（例如 `Co-authored-by`），可能让 `git log --format='%(trailers)'` 识别不到 `Agent-Model`，所以用 `--grep` 查询；权威的署名记录以 `docs/IMPLEMENTATION.md` 为准。

## 代码约定

- 遵守 `JEV_MONITOR_AGENT_PROMPT.md`「平台支持策略」和「原生兼容、免额外组件与杀毒软件友好」：Windows 优先，核心代码平台无关，平台差异集中在桌面壳的平台模块；运行时依赖只用纯 JavaScript 包，不引入原生扩展或安装脚本；运行时不启动子进程、不联网、不需要管理员权限。
- 新代码风格与所在文件保持一致。若要引入格式化工具，作为单独一个小任务完成，不与功能改动混在一起。
- 不提交 `node_modules/`、`.pnpm-store/`、`dist/`、`release/`、`.runtime/`、`.env` 或任何真实凭证。
- 没有在对应平台实际执行过的验证，不写成已通过。

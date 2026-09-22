# AGENTS.md：多模型协作与提交规范

本仓库由多个 AI 编码工具/模型接力开发。所有接手者（无论使用 Cursor、Codex、Claude Code 或其他工具）都必须遵守本文件。

## 开始前

1. 读 `JEV_MONITOR_AGENT_PROMPT.md`（总需求与平台策略）、`docs/IMPLEMENTATION.md`（进度与历史）、`docs/AUDIT.md`（已知问题与待办）。
2. 拉取最新代码，确认最近一次 CI 状态；不要在别人未合并的分支上直接改动，除非仓库所有者指定。

## 模型署名

- 格式：`<工具>-<模型家族>`，例如 `Cursor-Claude`、`Cursor-GPT`、`Codex-GPT`、`ClaudeCode-Claude`、`GeminiCLI-Gemini`。
- 知道具体版本时可在实施记录里用括号补充；commit trailer 只写基本署名，方便检索。
- 不确定的部分写「未记录」，不要编造工具名或版本。

## 每完成一项任务

「一项任务」指一个可独立验证的改动：一个 bug 修复、一个模块、一份文档改写等。不要把多个无关改动塞进同一个提交，也不要攒到最后一次性提交。

1. 运行 `pnpm typecheck` 和 `pnpm test`，以及与改动相关的其他验证。
2. 在 `docs/IMPLEMENTATION.md` 末尾追加记录（模板见该文件）。记录只追加不改写；更正以前的内容时写一条新记录说明。
3. commit：信息说明做了什么和为什么，末尾单独一段写 `Agent-Model: <署名>`。
4. 立即 push 到 GitHub：推送到仓库所有者指定的分支；未指定时推送自己的功能分支并创建或更新 PR。
5. 不 force push，不改写、删除他人的提交或实施记录。

查某个模型做过的提交：

```bash
git log --grep='^Agent-Model: Cursor-Claude' --format='%h %ad %s' --date=short
```

部分工具会在提交信息末尾自动追加自己的 trailer（例如 `Co-authored-by`），这可能让 `git log --format='%(trailers)'` 识别不到 `Agent-Model`，所以用 `--grep` 查询；权威的署名记录以 `docs/IMPLEMENTATION.md` 为准。

## 代码约定

- 遵守 `JEV_MONITOR_AGENT_PROMPT.md`「平台支持策略」：Windows 优先，核心代码平台无关，平台差异集中在桌面壳的平台模块。
- 新代码风格与所在文件保持一致。若要引入格式化工具，单独一次提交完成，不与功能改动混在一起。
- 不提交 `node_modules/`、`.pnpm-store/`、`dist/`、`release/`、`.runtime/`、`.env` 或任何真实凭证。
- 没有在对应平台实际执行过的验证，不写成已通过。

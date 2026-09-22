# AGENTS.md：多模型协作与提交规范

本仓库由多个 AI 编码工具/模型接力开发。所有接手者（无论使用 Cursor、Codex、Claude Code 或其他工具）都必须遵守本文件。

## 开始前

1. 读 `JEV_MONITOR_AGENT_PROMPT.md`（总需求、平台策略、原生兼容与杀毒软件友好要求）、`docs/IMPLEMENTATION.md`（进度与历史）、`docs/AUDIT.md`（已知问题与待办）。
2. 拉取最新代码，确认最近一次 CI 状态；不要在别人未合并的分支上直接改动，除非仓库所有者指定。
3. 用 `git status` 检查是否有上一位留下的暂存改动；有的话先读懂再继续，不要直接丢弃。

## 署名

按运行位置分两种情况：

- **Cursor 云端 agent**：直接使用环境预设的 Cursor Agent 账号提交，GitHub 上的作者就是 `cursoragent`。不需要在提交信息里另写署名，也不要改 git 的 user.name / user.email。
- **本地开发**（在仓库所有者机器上运行的 Cursor、Codex、Claude Code 等）：提交作者是本机 git 账号，所以要在提交信息里记录 harness 和模型名称，**全部小写**，空格换成 `-`。
  - harness 是运行模型的工具，例如 `cursor`、`codex`、`claude-code`、`gemini-cli`。
  - model 是实际模型名称，例如 `claude-opus-5.5`。
  - 不确定的部分写 `unknown`，不要编造工具名、模型名或版本。

## 提交节奏

1. **每完成一个小任务**（一个 bug 修复、一个模块、一份文档改写等）：运行相关验证，在 `docs/IMPLEMENTATION.md` 的当前记录里补上这一项，然后 `git add` 暂存在本地。不单独 commit。
2. **每完成一个大功能或大方向**（通常是一个里程碑，或里程碑中一个可独立使用的功能）：确认 `pnpm typecheck` 和 `pnpm test` 通过，然后 commit 并 push 到 GitHub。push 后查看 GitHub CI（Windows / Linux / macOS）结果，失败要修复后再推送。
3. **云端 agent 例外**：Cursor Cloud Agent 等云端环境的虚拟机结束后，本地暂存会丢失。会话结束前，即使大功能未完成，也要 commit 并 push 到自己的功能分支，标题以 `WIP:` 开头，并创建或更新 PR。
4. push 到仓库所有者指定的分支；未指定时推送自己的功能分支并创建或更新 PR。
5. 不 force push，不改写、删除他人的提交或实施记录。实施记录只追加；更正以前的内容时写一条新记录说明。

暂存区不是备份：本地工具如果需要中途离开，也可以先 commit 到本地，但仍按大功能的节奏 push。

## 提交信息格式

Cursor 云端 agent：

```text
<type>: <做了什么>

<为什么这样做、主要改动>
```

本地开发：标题末尾加 `[<harness>/<model>]`，正文末尾加两行小写 trailer。

```text
<type>: <做了什么> [<harness>/<model>]

<为什么这样做、主要改动>

agent-harness: <harness>
agent-model: <model>
```

示例：

```text
feat: windows 置顶小窗与平台模块 [cursor/claude-opus-5.5]

...

agent-harness: cursor
agent-model: claude-opus-5.5
```

查询：

```bash
# Cursor 云端 agent 的提交
git log --author='Cursor Agent' --format='%h %ad %s' --date=short
# 本地某个 harness / 模型的提交
git log --grep='^agent-harness: codex' --format='%h %ad %s' --date=short
git log --grep='^agent-model: claude-opus-5.5' --format='%h %ad %s' --date=short
```

部分工具会在提交信息末尾自动追加自己的 trailer（例如 `Co-authored-by`），可能让 `git log --format='%(trailers)'` 识别不到上面两行，所以用 `--grep` 查询。

本仓库早期提交（记录 02、03）使用过 `Agent-Model:` / `Agent-Env:` 和 `[Cursor-Claude]` 的旧格式，保留不改写。

## 代码约定

- 遵守 `JEV_MONITOR_AGENT_PROMPT.md`「平台支持策略」和「原生兼容、免额外组件与杀毒软件友好」：Windows 优先，核心代码平台无关，平台差异集中在桌面壳的平台模块；运行时依赖只用纯 JavaScript 包，不引入原生扩展或安装脚本；运行时不启动子进程、不联网、不需要管理员权限。
- 新代码风格与所在文件保持一致。若要引入格式化工具，作为单独一个小任务完成，不与功能改动混在一起。
- 不提交 `node_modules/`、`.pnpm-store/`、`dist/`、`release/`、`.runtime/`、`.env` 或任何真实凭证。
- 没有在对应平台实际执行过的验证，不写成已通过。

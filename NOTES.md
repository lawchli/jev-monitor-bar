# LIVE 详情标签页的键盘导航

- 日期：2026-10-04
- harness：codex
- model：unknown（当前工具上下文未提供可确认的模型系列）
- 分支：`feat/humane-keyboard-tabs`
- 基线：`origin/main@d583ed6`
- 提交：本文件所在提交。按本次用户要求，仅本地提交，不 push、不合并其他分支。

展开 LIVE 视图的「决策 / 执行 / 时间线」现在支持左右方向键循环切换，Home 到首项，End 到末项。切换时选中标签取得焦点；仅选中标签保留 `tabIndex=0`，Tab / Shift+Tab 继续正常进出标签组。标签与内容面板通过唯一且稳定的 ID、`aria-controls` 和 `aria-labelledby` 关联。初次显示和后台刷新不会主动改变焦点，刷新时保留选中标签和内容区焦点。

改动文件：

- `src/renderer/expanded/ExpandedView.tsx`：接入标签组件；仍由原视图保存选中标签。
- `src/renderer/expanded/LiveDetailTabs.tsx`：局部键盘处理、焦点管理与标签 / 面板语义。隐藏的面板只保留空容器，未选中内容不挂载。
- `tests/expanded-tabs.test.ts`：5 项 JSDOM 组件回归，覆盖方向键循环、Home / End、鼠标选择、Tab 默认行为、初次不抢焦点、刷新保留焦点、标签与面板关联和多个实例 ID 不重复。
- `docs/IMPLEMENTATION.md`：追加独立的 `UI-KBD-01` 记录。
- `NOTES.md`：本说明。

实际验证环境：Linux，Node 22.23.2，pnpm 11.19.0。工作树通过忽略的 `node_modules -> ../../node_modules` 符号链接复用仓库根目录的依赖。以下命令均从本分支工作树执行：

| 命令 | 结果 |
| --- | --- |
| `pnpm --config.verify-deps-before-run=false typecheck` | 通过 |
| `pnpm --config.verify-deps-before-run=false test` | 193 / 193 通过 |
| `pnpm --config.verify-deps-before-run=false build` | 通过 |
| `pnpm --config.verify-deps-before-run=false exec tsx --test tests/expanded-tabs.test.ts` | 5 / 5 通过 |
| `pnpm --config.verify-deps-before-run=false exec prettier --check src/renderer/expanded/ExpandedView.tsx src/renderer/expanded/LiveDetailTabs.tsx tests/expanded-tabs.test.ts` | 通过 |
| `git diff --check` | 通过 |

`verify-deps-before-run=false` 仅为单次命令参数，防止 pnpm 将共享依赖目录当成需要重新安装；未修改仓库配置。初次未加参数时 pnpm 自动安装因 store SQLite 权限失败，重试改用现有依赖。沙盒内 tsx 创建本地 IPC socket 被 EPERM 拒绝；测试以获准的沙盒外执行完成，原测试无需修改。

限制：本次验证为 Linux 构建、类型检查及 JSDOM 回归。未启动原生 Electron 窗口，也未在 Windows / macOS、实际屏幕阅读器或真实系统键盘焦点环境验证；不据此宣称原生无障碍行为已验收。

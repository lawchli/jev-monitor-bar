# 可清除的导出结果提示

- 日期：2026-10-04
- 分支：`feat/humane-export-notice`，起点 `origin/main@d583ed6`
- harness：`codex`；model：`unknown`（当前上下文未确定模型系列）

导出成功或取消后，提示保留到用户按「清除提示」或开始下一次导出。成功提示继续显示文件名、字节数与跳过行数；提示只显示文件名，不显示完整路径。每次开始导出先清空旧提示，因此新的请求等待或失败时不会继续显示上一次成功。

提示文字位于持续挂载的 `role="status"` 区域，使用 `aria-live="polite"` 和 `aria-atomic="true"`。清除按钮是可聚焦的原生按钮，名称为「清除导出提示」，放在公告区域外；不使用弹窗或自动消失的计时器。

## 文件

- `src/renderer/App.tsx`：清除旧结果、公告区域和清除按钮。
- `src/renderer/styles.css`：提示与按钮的间距，长文件名换行。
- `tests/export-notice.test.ts`：真实 App 在 jsdom 中的三项交互测试，覆盖成功详情、取消、清除、按钮名称和聚焦、新请求等待以及随后失败。
- `docs/IMPLEMENTATION.md`：追加 `HUMANE-EXPORT` 记录。

## 实际验证

Linux，Node 22.23.2，pnpm 11.19.0。依赖由协调会话安装，工作树使用忽略的 `node_modules -> ../../node_modules`。pnpm 的共享依赖检查会尝试重新安装，因此各命令使用仅本次生效的 `--config.verify-deps-before-run=false`，没有改仓库配置或依赖。

| 命令 | 结果 |
| --- | --- |
| `pnpm --config.verify-deps-before-run=false exec prettier --check src/renderer/App.tsx src/renderer/styles.css tests/export-notice.test.ts` | 通过 |
| `pnpm --config.verify-deps-before-run=false exec tsx --test tests/export-notice.test.ts` | 3/3 通过 |
| `pnpm --config.verify-deps-before-run=false typecheck` | 通过 |
| `pnpm --config.verify-deps-before-run=false test` | 191/191 通过，0 跳过 |
| `pnpm --config.verify-deps-before-run=false build` | 通过 |
| `git diff --check` | 通过 |

初次未覆盖 pnpm 依赖检查的命令因 sandbox 外 store 数据库不可写而失败；tsx 初次运行因本地 IPC 管道 `listen EPERM` 失败。上表中的测试在获授权的 sandbox 升级后实际通过，不修改测试来绕开环境限制。

## 平台限制

本次验证覆盖类型、构建与 DOM 交互；没有运行原生 Electron 窗口，没有实测屏幕阅读器公告，也没有在 Windows 或 macOS 上执行。Windows 保存对话框、DPI、置顶和打包行为未在本任务中验证。按用户指示只做本地提交，不 push、不创建 PR、不集成其他分支。

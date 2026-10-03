# Humane history retry

- Branch: `feat/humane-history-retry`, based on `origin/main@d583ed6`.
- Authoring harness: `codex`; model series: `unknown`.
- Feature: when older timeline events cannot load, show the calm inline message “暂时未能加载更早的事件，请重试。” and relabel the existing button “重试加载更早”. No backend error details are shown. The existing rows, selected detail and list scroll position survive failure. Successful retry, a run switch or returning to latest clears the message; stale failures are ignored using the existing run/epoch guards.
- Source: `src/renderer/expanded/TimelineTab.tsx`; existing muted styles are reused.
- Tests: `tests/expanded-timeline.test.ts` adds four JSDOM regressions for retained history/selection/scroll position, retry query and success, empty-page truncation, reset paths, and stale request errors during a newer request.
- History: append-only feature record in `docs/IMPLEMENTATION.md`.

## Validation

Validated on Linux x64 with Node 22.23.2 using the repository root's installed dependencies through an ignored `node_modules` symlink. Every pnpm invocation uses `--config.verify-deps-before-run=false` to prevent pnpm from attempting an independent dependency install for the worktree; no dependency or repository configuration changes were made.

- `pnpm --config.verify-deps-before-run=false exec tsx --test tests/expanded-timeline.test.ts`: 8/8 passed.
- `pnpm --config.verify-deps-before-run=false typecheck`: passed.
- `pnpm --config.verify-deps-before-run=false build`: passed.
- `pnpm --config.verify-deps-before-run=false exec prettier --check src/renderer/expanded/TimelineTab.tsx tests/expanded-timeline.test.ts`: passed.
- `pnpm --config.verify-deps-before-run=false test`: 192/192 passed.

The initial sandboxed test attempt could not create tsx's local IPC socket (`listen EPERM`); the focused and full suites were rerun with authorized sandbox escalation. The initial pnpm command's automatic dependency verification attempted an install and failed opening its SQLite store; the invocation override above resolved it without installing dependencies independently.

JSDOM checks event rows and list `scrollTop` writes, not browser pixel layout. Native Electron behavior, Windows/macOS rendering, accessibility announcements, desktop scrolling, packaging and Defender scanning were not executed for this feature. No push or integration is requested; commit stays on this local feature branch.

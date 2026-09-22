# JEV Monitor Bar

全平台、Windows 优先的只读决策监视小窗。宿主发送摘要事件 → 本地鉴权接收 → 追加日志 → Electron/React 小窗。此仓库独立于 `jev_zzz`。

> 状态：开发中，尚不可用。目前只有事件协议、接收服务、持久化、状态聚合与脱敏等核心模块及其测试；桌面小窗、UI、Python 发送器和演示尚未实现。进度见 [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md)，已知问题见 [`docs/AUDIT.md`](docs/AUDIT.md)。

## 平台支持

| 平台 | 级别 | 现状 |
| --- | --- | --- |
| Windows 10/11 x64 | Tier 1（优先） | 核心模块在 CI 测试；桌面窗口未实现 |
| macOS、Linux X11、Windows arm64 | Tier 2（后续适配） | 核心模块在 CI 测试；桌面窗口未实现 |
| Linux Wayland | Tier 3（尽力而为） | 多数合成器不允许应用置顶或自定位窗口 |

平台约束与目录约定见 [`JEV_MONITOR_AGENT_PROMPT.md`](JEV_MONITOR_AGENT_PROMPT.md)「平台支持策略」。

## 开发

需要 Node.js 22+ 与 pnpm 11（版本见 `package.json` 的 `packageManager`）。

```bash
pnpm install
pnpm typecheck
pnpm test
```

只跑核心测试时可设置 `ELECTRON_SKIP_BINARY_DOWNLOAD=1` 跳过 Electron 二进制下载。

## 已核实的边界（2026-09-23）

- [Python SDK](https://docs.typesafe.ai/sdk/python) 是 `typesafe-sdk`，`TypeSafeClient.system_one` 返回各问题答案；[JavaScript SDK](https://docs.typesafe.ai/sdk/javascript) 是 `@typesafe-ai/sdk`，使用 `systemOne`。监视器不发模型请求、不固定模型版本。
- [Choice](https://docs.typesafe.ai/primitives/choice) 有 `choice/probabilities/confidence`；[Score](https://docs.typesafe.ai/primitives/score) 是有序等级位置（可为小数），有概率、legend 和 confidence；[Noul](https://docs.typesafe.ai/primitives/noul) 为 yes 概率，没有独立 confidence。
- [Confidence](https://docs.typesafe.ai/confidence) 描述分布集中程度，不是任务成功率。请求期间不生成概率；不读取或生成模型隐藏思考。
- 查阅官方文档、[agent skill 索引](https://docs.typesafe.ai/agent-skill)及针对 monitor/observability/events 的检索，未找到可直接复用且具有独立置顶窗口、实际执行与验证关联的官方工具。这是有限调查，不声称此类工具不存在。`llms.txt` 的 web 抓取失败，使用官方各页面核对。
- 当前可用技能目录没有 TypeSafe skill。参考项目 `JevJudgment` 与架构已只读检查：判断含 next_action、概率、confidence、latency、request_id、goal/stuck Noul、danger Score。现有 JSONL 用 `ts/kind`，不是本项目协议，需要显式适配；未读取 `.env`，未修改参考项目。
- 采用 Electron 隔离窗口和 JSONL 有界保留；本地服务不接受浏览器跨域调用。Python 发送器仅用标准库。许可证由仓库所有者决定，暂未授予开源许可证。

## 协作

本项目由多个 AI 模型接力开发。每完成一项任务都要提交并推送到 GitHub，提交和实施记录中标注模型署名（如 `Cursor-Claude`）。规则见 [`AGENTS.md`](AGENTS.md)。

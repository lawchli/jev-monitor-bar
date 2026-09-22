# JEV Monitor Bar

Windows 优先的只读决策监视小窗。宿主发送摘要事件 → 本地鉴权接收 → 追加日志 → Electron/React 小窗。此仓库独立于 `jev_zzz`。

## 已核实的边界（2026-09-23）

- [Python SDK](https://docs.typesafe.ai/sdk/python) 是 `typesafe-sdk`，`TypeSafeClient.system_one` 返回各问题答案；[JavaScript SDK](https://docs.typesafe.ai/sdk/javascript) 是 `@typesafe-ai/sdk`，使用 `systemOne`。监视器不发模型请求、不固定模型版本。
- [Choice](https://docs.typesafe.ai/primitives/choice) 有 `choice/probabilities/confidence`；[Score](https://docs.typesafe.ai/primitives/score) 是有序等级位置（可为小数），有概率、legend 和 confidence；[Noul](https://docs.typesafe.ai/primitives/noul) 为 yes 概率，没有独立 confidence。
- [Confidence](https://docs.typesafe.ai/confidence) 描述分布集中程度，不是任务成功率。请求期间不生成概率；不读取或生成模型隐藏思考。
- 查阅官方文档、[agent skill 索引](https://docs.typesafe.ai/agent-skill)及针对 monitor/observability/events 的检索，未找到可直接复用且具有独立置顶窗口、实际执行与验证关联的官方工具。这是有限调查，不声称此类工具不存在。`llms.txt` 的 web 抓取失败，使用官方各页面核对。
- 当前可用技能目录没有 TypeSafe skill。参考项目 `JevJudgment` 与架构已只读检查：判断含 next_action、概率、confidence、latency、request_id、goal/stuck Noul、danger Score。现有 JSONL 用 `ts/kind`，不是本项目协议，需要显式适配；未读取 `.env`，未修改参考项目。
- 采用 Electron 隔离窗口和 JSONL 有界保留；本地服务不接受浏览器跨域调用。Python 发送器仅用标准库。许可证由仓库所有者决定，暂未授予开源许可证。

安装、接入与验证说明随实现补齐。开发过程按功能保留本地 Git 提交，不创建或推送远端。

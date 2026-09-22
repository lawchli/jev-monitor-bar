# 审计记录

每次审计追加一节，写明审计者署名。问题状态更新时在原条目后补一行说明，不删除历史条目。

## 2026-09-22 审计（Cursor-Claude）

范围：`JEV_MONITOR_AGENT_PROMPT.md`、README、`docs/IMPLEMENTATION.md`、仓库结构，以及 `src/` 下全部代码（协议、存储、状态聚合、接收服务、脱敏）。

结论：计划方向合理（只读观测、协议先行、模型判断/应用决策/执行验证三者分离、明确不伪造思考过程和概率），核心代码设计也基本正确；但项目只完成了 M0 和 M1 的一部分，并且存在类型检查不通过、会丢数据的脱敏 bug、仓库脚本引用不存在的文件等问题。桌面壳、UI、Python 发送器、演示、测试脚本均尚未开始。

### 计划文档

| # | 问题 | 处理 |
| --- | --- | --- |
| P1 | 要求「无授权不推送 GitHub」，与仓库所有者「每完成一项任务都要推送」的要求冲突 | 已改为每项任务提交推送，另立 `AGENTS.md` |
| P2 | 平台只写了「优先支持 Windows」，没有跨平台约束，后续 macOS/Linux 适配容易被 Windows 专用写法卡住 | 已新增「平台支持策略」：分级表、路径/目录/凭证/置顶/DPI/文件锁/CI 约束 |
| P3 | 未规定会话凭证与数据目录位置；Electron 默认 `userData` 在 Windows 位于 Roaming，凭证可能随漫游同步 | 已规定三平台目录与环境变量覆盖 |
| P4 | 未规定 `producer_id` 唯一性；发送端重启复用 ID 和序号时，新事件会被当作重复静默丢弃 | 已写入协议规则，代码改为返回 409 |
| P5 | 未规定脱敏范围，实现对候选名按键名脱敏导致数据损坏（见 C2） | 已写明各字段的脱敏方式 |
| P6 | 没有多模型协作、署名、进度登记规则 | 已新增 `AGENTS.md` 和实施记录模板 |
| P7 | 实施顺序没有可追踪状态，接手者难以判断从哪里继续 | 改为 M0–M5 里程碑，状态记录在 `docs/IMPLEMENTATION.md` |
| P8 | Electron 与 Tauri 的取舍缺少跨平台理由 | 已补：Electron 自带 Chromium，三平台渲染与置顶行为更一致 |
| P9 | 验收要求未区分平台，Linux 云端 agent 可能把构建通过误当作 Windows 窗口已验证 | 已要求截图/录屏注明平台，未在对应平台验证的一律列为未验证 |

### 仓库结构

| # | 问题 | 处理 |
| --- | --- | --- |
| S1 | `package.json` 的 build/start/demo/soak/desktop-test 引用了不存在的 `scripts/`；test 引用不存在的 `tests/` | 已删除失效脚本，test 现有对应测试；后续里程碑按需重新加入 |
| S2 | `package` 脚本写死 `--platform=win32` | 已删除；打包要求见 prompt，M5 实现 |
| S3 | `.pnpm-store/v11/index.db` 被提交进仓库 | 已取消跟踪并加入 `.gitignore` |
| S4 | `package.json` 的 `pnpm.onlyBuiltDependencies` 已被 pnpm 11 忽略（与 `pnpm-workspace.yaml` 的 `allowBuilds` 重复） | 已删除 |
| S5 | 没有 `.gitattributes`，Windows 检出可能产生 CRLF 差异 | 已新增，统一 LF |
| S6 | 没有测试和 CI | 已新增 `tests/core.test.ts` 和三平台 CI |
| S7 | README 写「不创建或推送远端」，与现状不符 | 已更新 |

### 代码

| # | 严重度 | 问题 | 处理 |
| --- | --- | --- | --- |
| C1 | 高 | `pnpm typecheck` 失败（`src/protocol.ts` 类型断言） | 已修复 |
| C2 | 高 | 脱敏按键名替换 `candidates`/`probabilities` 等字典的值：候选名含 password/token/env/prompt 时概率变成 `[REDACTED]`，重启恢复时整条事件被判为损坏并丢失 | 已修复并加测试 |
| C3 | 高 | 同一 producer 序号出现新 `event_id` 时返回 200 `accepted:false`，发送端无法察觉事件丢失 | 已改为 409 conflict 并加测试 |
| C4 | 中 | 事件超过 64 KiB 时在读取循环中直接返回，会销毁 socket，413 响应可能写不出去 | 已改为先看 Content-Length，分块请求排空后再响应，并加测试 |
| C5 | 中 | Windows 上旧段文件被占用时 `unlinkSync` 抛错，事件已落盘却返回 503，引起重发 | 已改为忽略并在下次轮转重试，并加测试 |
| C6 | 中 | 重启恢复时 cursor 只从有效行取最大值；若末尾是损坏行，其 cursor 会被重新分配，续传客户端可能漏事件 | 待办（M2 续传实现前处理）。P1-02 已处理：恢复时能 `JSON.parse` 出安全整数 `cursor` 的行计入高水位，即使未通过校验；完全无法解析的行不计 |
| C7 | 中 | run 上限 200 按插入顺序淘汰，可能淘汰仍在运行的 run | 待办：优先淘汰已结束的 run。P1-02 已处理：超过 200 个 run 时，先淘汰 `ended_at` 已设置且 `last_received` 最早的 run；没有已结束的 run 时，再淘汰 `last_received` 最早的 run |
| C8 | 中 | 去重集合随内存保留窗口（20,000 条 / 32 MiB）淘汰，窗口外重发会被再次接受 | 已写入协议说明；是否需要持久化索引待负载测试后决定 |
| C9 | 低 | 会话文件 `mode:0o600` 只在新建时生效、写入非原子；Windows 上 mode 无效 | 待办（M2，按 prompt 平台策略实现）。P1-02 已处理：会话文件先写入临时文件再 `rename` 覆盖，遇到 `EPERM`/`EBUSY`/`EACCES` 重试 5 次；之后 `chmod` 0600；关闭接收端时只删除 token 匹配的会话文件。删除遇到同样的锁错误会重试，`ENOENT` 忽略，token 已变则停止。退出时清理失败会记入 `storageError` 并告警，退出仍完成。Windows 上 `mode`/`chmod` 仍不改变 ACL |
| C10 | 低 | 每条事件同步 `appendFileSync`，Windows 杀软环境下可能偏慢 | 待办：M5 负载测试时评估；批量写入须保留「落盘后才确认」语义 |
| C11 | 低 | 跨 producer 的先后顺序依赖发送端时钟，多机或时钟偏差时可能误判 | 待办：写入协议说明 |
| C12 | 低 | 代码高度压缩（多语句单行），多模型接力时不利于审查 | 建议单独一次提交引入格式化工具 |

## 2026-09-22 补充（Cursor-Claude）

仓库所有者澄清了提交节奏，并提出原生兼容与杀毒软件友好的要求。

| # | 问题 | 处理 |
| --- | --- | --- |
| P1 更正 | 上一节 P1 把要求误解为「每完成一项任务就 commit 并 push」。实际要求是：小任务完成后 `git add` 暂存在本地，大功能或大方向完成后再 commit 并 push；云端 agent 会话结束前须推送到自己的分支 | `AGENTS.md`、prompt、README 已改。此前已推送的 8 个细粒度提交保留，不改写历史 |
| P10 | 计划没有要求「免额外组件」：没有限制原生扩展、安装脚本和外部运行时，也没有规定是否需要管理员权限 | prompt 新增「免额外组件」；新增 `tests/deps.test.ts` 检查运行时依赖（当前 ajv、react、react-dom 及其依赖均为纯 JS，无安装脚本） |
| P11 | 计划没有考虑 Windows 杀毒软件误报：签名、版本信息、单文件自解压、子进程、注册表自启、Electron 调试入口等 | prompt 新增「Windows 杀毒软件友好」与验收项（全新 Windows 解压即用、Defender 扫描记录） |
| P12 | 提交只标注模型署名，没有标注执行环境，GitHub 提交列表里也看不到署名 | 提交标题加 `[署名]`，正文加 `Agent-Model`（含具体模型名称）与 `Agent-Env` |

P12 后续：仓库所有者改为按运行位置区分。Cursor 云端 agent 直接用 Cursor Agent 账号提交；本地开发记录小写的 harness 与 model（`[<harness>/<model>]`、`agent-harness` / `agent-model`）。旧格式作废，已有提交不改写。见实施记录 04。model 只记厂商和系列、不写版本号（如 `claude-opus`、`gpt-sol`），见实施记录 05。

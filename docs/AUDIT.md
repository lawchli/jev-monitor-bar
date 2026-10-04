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

## 2026-09-23 全分支方向审计（codex/gpt-astra）

根目录报告：[`AGENT_DIRECTION_AUDIT.md`](../AGENT_DIRECTION_AUDIT.md)。后续 agent 接手时一并阅读。

本次覆盖 GitHub 全部 13 个现存远端分支（main 基线 `cd99afb`）、11 个开放 draft PR 及各 HEAD 的 CI。结论：产品定位和基本架构方向正确，当前主要风险是功能切片尚未集成，以及既有绿灯测试未覆盖真实闭环缺陷。

报告 A1–A10 登记：选定动作被写成已执行、Python 序列化导致 worker 退出、默认重定向绕过 loopback、历史分页不可达、导出绕过脱敏、跨段导出丢事件、回放焦点淘汰、开发 fresh 清理边界、聚合内存口径和文档状态偏差。明确区分生产函数复现、源码确认、风险前提和未执行验证；给出分支表、CI 链接、接续顺序与验收条件。

本次没有修复应用代码，不能把上述条目标为已解决。先前 C6–C12 的解决状态还必须区分“已有修复分支”与“已进入 main”；尤其 C6 的 P1-02 修复只覆盖可解析 JSON 的 cursor，高水位对完全损坏尾行的保证仍有限。

## 2026-09-23 集成前 HEAD 复核

审计快照之后重新 fetch：P1-01 为 `81e0117`（报告 `c5a3a18`），P1-07 为 `cc0981f`（报告 `c44e074`），P1-08 为 `de08926`（报告 `b862958`），P1-09 为 `dcf879c`（报告 `94d1f01`）。其余 9 个分支 HEAD 与报告一致，含 `main@cd99afb`。分支表见 `AGENT_DIRECTION_AUDIT.md` 文末「集成前 HEAD 复核」。新提交没有把 A1–A10 标成已解决；A1、A4 在 P1-06 `8256599` 上仍无后续提交。

## 2026-09-23 A10 文档更正（cursor-cloud-agent / grok）

本次只对照集成分支上的代码更正文档，不改应用行为。上面的 C6 原行保留：重启恢复曾经只从校验通过的行取 cursor，这个问题没有被写成从未存在。

C6：P1-02 以及现在的集成分支只保住可解析 JSON 的 cursor。恢复时 `JSON.parse` 成功且 `cursor` 为安全整数的行会计入高水位，即使 `validateEvent` 失败。完全 torn、无法 `JSON.parse` 的行仍然没有高水位，只计入 `corruptLines`。

演示 reconnect 若只是停发几十秒，并不等于验证了进程重启、凭证轮换和队列补发。P1-00 的边界守卫只扫描 `src` 里的 TypeScript 字符串，不覆盖 Python 重定向，也不能证明发布包不联网。

## 2026-09-30 C10 常开段文件（claude-code / claude-opus）

上面 C10 原行保留。本次按记录 23 的负载结果改了 `src/store.ts`，C10 改为部分处理：

- 每个段只打开一次，每条事件用 `writeSync` 写完整行后才确认，仍不 fsync。写入出错时关闭当前段并返回 503，下一条事件重新打开；如果已经写出半行，下一条换新段。
- 旧段只在启动时、新段写入第一行后清理；删除失败时至少 1 秒后再试，不再每条事件 `readdirSync`。
- `droppedRuns` 最多 200 个，与 run 上限相同。超出时先去掉已不在 run 列表里、事件最早移出内存窗口的 run；仍在列表里的 run 保留标记，时间线仍能写「更早的事件已超出保留窗口」。
- 桌面退出时，先关接收端，再关当前段。
- macOS arm64 实测（机器上同时有其他 agent，负载 3–20）：20,000 条 403 B 行的隔离基准中，ingest p50 从 48–55 µs 降到约 12 µs。`pnpm loadtest --duration 3m --rate 25 --runtime node --no-probe` 基线与分支交替运行：单次落盘调用 p50 从 0.18–0.24 ms 降到 0.04–0.07 ms，`readdirSync` 从 4,504 次降到 6 次。
- 写入仍是同步的。分支第二轮出现一次 518 ms 的 `writeSync` 卡顿，文件系统卡顿仍会停住主进程，只是每条事件的系统调用从打开、写、关闭、列目录减到一次写。Windows 与杀软环境未测。

## 2026-09-30 合并前审计（claude-code / claude-opus）

对 `claude/m5-integration@4841493`（含 PR #14 与 #15）和两个后续分支 `claude/c10-store-writes@446c734`、`claude/replay-window@0932f9a` 做只读审计。能跑的都写了探针实跑，不能跑的写明是读代码得出的。结论：没有严重或高危问题，不阻断合并 `main`。基线 `pnpm typecheck` 通过、`pnpm test` 165/165、`pnpm audit --prod` 无已知漏洞。

| 编号 | 级别 | 问题 | 状态 |
| --- | --- | --- | --- |
| M1 | 中 | 脱敏会把 "token=a" 变长，4096 字的正文入库后超出协议上限，重启和导出时被当作坏行丢掉，发送端却已收到确认 | 已修（记录 28） |
| M2 | 中 | 自由文本脱敏漏掉常见写法：带引号的值（JSON、Python repr）、`AWS_SECRET_ACCESS_KEY=`、`ghp_`/`xoxb-`/`AKIA`、JWT、URL 里的用户名密码、`Cookie:`、PEM；`Authorization: Basic …` 只替换了 `Basic`。PROTOCOL.md 与 INTEGRATION.md 把能力写多了 | 待办 |
| M3 | 中 | 已结束的 run 被淘汰后，再来一条迟到事件会把它重建成未结束的 run（名字变成 id、模拟标记丢失），持续心跳时一直不再被淘汰 | 待办 |
| L1 | 低 | 401/403 不断开连接，未鉴权的本机进程占满 32 个连接时发送端被拒 | 已修（记录 28） |
| L2 | 低 | file:// 页面上 CSP 的 `'self'` 匹配所有本地文件；子框架可加载本地文件 | 部分修复（记录 28）：禁止子框架与 worker，拦下所有框架导航。页面里注入的 `<script src="file://…">` 仍能加载，根治需改为自定义协议加载渲染页（同时可以关掉 GrantFileProtocolExtraPrivileges fuse）。界面没有 HTML 注入点 |
| L3 | 低 | 某个段文件读不了（Windows 扫描器占用）时，启动和导出直接失败 | 待办 |
| L4 | 低 | `run.started` 所在的段被清理后重启，run 丢失名字和「模拟」标记 | 待办 |
| L5 | 低 | Python 发送器在当前目录被删除时构造函数抛异常 | 待办 |
| L6 | 低 | Python 发送器不感知 fork：子进程里 emit 返回 True 但不发送 | 待办 |
| L7 | 低 | 淘汰已结束的 run 时按字符串比较带时区偏移的 `ended_at` | 已修（记录 28） |
| B1 | 低 | 写出除换行外的整行后失败，下一条事件复用同一个 cursor，重启后时间线只显示其中一条 | 已修（记录 28） |
| B3 | 低 | 外部程序删除正在写的段文件后，已确认的事件写进被删除的文件 | 已记录（记录 26），可选加固：检查 `nlink` |
| I1 | 信息 | 不检查 Host 头；有 token 与 Origin 拒绝，DNS rebinding 拿不到 token，不构成漏洞 | 保持 |
| I2 | 信息 | 没有 `setPermissionCheckHandler`，权限查询报 granted（实际请求已拒绝） | 已修（记录 28） |
| I3 | 信息 | 段文件 0644、`events/` 0755，依赖数据目录 0700 | 待办 |
| I4 | 信息 | Python 发送器接受 NaN，接收端之后回 400 | 待办 |

回放后续分支的审计补充：主进程里被保留的事件都脱敏后才过 IPC，略过的旧行不出主进程；检查点与从头计算在 1,200 次随机跳转、多种间隔下 0 差异；`snapshot()` 只复制一层，payload 与事件对象共用，渲染端目前不改它们，测试没覆盖对 payload 的修改。审计未在 Windows 上执行，未运行发布包。

## 2026-10-04 Python 会话边界补充（codex/gpt-sol）

PY-B1：原来的会话 JSON 读取没有字节预算，token 也没有 header 字符/长度检查。过大的本地文件可造成不必要的内存分配；换行等无效凭证会在发送阶段丢掉已入队事件。记录 36 限制读取为 16 KiB，凭证为 1–1024 个可见 ASCII 字符，解析异常视为离线。Linux Python 3.13 完整投递与会话恢复测试通过；不冒充其他平台验证。

AD-B1：原来的回放文件先按路径 stat，再无界 `readFileSync`，两者之间的增长/替换可绕过 50 MiB 限制。记录 37 改为同一描述符检查与有界读取，增加真实文件竞态、部分读取和错误清理测试；特殊文件在非阻塞打开后拒绝。Linux 验证通过，Windows / macOS 待对应环境。

ST-B1：`applyEvent` 曾仅按 action/attempt ID 判断是否更新尝试，合法的上下文心跳会创建未知尝试并污染运行状态/重试。记录 38 增加事件类型门槛，实时与两种回放回归通过；真实动作和验证保持原语义。

UI-B1：规则卡的冒号拼接 ID 不是无歧义元组，模型 ID 也可与之相同；普通对象展开表对 prototype 名称读到继承值。记录 39 改为带 run/类别的元组 key 与 Map，真实 DOM 的碰撞/独立展开回归通过。

## 2026-10-04 段文件编号边界（codex/gpt-sol）

FS-B1：原段文件枚举只接受八位编号，`events-99999999.jsonl` 之后确认写入的九位文件被重启、导出和清理忽略。记录 40 支持更长的安全整数编号并按数字排序；编号耗尽在写入前失败，半行写盘错误也不会重开损坏的最后一段。Linux 专用和完整回归通过，未冒充 Windows / macOS 文件行为验证。

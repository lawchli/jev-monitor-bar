# JEV Monitor 事件协议 v1

本文只写当前代码的行为：`src/protocol.ts` 的校验、`src/server.ts` 的接收、`src/session.ts` 的会话文件、`src/paths.ts` 的路径、`src/store.ts` 的保存、去重与导出、`src/state.ts` 的状态聚合、`src/redact.ts` 的脱敏，以及 `python/jev_monitor/sender.py` 对会话 URL 的接受范围。代码里没有的规则，下文不把它说成已经生效。

## 版本与传输

- 版本字段 `schema_version` 必须为 `1`。
- 接收端只监听 `127.0.0.1`，不监听 `0.0.0.0`。`startServer` 的端口参数默认是 `0`，由系统分配。
- 发送一条事件：`POST /events`。正文是一个 JSON 对象。`Content-Type` 必须以 `application/json` 开头（可以带 `; charset=utf-8`）。
- 鉴权头是 `Authorization: Bearer <token>`。前缀 `Bearer ` 区分大小写。token 来自会话文件，比较用的是长度检查加 `timingSafeEqual`。
- 单条上限是 64 KiB，也就是 65536 字节。请求若带 `Content-Length` 且大于 65536，直接拒绝；没有这个头时读完整段正文，超过 65536 同样拒绝。正好 65536 字节可以接受。
- 响应都是 JSON，并带 `Cache-Control: no-store`。请求处理顺序如下：

| 状态码 | 条件 | 正文 |
| --- | --- | --- |
| 403 | 带有 `Origin` 头，或对端地址不是 `127.0.0.1`、`::1`、`::ffff:127.0.0.1` | `{error:"Origin rejected"}` |
| 401 | Bearer 缺失、长度不同或不匹配 | `{error:"Local session credential required"}` |
| 200 | `GET /health` | `{ok:true, cursor}` |
| 404 | 不是 `GET /health`，也不是 `POST /events` | `{error:"Not found"}` |
| 415 | `POST /events` 的 Content-Type 不符合 | `{error:"JSON required"}` |
| 413 | 正文超过 65536 字节 | `{error:"64 KiB event limit"}` |
| 400 | JSON 无法解析 | `{error:"Invalid JSON"}` |
| 400 | 读正文时中断 | `{error:"Incomplete request"}` |
| 400 | `validateEvent` 失败（这种错误没有 Node 的 `code`） | `{error:"Invalid protocol event"}` |
| 503 | 落盘抛出带 `code` 的异常 | `{error:"Storage unavailable"}` |
| 200 | `event_id` 已在去重窗口内 | `{accepted:false, cursor}`，不再写入 |
| 409 | `run_id` + `producer_id` + `sequence` 已占用，但是新的 `event_id` | `{accepted:false, conflict:true, cursor}`，不写入 |
| 200 | 新事件已经写入 | `{accepted:true, cursor}` |

`cursor` 从 1 开始，每接受一条新事件加 1。接收端另外记下 `received_at`（接收时刻的 ISO 时间）和这个 `cursor`。发送 schema 不允许额外字段，所以发送时不要带 `received_at` 或 `cursor`。

健康检查和投递使用同一个 token。`requestTimeout` 是 2 秒，`headersTimeout` 是 3 秒，`maxConnections` 是 32。

## 会话文件与数据目录

`startServer(store, sessionFile)` 在开始监听之后把会话写成 JSON：

```json
{"url":"http://127.0.0.1:<端口>","token":"<64 位十六进制>"}
```

token 是 32 个随机字节的 hex。会话里的 `url` 由接收端写成 `http://127.0.0.1:<端口>`，没有路径，也没有 token。接收端只 `listen` `127.0.0.1`。Python 发送端只接受 `http://127.0.0.1`，端口可以省略；`localhost`、其他主机、userinfo、query、fragment，以及除空路径和 `/` 以外的路径都会被拒绝。通过后 origin 收成 `http://127.0.0.1` 或 `http://127.0.0.1:<端口>`，再接上 `/events`。301、302、303、307、308 重定向一律拒绝。

`writeSessionFile` 先把 JSON 写到 `<会话文件>.<pid>.<16 位十六进制>.tmp`（`writeFileSync`，mode 为 `0o600`），再 `rename` 盖掉目标。`rename` 遇到 `EPERM`、`EBUSY` 或 `EACCES` 时最多再试 5 次，第 n 次重试前等待 20×n 毫秒；其他错误删掉临时文件后抛出。替换成功后尝试 `chmod` 0600，失败则忽略。Windows 上 `mode` 和 `chmod` 不改变 ACL。

事件目录由调用方传给 `EventStore`。段文件名是 `events-NNNNNNNN.jsonl`（8 位段号）。一段的 JSONL 字节数要再增加就会超过 4194304（4 MiB）时，换下一个段号。只保留最近 8 段；删除更早的段如果遇到文件占用，这次忽略，下次轮转再试。每次新建 `EventStore` 都会新开一个段，不接着写上次没写满的段。空目录里的第一段是 `events-00000001.jsonl`。

读回时按 `\n` 分行。`JSON.parse` 接受行尾的 `\r`，所以 CRLF 文件可以读。没通过校验的行计入 `corruptLines`，不进入状态。重启后的 cursor 高水位：一行只要 `JSON.parse` 成功，并且其中的 `cursor` 是安全整数，就计入高水位，即使 `validateEvent` 失败。完全无法 `JSON.parse` 的行只把 `corruptLines` 加一，不抬高 cursor。

`EventStore` 和 `startServer` 仍使用调用方传入的目录和会话文件。默认位置由 `src/paths.ts` 的 `resolveMonitorPaths` 计算，桌面主进程启动时调用它：

- `JEV_MONITOR_HOME` 非空时覆盖根目录。绝对路径按该平台的 path 规范化；相对路径接到 `cwd` 上。空字符串视为未设置。
- `JEV_MONITOR_SESSION` 非空时单独覆盖会话文件，绝对路径和相对路径的处理与上面相同。未覆盖时为根目录下的 `session.json`。
- 未覆盖根目录时：Windows 使用 `%LOCALAPPDATA%\jev-monitor-bar\`；`LOCALAPPDATA` 为空则用用户主目录下的 `AppData\Local\jev-monitor-bar\`。macOS 为 `~/Library/Application Support/jev-monitor-bar/`。Linux 及其他平台只在 `XDG_STATE_HOME` 为非空绝对路径时采用 `${XDG_STATE_HOME}/jev-monitor-bar/`，否则为 `~/.local/state/jev-monitor-bar/`。相对的 `XDG_STATE_HOME` 不采用。
- 事件放在根下的 `events/`。同一函数还返回 `window-state.json` 和 `electron-profile/`。
- Python `jev_monitor.paths.resolve_paths` 使用同一套根目录、事件目录、会话文件和窗口状态文件规则，不返回 `electron-profile`。

Windows 与 macOS 的默认目录写在代码里，没有在对应系统上实机验收。

## 公共字段

| 字段 | 规则 |
| --- | --- |
| `schema_version` | 常量 `1` |
| `event_id` | 发送端生成的 ID |
| `run_id` | 一次任务 |
| `producer_id` | 一个发送端进程实例 |
| `sequence` | 该 producer 内的序号。整数，最小 0，最大 `Number.MAX_SAFE_INTEGER`（9007199254740991） |
| `occurred_at` | 发送端时钟。必须像 `YYYY-MM-DDT…Z` 或 `YYYY-MM-DDT…±HH:MM`，并且 `Date.parse` 得到有限数值。这是接收端注册的 `date-time` 格式，不是另一套校验器自动具备的 |
| `type` | 下一节列出的 16 种之一 |
| `payload` | 对象。schema 没列出的字段会被拒绝 |
| `decision_id`、`request_id`、`question_id`、`action_id`、`attempt_id` | 只在适用的事件上必填 |

ID 字符串长度 1–160，只允许 `A–Z`、`a–z`、数字和 `_ . : / -`。名称、问题、说明、原因这类普通字符串最长 4096。

事件类型：`run.started`、`run.completed`、`run.failed`、`run.cancelled`、`decision.started`、`decision.resolved`、`decision.failed`、`action.selected`、`action.started`、`action.completed`、`action.failed`、`action.cancelled`、`verification.completed`、`progress.updated`、`heartbeat`、`telemetry.dropped`。

## 各事件类型的必填字段

公共必填字段之外：

| type | 额外必填的顶层字段 | payload 必填 | `validateEvent` 另外拒绝 |
| --- | --- | --- | --- |
| `decision.started` | `decision_id`、`request_id`、`question_id` | `kind`、`question` | |
| `decision.resolved` | 同上 | `kind` | `choice` 却没有 `choice`；`score` 却没有 `score`；`noul` 却没有 `noul` |
| `decision.failed` | 同上 | 无 | |
| `action.selected` | `action_id`、`attempt_id` | `action`、`source` | `source` 只能是 `model`、`rule`、`application` |
| `action.started`、`action.completed`、`action.failed`、`action.cancelled` | `action_id`、`attempt_id` | 无 | |
| `verification.completed` | `action_id`、`attempt_id` | `result`、`checks` | |
| `telemetry.dropped` | 无 | `count` | |
| `run.started`、`run.completed`、`run.failed`、`run.cancelled`、`progress.updated`、`heartbeat` | 无 | 无 | |

下面这些不在 JSON Schema 的 `required` 里，但 `validateEvent` 会拒绝：

- `kind` 为 `noul` 时不能带 `confidence` 或 `probabilities`。
- `probabilities` 的每个值都在 0 到 1，总和与 1 的差不能大于 0.02。
- `completed` 和 `total` 同时存在时，`completed` 不能大于 `total`。
- 有 `rule` 就必须有 `rule_source`。有 `explanation` 就必须有 `explanation_source`。

`kind` 只能是 `choice`、`score`、`noul`。`result` 以及每条 check 的 `result` 只能是 `passed`、`failed`、`unknown`。`checks` 为 1–50 条，每条必填 `name`、`observed`、`result`，`evidence` 可选。`score`、`latency_ms` 是 ≥0 的数。`noul`、`confidence` 在 0 到 1。`count`、`completed`、`total`、`retry` 是 ≥0 的整数。

`candidates`、`probabilities`、`legend`、`usage` 最多 255 项。键最长 160，不能是 `__proto__`、`constructor`、`prototype`。`candidates` 的值是字符串或 `null`。`diagnostic` 在 schema 里可以是任意 JSON，入库时的处理见脱敏一节。

`run.started` 常用 `payload.name` 和 `payload.simulated`。模拟数据把 `simulated` 设为 `true`。聚合时如果这条字段缺失，`simulated` 记为 `false`。

## ID 关联规则

- 同一次判断共用一个 `decision_id`。三种 `decision.*` 事件还要带 `request_id` 和 `question_id`。同一个 `decision_id` 上，如果后到的事件换成了另一个 `request_id` 或 `question_id`，这条事件不更新该判断，`anomalies` 加 1。事件仍然计入 `event_count`，并且可能成为 `latest`。
- 同一个 `request_id` 可以对应多个 `question_id`，也就是多个 `decision_id`。一次请求里并发的两个问题用这种方式关联。
- 一次执行尝试的身份是 `action_id` 加 `attempt_id`。重试沿用 `action_id`，换一个新的 `attempt_id`。
- 尝试可以带 `decision_id`，表示它执行的是哪次判断。这个尝试已经记下 `decision_id` 之后，又来了另一个 `decision_id`，则不更新这次尝试，`anomalies` 加 1。
- `action.selected` 可以不带 `decision_id`。`source` 为 `rule` 且没有 `decision_id`，表示规则直接选定动作，不是某次 JEV 判断的结果。
- 判断的 `choice` 和动作的 `action` 可以不同。不同表示最终执行的不是模型选中的那一项；覆盖时带上 `rule` 和 `rule_source`。

每个 run 最多留 500 个 decision 和 500 个 attempt。超出时删掉最早插入的一项，并把该 run 的 `limited` 设为 `true`。内存里最多 200 个 run。超出时优先淘汰已经结束（`ended_at` 已有）且 `last_received` 最早的；没有已结束的 run 时，淘汰 `last_received` 最早的。

## 身份与去重

接收端实际强制的是两把钥匙：`event_id`，以及 `run_id` + `producer_id` + `sequence`。它不另外检查 `producer_id` 是否真的每个进程都不同。代码注释把「序号已占用但 `event_id` 是新的」解释为发送端重启后复用了原来的 `producer_id`；这种情况返回 409，发送端应告警，不要当成已经送达。相同 `event_id` 再送一次返回 200 且 `accepted` 为 `false`。

这两套集合只覆盖内存窗口：最多 20000 条，并且这些条 `JSON.stringify` 之后的字节数合计不超过 32 MiB。滑出窗口的事件会从两个集合里删掉。窗口之外的旧事件再送一次，可能被再次接受，并再次计入状态（C8）。要不要另做持久化的去重索引，留到负载测试之后再定。

`sequence` 的 schema 从 0 起接受。本仓库的固定场景文件从 1 严格递增，那是场景数据的约定，不是校验器的下限。

## 排序与时钟

同一 `producer_id` 内，`sequence` 更大的事件更新。这个比较不看 `occurred_at`。

不同 `producer_id` 之间，先比 `occurred_at` 的数值；时间字符串相同，再比 `event_id` 的字典序。跨 producer 的先后因此取决于发送端时钟（C11）。时钟倒退或两台机器有偏差时，另一路更晚的时间戳可以盖过这一路更大的序号。

`heartbeat` 和 `telemetry.dropped` 不更新 run 的 `latest`。其他类型在通过上面的比较时成为 `latest`。`progress.updated` 只有在它成为更新的那条时才覆盖 `progress`。

`run.completed`、`run.failed`、`run.cancelled` 不走这套比较。它们只看 `occurred_at`：比已记录的 `ended_at` 更晚才覆盖结束时间和 run 状态；相同或更早则忽略。因此同一 producer 上，序号更大但 `occurred_at` 更早的结束事件，不会替换已经记下的结束状态。

## 状态机

存下来的状态是英文记号。`src/state.ts` 的 `labels` 只供界面显示中文。

| 记号 | 中文 | 在什么情况下出现 |
| --- | --- | --- |
| `waiting` | 等待 | run 的初值。`run.started` 不改变它 |
| `evaluating` | 评估中 | 判断已开始，还没有 resolved 或 failed |
| `selected` | 已选择 | 判断已 resolved；或尝试只有 `action.selected` |
| `executing` | 执行中 | 尝试已 `action.started`，还没有终态和验证 |
| `unverified` | 已执行待验证 | 尝试已 `action.completed`，还没有验证 |
| `passed` | 验证成功 | 验证的 `result` 为 `passed` |
| `verification_failed` | 验证失败 | 验证的 `result` 为 `failed` |
| `failed` | 失败 | `decision.failed`、`action.failed` 或 `run.failed` |
| `cancelled` | 取消 | `action.cancelled` 或 `run.cancelled` |
| `unknown` | 未知 | 判断记录的初值；验证 `result` 为 `unknown` 时尝试也是这个记号 |
| `completed` | 任务结束 | `run.completed` |

判断和尝试的状态是每次用已保存的事件重算的，不是一张只允许前进的转移表。缺了中间事件也可以算出一个状态，例如没有 `action.started` 的 `action.completed` 就是 `unverified`。

判断：

- 有 `decision.failed`，并且它比 `decision.resolved` 更新（或还没有 resolved）→ `failed`。
- 否则只要有 `decision.resolved` → `selected`。
- 否则 → `evaluating`。
- 同一类事件只保留更新的那一笔。更旧的 resolved 不会把已经失败的判断改回 selected；更新的 resolved 会。
- `payload` 先放 `decision.started` 的 payload，再叠上胜出的那一笔终态（resolved 或 failed）。另一笔终态的 payload 不合并。
- 新建判断时的初值是 `unknown`，处理完这条 `decision.*` 事件后就会改成上面三个之一。

尝试，优先级从高到低：

1. 终态是 `action.failed` → `failed`。已经有验证也停在 `failed`。
2. 终态是 `action.cancelled` → `cancelled`。同样优先于验证。
3. 有验证：`result` 为 `failed` → `verification_failed`；否则状态就是 `result` 本身（`passed` 或 `unknown`）。
4. 有 `action.completed` → `unverified`。动作完成不等于验证通过。
5. 有 `action.started` → `executing`。
6. 有 `action.selected` → `selected`。
7. 否则 `unknown`。

run：

- 新建为 `waiting`。`run.started` 不改这个状态。
- 名称：payload 里有 `name` 就覆盖。`simulated` 按该条 payload 重写，缺省为 `false`。`started_at` 只取第一笔 `run.started` 的 `occurred_at`。这三件事不比较序号，后处理到的 `run.started` 仍会改名称和 `simulated`。
- run 还没有 `ended_at` 时，一条更新的判断或尝试事件把 run 状态设成该判断或该尝试的状态。同一条事件先处理判断、再处理尝试，所以两者都有时，run 状态跟着尝试。
- `run.completed` / `run.failed` / `run.cancelled` 把状态设为 `completed` / `failed` / `cancelled`，并写下 `ended_at`。之后的判断和尝试仍更新自己的记录，但不再改 run 状态。只有 `occurred_at` 更晚的另一笔结束事件能替换它。
- `telemetry.dropped` 把 `payload.count` 加进 `dropped`。不要求它是最新事件。
- `metrics` 不读取 `payload.retry`。有验证的尝试按那次 `result` 计入 `passed` / `failed` / `unknown`；`action.completed` 且没有验证计入 `unverified`。`action.failed` 本身不加进 `failed`。同一个 `action_id` 的尝试数减 1，再加总，就是 `retries`。没有验证的完成不算成功。

## Choice、Score、Noul

三者用 `kind` 区分，不要收成同一种「信心百分比」。

- Choice：`choice` 是选中的候选键。`probabilities` 是各候选的概率，总和约为 1。`candidates` 把候选键映射到说明，说明可以是 `null`。
- Score：`score` 是有序等级上的位置，可以是小数；schema 只要求 ≥0。`legend` 给出刻度的文字。可以另外带 `probabilities`。
- Noul：`noul` 是「是」的概率，范围 0 到 1。没有单独的 confidence，也没有选项分布；带了会被拒绝。

`confidence` 描述的是分布有多集中，不是这次判断的正确率，也不是任务成功率。还没有 `decision.resolved` 时，接收端不会编造概率；概率只来自已经写入的 payload。没有 `explanation` 就是没有说明。接收端不会另调模型去补一句理由。

## 脱敏

入库前只处理 payload。各种 ID、`type`、`sequence` 和时间不改。

- 自由文本里，`Bearer` 后面的凭证、`sk-` / `ts-` / `key-` 后接至少 12 位的记号，以及 `api_key`、`password`、`secret`、`token`、`authorization` 用 `=` 或 `:` 带上的值，换成 `[REDACTED]`。
- 对象的键名若匹配 authorization、cookie、password、secret、token、api key、credential、environment、`env`、raw input、prompt、`state`，整个值换成 `[REDACTED]`。
- `candidates`、`probabilities`、`legend`、`usage` 的键是调用方起的名字，不按键名替换，只对值做文本脱敏。`usage` 走 `dictionary(num)`，值必须是 ≥0 的数字。非数字值在入口 `validateEvent` 失败，整条事件被拒绝，不是脱敏时静默丢掉该字段。
- 默认删掉 `diagnostic`。只有 `EventStore` 以诊断模式构造时才保留，并按键名和内容脱敏。
- 嵌套超过 12 层写成 `[TRUNCATED]`。数组只留前 255 项。键名 `__proto__`、`constructor`、`prototype` 会丢掉。

不要把秘密放进候选名、legend 的键或其他字典键。那些键不会按键名打码，界面和导出里会原样出现。

## 导出

`exportLines` 按段文件逐行读，不把多段原文拼成一段。先去掉文件开头的 BOM，再按 `\n` 分行并去掉行尾 `\r`。每一非空行先 `JSON.parse`，再对去掉 `received_at` 和 `cursor` 之后的事件做 `validateEvent`；`received_at` 必须是字符串，`cursor` 必须是安全整数。通过后用 `sanitizeEvent(..., false)` 脱敏，并丢掉 `diagnostic`。无法解析、校验失败或信封不合格的行计入 `skipped`，不写入结果。空行不计入 `skipped`。

## Schema 文件

JSON Schema 在 `protocol/event.schema.json`。它由 `src/protocol.ts` 里的 `schema` 导出：

```bash
pnpm schema:export
```

文件内容是 `JSON.stringify(schema, null, 2)` 再加一个换行。`tests/protocol-artifacts.test.ts` 要求这份文件和代码一致。上一节里「`validateEvent` 另外拒绝」的规则只在代码里，不在这份 JSON Schema 里。换用别的校验器时，那些语义检查要另外做。

固定模拟场景在 `fixtures/scenarios/`。每个 JSONL 是一条 run。`run.started` 的 `payload.simulated` 为 `true`，`name` 以 `模拟：` 开头。时间从 `2026-01-01T00:00:00.000Z` 递增，同一个文件里的 `producer_id` 相同，`sequence` 从 1 递增。`index.json` 的 `expect` 是这些事件写入一个新的 `EventStore` 之后的结果：`run_status` 是 run 的状态记号，`decisions` 把 `decision_id` 映射到判断状态，`attempts` 的键是 `<action_id>/<attempt_id>`。`pause_after_index` 是从 0 起的事件下标，只给需要暂停的场景使用；不暂停时为 `null`。暂停本身由播放这些文件的宿主执行，不编码成文件里的时间空隙。

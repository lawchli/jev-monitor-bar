# 2026-10-02 存储整合独立审计

审计者：codex 独立 audit agent；模型系列未在执行环境中可靠提供，记为 unknown。基线为 `7aa03dd` 加本轮未提交工作区改动。本 agent 只读应用源码与测试，独立探针仅写临时目录；未提交、推送或改动应用源码。

实际平台：Linux x64，内核 6.12.94+，Node.js 22.23.2。Windows 文件锁使用 `fs` 注入的 `EBUSY` / `EPERM` / `EACCES` 模拟，不代表 Windows 实机或 Defender 扫描通过；未执行 Windows / macOS 验收。

范围：`src/store.ts`、`src/run-names.ts`，以及导出链路的 `src/ipc.ts`、`src/main/ipc-api.ts`、`src/renderer/App.tsx`。覆盖 L3、L4、I3、B3、C6，cursor reservation、锁解除恢复、保留上限与终态恢复。开始前已阅读 `AGENTS.md`、总需求、实施记录和既有审计记录。

## 初次发现与复现

下列行号对应最初稳定实现快照；后续修复可能移动行号。发现已立即反馈集成 agent 和存储实现 agent。

| 编号 | 严重度 | 位置 | 初次结论 | 阻断 |
| --- | --- | --- | --- | --- |
| S1 | 中 | `src/store.ts:375–379` | 锁解除补读之前检查去重与 sequence conflict，补读之后不重检，重试旧事件会再次落盘并返回 accepted:true | 修复前阻断本轮存储完成 |
| S2 | 中 | `src/run-names.ts:25–48`；`src/store.ts:98,249–255,356–360` | 启动时 runs.json 不可读被静默当作没有名字；之后不会重读，新任务与轮转可覆盖仍有效的旧 metadata，旧模拟任务永久丢失名字和模拟标记 | 修复前阻断 L4 完成 |
| S3 | 中 | `src/run-names.ts:12,60–65,75–79,108–114` | metadata 只保留名字、模拟和开始时间；终态事件段被清理后，残留心跳在重启后把 completed 任务恢复成 waiting | 修复前阻断实时重启终态保护完成 |
| S4 | 低 | `src/store.ts:249–256` | runs.json 连续写失败的告警在后续成功保存后仍保留 | 不单独阻断，但应随恢复修复 |
| S5 | 中 | 修复后 `src/store.ts:288–305,307–343,415–422`；`src/main/index.ts:103`；`src/renderer/useMonitor.ts:110–111` | 解除锁后补读事件/名字只改变内存，不通知 UI；本次请求如果为重复或 conflict，会直接返回，不再产生任何新事件通知 | 修复前阻断锁解除后可见恢复完成 |

S1 独立复现：先接收一条 heartbeat 并关闭 store。启动新 store 时只让 `events-00000001.jsonl` 的读取抛 `EBUSY`，reservation 仍可读；解除段锁并把 Date.now 前进 1100ms 后，重试原始事件。实际得到 `accepted:true,cursor:4194307`，导出同一 event_id 两行、cursor 分别为 1 和 4194307，内存只含一行。相同 sequence、新 event_id 同样应在补读后返回 conflict，不能确认新事件。

S2 独立复现：用 600B 段上限、2 段保留，接收模拟任务 run.started 和 15 条 heartbeat，确认 run.started 已被轮转删除。启动时让 runs.json 持续抛 `EBUSY`。解除锁后接收另一任务的 run.started 及 5 条原任务 heartbeat，触发轮转。原完整 runs.json 被替换为只含新任务，下一次重启原任务为 `name=run_id,simulated=false`。此问题不同于合法的 metadata 条数/字节淘汰。

S3 独立复现：同样用 600B、2 段接收 run.started、run.completed、15 条 heartbeat。关闭前 run 为 completed 且有 ended_at；重启仅剩 heartbeat，名字和模拟标记恢复，但 status 为 waiting、ended_at 缺失。这里检查的是实时 store 重启，不能用导出/回放仅包含有限事件窗口的边界解释。

S4 独立复现：runs.json rename 一直抛 `EBUSY`，继续接收 40 条事件，出现名称文件持续写入失败提示；解除锁并接收 5 条 heartbeat，metadata 已成功写入，事件段回到 2 个，但 storageError 仍显示同一句持续写入失败。

S5 在 S1 修复后的组合场景中发现：同 S1 的锁解除后重试，增加对 store 的 `event` 监听；内存已补回原事件，去重正确返回 accepted:false，但通知数为 0。源码确认 main 仅监听 event 来派发 IPC.changed，而 useMonitor 的 snapshot 只在首次/切换 run 或 onChanged 时读取，没有周期快照刷新。因此早先空快照不会因锁解除而更新；status 的独立轮询只清除错误，不能补 run。名称恢复后若请求刚好被去重，同样需要发可见状态变更通知。这是存储事件证据加 UI 订阅源码结论，未把未执行的 Electron UI 场景写成实机复现。

初次独立探针文件为 `/tmp/jev-audit-storage.mts` 和 `/tmp/jev-audit-storage-checks.mts`，未纳入项目运行时或测试。复现使用真实 EventStore、真实 JSONL 文件和真实 startServer；故障通过替换 fs 方法注入。

## 已实跑的安全与恢复检查

针对性回归：`node --import tsx --test tests/store-access.test.ts tests/store-writes.test.ts tests/run-names.test.ts`，初次 31/31 通过。既有绿灯未覆盖 S1–S3 的组合场景。

| 独立探针 | 实际结果 |
| --- | --- |
| cursor metadata 和最新段同时被锁 | 连续两次 HTTP 503，cursor 保持 0，没有新段；仅解除 metadata 锁后 HTTP 200，cursor 4194307；再解除段锁并等待重试，补回 cursor 1、2、3，后续 cursor 4194308 |
| reservation 临时文件写入失败 | 注入 ENOSPC；cursor 保持 0、没有段、没有 tmp 残留；解除故障后的首次确认 cursor 1 |
| reservation rename 失败 | 注入 EPERM；同样不确认、不前进 cursor，解除后 cursor 1 |
| 部分 JSONL 写入后失败 | 注入半行写入后 EIO；烧掉 cursor 2，后续确认 cursor 3；重启保留 [1,3]、corruptLines=1 |
| 不同最新段连续五次锁住并重启 | 1KiB 段下确认 cursor 为 [1,1027,2053,3079,4105,5131]；全段解锁重启后无重复 cursor |
| 完全 torn 尾行且 reservation 锁住 | 尾行改为 `{"cursor":`；ingest 抛 EBUSY；解除 reservation 锁后跳到安全 cursor 4194307。未复现“unreadableSegments 为空误清 cursorUncertain”疑点 |
| POSIX 权限 | 既有 0755 events 目录和 0644 段启动后收紧为 0700 / 0600；reservation 为 0600 |
| 名称文件字节与记录上限 | 1500 个 4096 字中文名输入，文件 1,039,104B、保留 84 条，最新一条存在；未超过 1MiB 或 1200 条 |
| runs.json 永久不能替换 | 2 段保留设置下，40 条负载中段峰值 6，故障解除后段回到 2；未无限增长 |
| 外部删除当前打开的段 | 删除已确认 cursor 1 的段后，下一次确认 cursor 2 落入新的可导出段；没有继续写入已 unlink 的 fd |

导出链路源码复核：不可读段计数与坏行计数分别为 `unreadable` 和 `skipped`；IPC 把两者传回 UI，UI 文案明确显示读不了的段数。启动/导出读取段最多进行两次 20/40ms 等待重试，之后跳过；未知高水位时保持接收 HTTP 503。完整坏行只计损坏行，不作为有效事件导出。

## 保留的限制

- 所有确认仍只有 writeSync，不增加 fsync；断电持久性不在本次保证内。
- B3 的 fstat nlink 检查保护下一次写入，不能找回外部已删除的历史行，也不能消除检查之后、写入之前的外部删除竞争窗口。
- 缺失 reservation 的 legacy 日志若尾行完全不能解析，仍只能恢复可解析 cursor 的高水位；新写段在首次确认之前必须成功写 reservation。
- 回放只能重建导出事件窗口中存在的状态，不等同于实时 store 的跨段 metadata 恢复。
- 名称/終态 metadata、事件与 run 内存都受明确上限约束；被合法淘汰的数据无法完整恢复。

## 修复后复审

S1–S4 修复后的同一独立探针已重跑：重复请求返回 accepted:false 且磁盘仍一行；新 event_id 同 sequence 返回 conflict:true 且未写入；名称文件解除读取锁后合并保存旧/新两个任务，下一次重启旧任务仍标模拟；终态段被清后重启仍为 completed 并保留原 ended_at；写锁解除后成功保存清掉旧告警。九项故障与有界检查也全部重跑通过。

S5 已反馈集成与实现 agent，待恢复通知实现后的独立复审。当前仍不把锁解除后的 UI 自动恢复标为完成。

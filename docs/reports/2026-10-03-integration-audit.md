# 2026-10-03 集成收尾独立审计

- 审计者：codex / gpt-sol，独立审计 agent；本轮由用户明确指定 GPT-6.1 Sol、reasoning xhigh。
- 工作区：`/tmp/jev-monitor-bar-completion-20261003`，基线 HEAD `7aa03ddde526423a5451fe34aa3879affd384915` 加本轮未提交集成 diff。没有修改应用源码、既有测试、原 workspace 或旧实施记录，也没有 commit/push、构建或打包。
- 实际环境：Linux 6.12.94+ x86_64、Node.js v22.23.2、Python 3.13.5。当前沙箱禁止 socket，并且不能申请沙箱外执行；下文明确区分实际通过与环境拦截。
- 范围：读取 AGENTS、总需求、实施/审计记录和本轮独立报告；复核 `app://` 协议 / CSP / IPC / fuses、ASAR 验证真实性、state bound / replay、存储 metadata / cursor / 去重恢复组合以及 Python finite / fork / 路径。重点独立验证旧报告 S5 的最终集成链路。

## 结论

本次最终快照没有发现新增代码阻断项。旧 S5 的恢复后可见状态缺失已通过独立组合探针和新增仓库回归：解除段锁或 metadata 锁后，即使当前请求被去重或判为 sequence conflict，仍发送 UI 变更通知；部分数据恢复后仍需返回存储繁忙时也通知已恢复状态。实际 main 合批读取 store 当前 cursor，恢复旧事件不会使通知 cursor 回退。

这不是“项目所有平台验收完成”的结论。本次未运行 Electron GUI、最终发布包、完整 HTTP 回归或 Windows/macOS 原生验收；最终完整 CI、打包与平台实机结果必须由集成方另行记录。上一轮 Linux 的 231/231 全测试及 34/34 smoke 发生在 S1–S5 最终修复之前，不用于证明当前最终快照完整验收通过。

## S5 最终链路独立验证

临时探针 `/tmp/jev-integration-final-probe.mts` 读取并转译**真实 `src/main/index.ts`**，在隔离 VM 中注入受控 Electron app、窗口和接收器替身，但使用真实 EventStore、真实磁盘 JSONL / metadata、真实 `subscribeStoreChanges()` 和真实计时器。文件锁通过替换 fs reader 注入 `EBUSY`，没有创建 HTTP socket，也没有修改应用源码。所有下列 8 项通过：

| 场景 | 实测结果 |
| --- | --- |
| 启动跳过锁住的段，解锁后重试原 event_id | `accepted:false`；只补回一次原事件、导出只有一行，没有伪造新 `event`；实际 main 发出一次 `IPC.changed` |
| 同上，重试采用新 event_id、旧 producer sequence | `accepted:false, conflict:true`；没有重复落盘，仍通知恢复的 run |
| run.started / completed 已被段轮转清理，启动时仅 runs.json 被锁；解锁后 duplicate | 名称、模拟标记、开始/结束时间和 completed 终态恢复，错误清除；没有新增事件，仍发一次变更 |
| 同上，解锁请求为 sequence conflict | 同样恢复 metadata 和终态并通知，不接受冲突事件 |
| 恢复与新接受事件出现在同一 50ms 批次，并额外传入旧 cursor 恢复消息 | runIds 合并去重，只发一个批次；cursor 等于当前 store cursor，不采信旧恢复消息 cursor |
| 实际 main 的 will-quit 清理 | 两个 store listener 移除；清理后恢复消息不再触发 UI 通知 |
| 两段和 reservation 都不可读，先只解锁一段 | 已恢复的 cursor 1 / run 可见，即使 ingest 随后仍抛 `EBUSY`（接收器映射为 503）；第二段解锁后恢复并接受新事件，下一批 cursor 3，无 cursor 复用 |
| 原 run 已可读，但最新段和 reservation 被锁；仅解锁 reservation 后重试旧事件 | 保持 `accepted:false`；高水位跳至安全 ceiling；实际 main 发出 `runIds:[]` 的 cursor-only 变更，不丢失这类通知 |

该探针验证 main 到窗口替身的 IPC 派发，不冒充 Chromium DOM 更新或真实 Electron 窗口实测。旧 S5 的 renderer 订阅前提另外由源码复核：`useMonitor` 的 onChanged 触发 snapshot 刷新，status 轮询不替代 snapshot；如今两类 store 变化均接入同一订阅路径。

## 其他重点复核

- `app://renderer` handler 只允许 5 个构建资源，拒绝其他 host、端口、userinfo、非允许路径和非 GET/HEAD 方法；真实越界 symlink 测试通过。reader 检查 realpath，不把任意 URL 转成磁盘路径；CSP 禁止外网、frame、worker、object，IPC 继续校验 webContents、mainFrame 身份及完整 renderer URL。fuse 的 file 协议额外权限已关闭。检查与读取之间的本机文件替换窗口仍属于需要应用文件修改权限的既有边界。
- AD-01 修复不再把普通崩溃当 ASAR 完整性证据：只改 source comment 的合法字母，前后 JS 能解析；判定还要求明确 integrity 日志且接收器未启动。Linux 分支显式 skip，不计 passed。本次 helper 两项回归通过，但没有运行 Windows/macOS 的实际篡改发布包，因此不宣称真实 integrity 拒绝已验证。
- S1–S4 最终存储修复与实际回归一致：先补读再去重/判冲突；names 读取失败不覆盖旧完整 metadata；解锁后合并恢复；终态随有界 metadata 保留；后续成功写入清除旧错误。新 metadata 兼容旧 v1 name-only 文件，不凭名字捏造终态。
- cursor reservation 在段首次写入前保存，失败不确认；锁住高水位且无有效 reservation 时繁忙而非猜测；完全 torn 的新段使用已保存 ceiling；重启、部分写失败和连续锁住的尾段回归通过。旧日志没有 reservation 且尾行完全不可解析时，仍只有可解析 cursor 高水位保证。
- bound 优化保留 Object.keys 的数值键排序 / 普通字符串插入顺序；WeakMap 元数据不出 IPC，复制表和 replay 检查点的相关回归通过。没有改事件窗口或 run/decision/attempt 上限。
- Python finite 校验位于 worker / 注册集合初始化前；绝对 session override 独立于无法解析的相对 home。独立无网络探针实际拒绝 12 个 NaN/±Inf 参数组合；三个嵌套非有限 payload 不占 sequence、不入队、不制造待报告遥测，随后有效事件为 sequence 1。
- 同一 Python 探针执行真实 Linux fork：fork 前持有 sender lock、queue mutex、wake / stop condition，子 hook 重建同步对象和队列，父队列不被子进程重发，子 producer 改变且序号重新从 1 开始；另创建并释放 100 个 sender，弱引用均可回收。探针覆盖生产 enqueue / fork 逻辑，后台 worker 使用无网络替身，不冒充真实 fork HTTP 投递。

## 实际命令与结果

`pnpm --config.verify-deps-before-run=false typecheck`：本轮最后快照通过。`git diff --check`：通过。

TypeScript 定向测试使用 `node --import tsx <测试文件>` **逐文件直接执行**；最终以下 91 个真实用例全部通过，零跳过：

| 文件 | 通过用例 |
| --- | ---: |
| tests/renderer-protocol.test.ts | 6 |
| tests/runtime-integrity.test.ts | 2 |
| tests/state-bound.test.ts | 4 |
| tests/package-config.test.ts | 12 |
| tests/run-names.test.ts | 15 |
| tests/store-access.test.ts | 16 |
| tests/store-changes.test.ts | 5 |
| tests/replay.test.ts | 15 |
| tests/replay-timeline.test.ts | 11 |
| tests/store-recovery.test.ts | 5 |

另外直接运行 `tests/store-writes.test.ts`：10 项通过，1 项 HTTP listener 测试因 `listen EPERM 127.0.0.1` 未能执行。该结果不计产品失败，也不计全文件通过。

Python 无 socket 的仓库回归命令：

```bash
PYTHONPATH=python:python/tests python3 -m unittest -v \
  test_paths \
  test_sender.SenderTest.test_nonfinite_time_parameters_raise_before_starting_worker
```

结果 4/4 通过。独立 Python 组合探针 `python3 /tmp/jev-integration-python-final-probe.py` 通过，输出确认 12 个配置拒绝、3 个 payload 拒绝、真实 fork、父队列保持及 100 个 GC 对照。

工具/环境限制明确记录：

- `tsx --test` CLI 在创建 `/tmp/tsx-1000/*.pipe` 时被沙箱 `EPERM` 拦截，改用 Node 直接加载 tsx 并执行测试文件，没有重建共享 node_modules。
- 本环境 `node --import tsx --test ...` 汇总只显示文件级计数；本报告没有把文件数当成真实用例数，最终数量来自上述直接执行的 TAP 汇总。
- 曾尝试 Python 非有限 payload 的仓库 HTTP 测试，创建 socket 时被 `PermissionError` 拦截；改以不使用网络的独立探针验证同一 enqueue 行为，没有把被拦截的测试写成通过。
- 本次在 S5 实现中途曾运行名称测试，新增的两项预期为红灯；实现稳定后按最终文件完整重跑 15/15 通过。历史中途结果不冒充最终缺陷或最终通过。

## 复核快照与剩余边界

关键最终源码 SHA-256：

```text
62dbe4479cd8c4a2276e73685a37e5180323867b5799cc36bb80cc8a0ca30657  src/store.ts
d60bc51fd997ac742a55256ed6e659ed828322cc1dbbefaee93a7e0dbbc80809  src/run-names.ts
05b412934cc1032131cd42a6a79b5592757936c47197b64da482d29dff283db2  src/main/index.ts
7aa92362f80b71339fdfe963ce7cf2c22fff87f5dec2eeced6d79c6cbd025c80  src/main/store-changes.ts
97b73f451299ac049bf83241ca5f091f85850c7fd04ef88866e8ddfbcb9391ef  src/main/renderer-protocol.ts
7e2849331aaf099e44ebbed7b774f9820aece2e79d8ea64314f037f9c94cd57e  src/state.ts
2bf0942a3edcf00e868a0e3b9ebcf739b452212e4a66c08e254c280213197eb0  scripts/runtime-integrity.mjs
0f96a1d9b0cdbf68ac908cb52e8355bb8a95a023fb4feb116b15af3e9a39e47e  scripts/verify-runtime.mjs
56aeb7796654ae86d05833136735664eab0734406e1f5c353d270d6744b480fd  python/jev_monitor/sender.py
fbea83b003cb47f68579ef72df1776f30ffe220c0566961da0ce086979184763  python/jev_monitor/paths.py
```

没有读取真实凭证、`.env` 或宿主业务数据。以下仍需明确保留：同步 write 不等于 fsync / 断电持久性；合法保留淘汰无法完整还原；nlink 检查不能找回外部删除的历史，也不能消除检查后删除的窄竞争窗口；段删除永久受操作系统锁阻止时，应用不能承诺物理段数立即回到上限；事件/metadata 的读取重试会短暂同步阻塞主线程。

最终发布包运行、最终全量 HTTP 测试、当前分支三平台 CI，以及 Windows 不抢焦点 / 混合 DPI / 多屏 / Defender 扫描 / 干净机器解压即用 / 代码签名，均不是本次独立审计的通过项。没有新增需要源码修复的审计阻断；尚待执行的发布与平台验收应继续由集成流程完成，不能被本报告的局部绿灯替代。

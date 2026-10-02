# 2026-10-03 离线存储容量压测

- 实现及验证：codex / gpt-sol；Linux 6.12.94+ x64、Node v22.23.2，Intel Xeon、8 个逻辑核、约 15.6 GiB RAM 的共享协作环境。
- 入口：`node --import tsx scripts/loadtest/store-stress.mts`；可选 `--events`、`--seed`、`--out`。默认 24,000 条，参数限制为有界安全整数；模块可导入，不自动启动压测。
- 方法：真实协议 v1 LoadGenerator → 真实 EventStore → JSONL/metadata → export → parseReplay → reopen → 新事件继续确认。没有 HTTP/socket、子进程、Electron 或渲染器；测量的是同步本地短突发，不是 30 分钟 soak、HTTP 吞吐或 UI 可见延迟。
- 安全：每次在输出父目录下创建独立 `mkdtemp` 子目录，不清空既有目录，不读取会话凭证或真实业务数据。默认输出 `.runtime/store-stress/run-*`，`report.json` 与 `summary.md` 是验证制品，不提交这些生成目录。

## 实际负载与断言

默认 seed 1，先发送 20,050 条轻载，真实触发 20,000 条事件保留上限；再发送 3,950 条高比例近 64 KiB 负载，触发 32 MiB 字节淘汰和 4 MiB / 8 段轮转。两个阶段采用不同 producer/run tag；60% 事件分给贯穿阶段的长 run，普通 run 交错执行，包含所有事件类型、Choice/Score/Noul、规则覆盖、重试和验证三种结果。

最新最终实现实跑输出：`.runtime/store-stress/run-PfOY0U/report.json`、同目录 `summary.md`。全部自动断言通过：

| 检查 | 实际结果 |
| --- | --- |
| 接受量及任务数 | 24,000 条正常确认；866 个实际出现的 run |
| 事件数 / JSON 字节峰值 | 20,000 / 33,554,299；不超过 20,000 / 33,554,432 |
| run / evicted 峰值 | 200 / 666；不超过 200 / 1,000 |
| 单 run 决策 / 尝试表峰值 | 500 / 500；两类生成的关联数都真正超过 500 后触发淘汰 |
| 字节 / 事件数淘汰 | 分别 825 / 1,884 次接收触发相应容量压力 |
| 轮转 | 最大段号 16，最终保留 8 段；最大段 4,190,646 B，小于 4 MiB |
| 重启前磁盘 | 段共 30,710,564 B；metadata 862 条、135,841 B，小于 1,200 条 / 1 MiB |
| 导出 / 回放 | 2,193 条保留事件，cursor 唯一；skipped/unreadable/invalidLines 均 0 |
| duplicate / sequence conflict | 在重启前后均正确拒绝；监测 fs 写入/rename/unlink/chmod 等调用，确认不修改磁盘；监测器在 finally 恢复 |
| 重启及继续写入 | 高水位保持 24,000；新 producer 事件确认 cursor 24,001；继续写入后段数仍为 8 |

32 MiB 只约束事件窗口的 JSON 大小，不是整个进程 RSS 或聚合状态的总内存承诺。最终实跑的 ingest 阶段采样 RSS / heap 峰值约 197.5 / 107.1 MiB；包含导出、回放解析、重启及本测试自身参考对象的全流程采样峰值约 381.7 / 261.7 MiB。每 250 条采样，并在 export / parseReplay / cursor 检查 / reopen / continuation 后追加采样；这些是采样峰值，不声称捕获每一瞬间的绝对峰值。

## 实测计时及异常调度口径

最终稳定源码的本次默认运行：墙钟 **58,759.2 ms**；进程 CPU user/system/total 为 **38,503.5 / 6,553.0 / 45,056.4 ms**。单次真实 ingest p50/p95/p99/max 为 **0.045 / 2.282 / 7.662 / 168.864 ms**；export / parseReplay / reopen 为 **10,437.5 / 30,909.1 / 1,523.1 ms**。

这是共享、非隔离环境的真实结果，不包装成稳定性能基线，也不用于证明 UI p95≤500ms。导出和解析的同步耗时分别计时，不混入 ingest 分布；进程 wall time 包含调度/暂停，CPU time 单独记录。

保留两次较早的实际结果，不改写历史：

- `run-60KWuO`：24,000 条容量断言通过，9,620.8 ms；当时尚未补齐全流程 RSS 采样、CPU 时间及完整 fs 无写调用监测，不能代替最终版本指标。
- `run-MOxqeA`：补齐内存/无写监测后的 24,000 条断言通过，但 wall 为 1,395,035.3 ms（约 23 分钟），明显存在执行调度/暂停；未记录 CPU 时间，不能精确归因，也不能当连续 23 分钟负载或 30 分钟 soak。随后新增 CPU 记录并重跑得到上面的最终结果。

## 验证与交付状态

`node --import tsx tests/store-stress.test.ts`：3/3 真实用例通过，仅运行 180 条与 1 条短路径，不把默认 24,000 条放进单元测试。覆盖参数边界、真实持久化/导出/重启/继续确认、新输出目录不覆盖已有文件、非法 API 输入不创建目录。

最终 `pnpm --config.verify-deps-before-run=false typecheck`、两个新增文件的 Prettier 检查及 `git diff --check` 通过。没有更改 EventStore、协议、聚合业务语义或 tsconfig，没有新增依赖；package.json、CI 与 README 接入由集成方完成。

实现 SHA-256：

```text
08bd429f5745d73206700d333c6ac1ab1a1bd83080a29feb0d36225fd3566d62  scripts/loadtest/store-stress.mts
a6911b6d522b5df75a1ce892d913b70b668cb18530175b83ca57ade92c2c2efe  tests/store-stress.test.ts
```

本次未验证当前分支完整 CI、最终发布包、Windows/macOS 原生行为、Defender、签名、干净机器或 30 分钟持续负载；历史长时验收仍按原记录看待。writeSync 确认不等于 fsync / 断电持久性。本压测没有发现新的存储正确性缺陷。

# 合成负载报告 2026-09-29T20:54:13.625Z

- 机器：macOS 27.0 (26A428)，Apple M2，8 核，8 GB，arm64
- 驱动进程 Node v22.23.2；接收端 node（Node 22.23.2）；提交 826c5a8
- 参数：时长 30.0 分钟；目标 45000 条（25.00/s，每 5.0 分钟突发 400 条）；并发 4；约 750 个普通 run + 1 个长 run；heavy 0.02；拒绝请求 0.03；渲染模拟跟随 lt-1-marathon-1

## 结果

- 实际负载 30.00 分钟，接受 45000 条有效事件（其中近上限 906 条），发送 67.6 MB；有效事件失败 0，重试 0，异常响应 0
- 请求状态：valid {"200":45000}；malformed {"400":217}；invalid {"400":149}；unauthorized {"401":211}；conflict {"409":168}；oversize {"413":186}；duplicate {"200":190}；oversize-chunked {"413":207}
- 生成器：795 个 run；类型 {"run.started":795,"progress.updated":5970,"decision.started":7713,"decision.resolved":7474,"action.selected":5598,"action.started":5598,"action.completed":4607,"verification.completed":3915,"action.failed":571,"decision.failed":238,"run.completed":634,"heartbeat":1526,"action.cancelled":160,"run.failed":63,"telemetry.dropped":108,"run.cancelled":30}
- HTTP 往返（有效事件）：p50 0.89 / p95 5.64 / p99 11.69 / max 1262.09 ms；最差窗口 p99 1190.96 ms；超过 500 ms（Python 发送端默认超时）10 次，超过 2 s 0 次；被拒请求 p50 0.87 / p95 7.53 / p99 12.00 / max 898.88 ms；排程滞后 p50 1.41 / p95 3.74 / p99 80.69 / max 1096.27 ms
- 接收端 ingest（校验+脱敏+落盘+聚合）：p50 0.38 / p95 0.93 / p99 1.85 / max 1019.03 ms
- appendFileSync：p50 0.13 / p95 0.35 / p99 0.52 / max 1007.94 ms，占 ingest 时间 44.0%；readdirSync 45004 次，p50 0.06 / p95 0.13 / p99 0.16 / max 28.08 ms
- 快照（每次更新，v8.serialize 近似 IPC）：构建 p50 1.25 / p95 4.21 / p99 4.67 / max 29.14 ms；序列化 p50 7.16 / p95 10.46 / p99 12.04 / max 53.72 ms；大小 p50 4376 / p95 5457 / max 5799 KiB；共 17798 次
- 主进程侧更新延迟（入库到快照序列化完成，含 50 ms 合并与 100 ms 节流）：p50 87.81 / p95 102.15 / p99 105.12 / max 980.75 ms
- 分页（加载更早）：p50 1.58 / p95 4.40 / p99 10.21 / max 18.97 ms
- 事件循环阻塞（monitorEventLoopDelay 减去 10 ms 采样间隔）：各窗口 p50 中位 2.02 ms，最差窗口 p99 15.33 ms，最大 1028.09 ms；ELU 平均 12.7%；CPU 平均 18.6%

## 内存

- 基线（GC 后）：RSS 59.4 MB，heapUsed 6.5 MB
- 结束（GC 后）：RSS 135.2 MB，heapUsed 57.8 MB，external 19.3 MB
- 峰值：RSS 443.7 MB，heapUsed 48.6 MB（未强制 GC 的采样）
- GC 后 heapUsed 三段均值：21.2 → 40.8 → 46.4 MB；后半程斜率 0.609 MB/分钟
- RSS 三段均值：125.2 → 248.9 → 186.9 MB；后半程斜率 -8.98 MB/分钟
- 内存窗口（20000 条或 32 MiB）饱和于 13.5 分钟
- 结束时 store：20000 条，26.35 MB，ids 20000，sequences 20000，droppedRuns 445
- 结束时聚合：200 个 run（未结束 68，触顶 1），决策 1781（单 run 最多 500），尝试 1429（单 run 最多 500）；引用事件 8990 条，其中已移出内存窗口 1162 条 / 1.92 MB；聚合状态 JSON 19.68 MB
- 结束时所选 run 快照：JSON 6387 KiB，v8 4447 KiB

## 存储

- 结束 30.45 MB，峰值 31.79 MB，保留 8 段；共创建 15 段，删除 7 段；后半程斜率 -0.016 MB/分钟

## 导出、回放、重启

- 导出（UI 的导出路径，同步）：807.2 ms，30.45 MB，跳过 0；前后 RSS 123.2 → 389.4 MB
- 负载进行中导出（第 22.5 分钟）：572.2 ms，28.46 MB；导出期间及之后 0.5 s 内完成的有效请求 26 个，HTTP p50 0.66 / p95 550.74 / p99 587.58 / max 587.58 ms
- 回放打开：读取+解析 325.5 ms，20000 条（截断 true，无效行 0）；IPC 一次返回 27.06 MB，序列化 16.4 ms
- 回放拖动（渲染端，每步从头重算）：replaySnapshot 全量 109.6 ms，一半 45.7 ms；pageReplay 1.25 ms
- 重启恢复（新进程读保留段）：611.4 ms，20000 条，26.35 MB，损坏行 0；GC 后 RSS 161.9 MB，heap 41.2 MB

## 最坏情况探针

- 未运行

## 限制

- 接收端在独立 Node/Electron-as-node 进程中运行，不含 Chromium 渲染进程与窗口；可见更新延迟（渲染与绘制）不在本报告内。
- 快照 IPC 成本用 v8.serialize 近似 Electron 结构化克隆；每 60 秒强制 GC 一次测保留内存，强制 GC 与测量自身的停顿已从事件循环延迟中排除。
- 生产者与接收端在同一台机器上，机器上的其他负载会进入延迟数字（见各采样的 loadavg1）。

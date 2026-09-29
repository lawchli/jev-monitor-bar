# 合成负载报告 2026-09-29T20:54:11.901Z

- 机器：macOS 27.0 (26A428)，Apple M2，8 核，8 GB，arm64
- 驱动进程 Node v22.23.2；接收端 electron（Node 24.19.0，Electron 42.11.6）；提交 826c5a8
- 参数：时长 30.0 分钟；目标 45000 条（25.00/s，每 5.0 分钟突发 400 条）；并发 4；约 750 个普通 run + 1 个长 run；heavy 0.02；拒绝请求 0.03；渲染模拟跟随 lt-1-marathon-1

## 结果

- 实际负载 30.00 分钟，接受 45000 条有效事件（其中近上限 906 条），发送 67.6 MB；有效事件失败 0，重试 0，异常响应 0
- 请求状态：valid {"200":45000}；malformed {"400":217}；invalid {"400":149}；unauthorized {"401":211}；conflict {"409":168}；oversize {"413":186}；duplicate {"200":190}；oversize-chunked {"413":208}
- 生成器：795 个 run；类型 {"run.started":795,"progress.updated":5970,"decision.started":7713,"decision.resolved":7474,"action.selected":5598,"action.started":5598,"action.completed":4607,"verification.completed":3915,"action.failed":571,"decision.failed":238,"run.completed":634,"heartbeat":1526,"action.cancelled":160,"run.failed":63,"telemetry.dropped":108,"run.cancelled":30}
- HTTP 往返（有效事件）：p50 0.75 / p95 5.74 / p99 11.91 / max 1031.71 ms；最差窗口 p99 1028.85 ms；超过 500 ms（Python 发送端默认超时）9 次，超过 2 s 0 次；被拒请求 p50 0.75 / p95 5.71 / p99 11.55 / max 54.56 ms；排程滞后 p50 1.37 / p95 3.69 / p99 66.93 / max 958.10 ms
- 接收端 ingest（校验+脱敏+落盘+聚合）：p50 0.29 / p95 0.74 / p99 1.35 / max 1027.64 ms
- appendFileSync：p50 0.11 / p95 0.33 / p99 0.54 / max 1025.11 ms，占 ingest 时间 50.9%；readdirSync 45004 次，p50 0.06 / p95 0.11 / p99 0.16 / max 5.84 ms
- 快照（每次更新，v8.serialize 近似 IPC）：构建 p50 1.33 / p95 3.71 / p99 4.58 / max 22.79 ms；序列化 p50 8.03 / p95 11.01 / p99 13.30 / max 48.88 ms；大小 p50 4376 / p95 5455 / max 5798 KiB；共 17799 次
- 主进程侧更新延迟（入库到快照序列化完成，含 50 ms 合并与 100 ms 节流）：p50 88.58 / p95 102.32 / p99 104.76 / max 1044.67 ms
- 分页（加载更早）：p50 1.44 / p95 2.71 / p99 5.35 / max 10.67 ms
- 事件循环阻塞（monitorEventLoopDelay 减去 10 ms 采样间隔）：各窗口 p50 中位 2.01 ms，最差窗口 p99 15.92 ms，最大 1025.99 ms；ELU 平均 11.9%；CPU 平均 13.2%

## 内存

- 基线（GC 后）：RSS 71.2 MB，heapUsed 4.6 MB
- 结束（GC 后）：RSS 142.8 MB，heapUsed 49.6 MB，external 46.2 MB
- 峰值：RSS 247.1 MB，heapUsed 40.8 MB（未强制 GC 的采样）
- GC 后 heapUsed 三段均值：16.8 → 33.5 → 38.3 MB；后半程斜率 0.529 MB/分钟
- RSS 三段均值：98.2 → 152.5 → 157.9 MB；后半程斜率 -0.439 MB/分钟
- 内存窗口（20000 条或 32 MiB）饱和于 13.5 分钟
- 结束时 store：20000 条，26.35 MB，ids 20000，sequences 20000，droppedRuns 445
- 结束时聚合：200 个 run（未结束 68，触顶 1），决策 1781（单 run 最多 500），尝试 1429（单 run 最多 500）；引用事件 8990 条，其中已移出内存窗口 1162 条 / 1.92 MB；聚合状态 JSON 19.68 MB
- 结束时所选 run 快照：JSON 6387 KiB，v8 4447 KiB

## 存储

- 结束 30.45 MB，峰值 31.79 MB，保留 8 段；共创建 15 段，删除 7 段；后半程斜率 -0.016 MB/分钟

## 导出、回放、重启

- 导出（UI 的导出路径，同步）：636.8 ms，30.45 MB，跳过 0；前后 RSS 131.2 → 359.3 MB
- 负载进行中导出（第 22.5 分钟）：515.2 ms，28.46 MB；导出期间及之后 0.5 s 内完成的有效请求 24 个，HTTP p50 0.56 / p95 462.78 / p99 504.52 / max 504.52 ms
- 回放打开：读取+解析 422.2 ms，20000 条（截断 true，无效行 0）；IPC 一次返回 27.06 MB，序列化 62.0 ms
- 回放拖动（渲染端，每步从头重算）：replaySnapshot 全量 158.8 ms，一半 48.9 ms；pageReplay 0.77 ms
- 重启恢复（新进程读保留段）：589.0 ms，20000 条，26.35 MB，损坏行 0；GC 后 RSS 176.3 MB，heap 34.0 MB

## 最坏情况探针

- 4 个 run × 520 个决策，每个 decision.started 约 60 KB；共 4160 条，120.6 MB，41.6 s（100/s），拒绝 0
- 探针期间：快照构建 p50 0.15 / p95 0.28 / p99 0.47 / max 1.70 ms；序列化 p50 9.29 / p95 19.37 / p99 21.59 / max 24.51 ms；大小 p50 16638 / p95 31505 / max 31818 KiB；ingest p50 0.52 / p95 1.74 / p99 2.17 / max 7.74 ms；主进程侧更新延迟 p50 99.34 / p95 105.94 / p99 108.74 / max 111.23 ms
- store 窗口 1103 条 / 32.00 MB；聚合保留决策 2000，窗口外引用 2897 条 / 84.14 MB；聚合状态 JSON 231.27 MB
- GC 后内存：基线 heap 4.6 / RSS 72.3 MB → heap 187.3 / RSS 303.4 MB
- 所选 run 快照：v8 31.02 MB，JSON 65.78 MB；HTTP p50 1.10 / p95 8.54 / p99 16.17 / max 25.76 ms

## 限制

- 接收端在独立 Node/Electron-as-node 进程中运行，不含 Chromium 渲染进程与窗口；可见更新延迟（渲染与绘制）不在本报告内。
- 快照 IPC 成本用 v8.serialize 近似 Electron 结构化克隆；每 60 秒强制 GC 一次测保留内存，强制 GC 与测量自身的停顿已从事件循环延迟中排除。
- 生产者与接收端在同一台机器上，机器上的其他负载会进入延迟数字（见各采样的 loadavg1）。

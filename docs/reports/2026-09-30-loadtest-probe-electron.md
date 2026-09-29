# 合成负载报告 2026-09-29T21:27:47.791Z

- 机器：macOS 27.0 (26A428)，Apple M2，8 核，8 GB，arm64
- 驱动进程 Node v22.23.2；接收端 electron（Node 24.19.0，Electron 42.11.6）；提交 826c5a8
- 参数：时长 0.3 分钟；目标 400 条（20.00/s，每 5.0 分钟突发 400 条）；并发 4；约 250 个普通 run + 1 个长 run；heavy 0.02；拒绝请求 0.03；渲染模拟跟随 lt-1-marathon-1

## 结果

- 实际负载 0.33 分钟，接受 400 条有效事件（其中近上限 4 条），发送 0.4 MB；有效事件失败 0，重试 0，异常响应 0
- 请求状态：valid {"200":400}；malformed {"400":2}；invalid {"400":2}；unauthorized {"401":3}；conflict {"409":2}；oversize {"413":5}
- 生成器：28 个 run；类型 {"run.started":28,"progress.updated":68,"decision.started":62,"decision.resolved":59,"action.selected":43,"action.started":43,"action.completed":33,"verification.completed":27,"run.completed":20,"decision.failed":3,"action.failed":5,"heartbeat":7,"action.cancelled":1,"run.failed":1}
- HTTP 往返（有效事件）：p50 2.15 / p95 2.93 / p99 5.71 / max 17.53 ms；最差窗口 p99 7.06 ms；超过 500 ms（Python 发送端默认超时）0 次，超过 2 s 0 次；被拒请求 p50 1.61 / p95 11.22 / p99 11.22 / max 11.22 ms；排程滞后 p50 1.30 / p95 2.57 / p99 2.86 / max 11.96 ms
- 接收端 ingest（校验+脱敏+落盘+聚合）：p50 0.78 / p95 1.01 / p99 3.58 / max 6.76 ms
- appendFileSync：p50 0.39 / p95 0.49 / p99 0.58 / max 4.32 ms，占 ingest 时间 47.0%；readdirSync 403 次，p50 0.15 / p95 0.18 / p99 0.20 / max 0.22 ms
- 快照（每次更新，v8.serialize 近似 IPC）：构建 p50 0.09 / p95 0.14 / p99 0.18 / max 0.28 ms；序列化 p50 0.36 / p95 0.76 / p99 0.80 / max 1.94 ms；大小 p50 39 / p95 98 / max 117 KiB；共 199 次
- 主进程侧更新延迟（入库到快照序列化完成，含 50 ms 合并与 100 ms 节流）：p50 75.45 / p95 97.77 / p99 100.66 / max 101.17 ms
- 分页（加载更早）：p50 0.12 / p95 0.51 / p99 0.51 / max 0.51 ms
- 事件循环阻塞（monitorEventLoopDelay 减去 10 ms 采样间隔）：各窗口 p50 中位 1.57 ms，最差窗口 p99 2.80 ms，最大 5.57 ms；ELU 平均 4.0%；CPU 平均 4.2%

## 内存

- 基线（GC 后）：RSS 72.5 MB，heapUsed 4.6 MB
- 负载最后一次 GC 采样：RSS 80.6 MB，heapUsed 5.6 MB，external 2.8 MB
- 结束（GC 后）：RSS 75.0 MB，heapUsed 5.9 MB，external 3.0 MB
- 峰值：RSS 80.6 MB，heapUsed 6.2 MB（未强制 GC 的采样）
- GC 后 heapUsed 三段均值：0.0 → 5.6 → 5.9 MB；后半程斜率 1.748 MB/分钟
- RSS 三段均值：0.0 → 80.6 → 76.0 MB；后半程斜率 -26.505 MB/分钟
- 内存窗口（20000 条或 32 MiB）饱和于 未饱和
- 结束时 store：400 条，0.32 MB，ids 400，sequences 400，droppedRuns 0
- 结束时聚合：28 个 run（未结束 7，触顶 0），决策 62（单 run 最多 24），尝试 43（单 run 最多 15）；引用事件 302 条，其中已移出内存窗口 0 条 / 0.00 MB；聚合状态 JSON 0.39 MB
- 结束时所选 run 快照：JSON 119 KiB，v8 73 KiB

## 存储

- 结束 0.32 MB，峰值 0.32 MB，保留 1 段；共创建 1 段，删除 0 段；后半程斜率 1.088 MB/分钟

## 导出、回放、重启

- 导出（UI 的导出路径，同步）：5.9 ms，0.32 MB，跳过 0；前后 RSS 76.4 → 79.1 MB
- 负载进行中导出：未测
- 回放打开：读取+解析 4.7 ms，400 条（截断 false，无效行 0）；IPC 一次返回 0.32 MB，序列化 0.3 ms
- 回放拖动（渲染端，每步从头重算）：replaySnapshot 全量 0.6 ms，一半 0.2 ms；pageReplay 0.08 ms
- 重启恢复：未测

## 最坏情况探针

- 4 个 run × 520 个决策，每个 decision.started 约 60 KB；共 4160 条，120.6 MB，41.6 s（100/s），拒绝 0
- 探针期间：快照构建 p50 0.17 / p95 0.26 / p99 0.32 / max 0.52 ms；序列化 p50 10.12 / p95 15.32 / p99 16.08 / max 20.25 ms；大小 p50 16579 / p95 31505 / max 31818 KiB；ingest p50 0.47 / p95 2.04 / p99 4.32 / max 10.25 ms；主进程侧更新延迟 p50 99.58 / p95 103.04 / p99 105.20 / max 109.11 ms
- store 窗口 1103 条 / 32.00 MB；聚合保留决策 2000，窗口外引用 2897 条 / 84.14 MB；聚合状态 JSON 231.27 MB
- GC 后内存：基线 heap 4.6 / RSS 72.2 MB → heap 121.5 / RSS 280.1 MB
- 所选 run 快照：v8 31.02 MB，JSON 65.78 MB；HTTP p50 1.36 / p95 7.80 / p99 13.25 / max 35.81 ms

## 限制

- 接收端在独立 Node/Electron-as-node 进程中运行，不含 Chromium 渲染进程与窗口；可见更新延迟（渲染与绘制）不在本报告内。
- 快照 IPC 成本用 v8.serialize 近似 Electron 结构化克隆；每 60 秒强制 GC 一次测保留内存，强制 GC 与测量自身的停顿已从事件循环延迟中排除。
- 生产者与接收端在同一台机器上，机器上的其他负载会进入延迟数字（见各采样的 loadavg1）。

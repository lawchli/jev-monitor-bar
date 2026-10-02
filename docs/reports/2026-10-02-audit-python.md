# 2026-10-02 Python 发送器独立审计

- 审计者：codex / gpt-sol，独立只读审计 agent。
- 工作区：`/home/box/jev-monitor-bar-completion`，基线 HEAD `7aa03ddde526423a5451fe34aa3879affd384915`，审计对象包括尚未提交的 Python diff。
- 环境：Linux 6.12.94+ x86_64，Python 3.13.5。
- 范围：L5 当前目录被删除、L6 fork 后发送器行为、I4 非有限 payload；补查继承锁、弱引用及 at_fork 生命周期、关闭/禁用状态、丢弃计数与序号、loopback/重定向。
- 本 agent 未修改应用源码或测试，未 commit/push；仅新增本报告及 `/tmp` 下独立诊断探针。

结论：L6 与 I4 的主要改动通过独立复现，L5 的已覆盖用例通过；没有发现 fork 死锁、父子队列重发、at_fork 强引用泄漏或重定向泄露 token。发现 1 个阻断项和 1 个低级边界项，已交集成 agent 纳入本轮修复。以下是修复前的审计快照，不能据此宣称后续修复已通过复核。

## 发现与修复前复现

| 编号 | 严重度 | 文件位置（修复前） | 结果 | 状态 |
| --- | --- | --- | --- | --- |
| PY-A1 | 中 / P2，阻断本轮收尾 | `python/jev_monitor/sender.py:194`、`:705` | `_require_positive` 接受 NaN/Inf；`heartbeat_interval=NaN` 令 worker 在空队列上持续占用 CPU，关闭后仍未退出 | 已交修复，待独立复核 |
| PY-A2 | 低 / P3，不独立阻断 | `python/jev_monitor/paths.py:34`、`:36`；`python/jev_monitor/sender.py:175` | deleted cwd + 相对 `JEV_MONITOR_HOME` + 绝对 `JEV_MONITOR_SESSION` 时，发送器仍离线；有效的绝对会话覆盖被无关的数据 home 解析失败拖累 | 已交修复，待独立复核 |

PY-A1 属于既有参数校验缺陷，并非这次 `allow_nan=False` 引入的回归。验证器只检查 `value <= 0`，NaN 的比较结果为 False，因此被接受；正无穷也被接受。独立探针以返回固定会话及 HTTP 200 的 sender 子类隔离网络，在空队列上创建 `heartbeat_interval=NaN` 的 sender：0.205 秒墙钟时间消耗 0.205 秒进程 CPU，`close(timeout=0.05)` 后 worker 仍 alive。探针最后主动入队解除等待并 join，未留下空转线程。`timeout=NaN/Inf` 与 `heartbeat_interval=Inf` 也被实际构造接受，但本报告不把它们的运行后果写成已实测。建议拒绝两个参数的一切非有限值，并增加有意义的参数回归。

最小校验复现（仓库根目录，可直接执行）：

```bash
PYTHONPATH=python python3 -c 'from jev_monitor import MonitorSender; s = MonitorSender(enabled=False, session_file="/tmp/no-session-audit", heartbeat_interval=float("nan")); print("accepted", s.heartbeat_interval)'
```

修复前输出 `accepted nan`，应该在构造阶段抛出 `ValueError`。CPU/关闭完整复现命令为 `python3 -u /tmp/jev-python-audit-2026-10-02.py`，探针保留在本次协作环境中。

PY-A2 在 deleted cwd 对应的 `os.getcwd()` 抛 `FileNotFoundError` 条件下实测；这项组合用例用 `unittest.mock` 注入该实际异常，未伪称在 Windows 上删除了 cwd。`resolve_paths` 会先计算完整 home，再处理独立的 session 覆盖；home 是相对路径时，即使 session 覆盖是绝对路径仍要访问 cwd，最终 `_default_session_file()` 返回 None。原文档“默认路径和绝对路径覆盖不依赖当前目录”缺少这个组合限制。建议发送器优先解析明确的 session 覆盖；否则缩窄文档承诺。

可复现片段（仓库根目录、`PYTHONPATH=python`）：

```python
import os
from unittest import mock
from jev_monitor import MonitorSender

with mock.patch('os.getcwd', side_effect=FileNotFoundError('deleted cwd')):
    with mock.patch.dict(os.environ, {
        'JEV_MONITOR_HOME': 'relative-home',
        'JEV_MONITOR_SESSION': '/tmp/absolute-session-audit',
    }):
        sender = MonitorSender(enabled=False)
        print(sender.session_file)
```

修复前输出 None；绝对 session 路径应可独立使用。

## 实际执行的验证

1. `python3 -m unittest discover -s python/tests -v`：26/26 通过，17.602 秒。首次在沙盒内执行时 15 项因 `socket.socket()` 的 `PermissionError` 报错；随后经自动审批允许在沙盒外重跑，全通过。沙盒失败不计为产品失败，亦不把初次结果写成绿灯。
2. `python3 -u /tmp/jev-python-audit-2026-10-02.py`：独立诊断，实测：
   - 创建并关闭/释放 160 个 sender，GC 后全部弱引用为空；只有 1 个属于本模块的全局 at_fork registration。Python 标准库 `random` 另有自己的 callback，未误计为 sender 泄漏。
   - 12 次真实 fork；在每次 fork 前由另外一个背景线程同时持有 sender lock、队列 mutex、wake/stop condition 以及禁用/已关闭 sender 的 lock。子进程首次发送时由 8 个线程竞争启动 worker，共发送 1,440 个事件；全部送达、序号各从 1 连续到 120、producer_id 与父进程不同、无死锁。禁用 sender 未启动线程；已关闭 sender 拒绝发送且未启动线程。
   - 9 种坏 payload（嵌套 NaN/Inf、NaN 字典键、set、循环、孤立 surrogate、超限字符串、非对象 payload）全部返回 False；仅增加 dropped，未增加 sequence 或待报告遥测。随后有效事件从 sequence 1 入队，worker 存活。
   - 默认路径与显式绝对 `session_file` 不读取 cwd；同时复现 PY-A2。
   - 实际复现 PY-A1 的非有限配置接受、CPU 空转与关闭不结束。
3. `python3 -u /tmp/jev-python-network-audit-2026-10-02.py`：沙盒外执行，实际本机 HTTP 探针：
   - 301/302/303/307/308 × 6 种 Location（外部 HTTP、scheme-relative、外部 HTTPS、file URI、相对路径、IPv6 loopback），30 个真实响应全部原样拒绝跟随。
   - 同时设置大小写 HTTP/HTTPS/ALL proxy 环境变量到 `example.invalid` 并清空 NO_PROXY；显式监测 DNS 解析，只发生 127.0.0.1 的解析。
   - 记录服务器只收到 30 个 `POST /events`；没有 `/exfil`、转成 GET 或 Authorization 转发。探针在任何非 loopback DNS lookup 之前会断言失败，未连接外部目标。
   - 15 个 URL 边界（反斜杠/userinfo、百分号、host 后缀、整数及缩写地址、IPv6、路径/query/fragment、越界/非数端口）均拒绝。控制空白经解析后被规范化为精确 loopback origin，未用于拼接原始可疑 URL。

## 限制与后续复核

本轮在 Linux/Python 3.13.5 实测，未在 Python 3.9、Windows 或 macOS 执行；Windows 无 `os.fork`，不把 Linux fork 结果当作 Windows 原生验收。既有 26 项测试已覆盖真实 cwd 删除以及父队列留给父进程发送；独立 fork 压测专门扩大到“锁被消失背景线程持有”与“多个线程竞争子 worker 首次启动”，没有重复声称一般第三方库都能安全 fork。

集成 agent 已明确把 PY-A1、PY-A2 纳入本轮修复。修复后至少应复核：两个数值参数均拒绝 NaN/±Inf，合法参数仍工作；deleted cwd 下独立 session 覆盖能送达；完整 Python tests 与 fork/GC 探针仍通过。未经该轮复核，PY-A1 仍维持阻断状态。

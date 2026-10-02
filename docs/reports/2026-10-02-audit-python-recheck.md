# 2026-10-02 Python 发送器独立复核

- 复核者：codex / unknown，独立审计 agent；执行环境未可靠提供模型系列，未参与本轮 Python 修复实现。
- 工作区：`/home/box/jev-monitor-bar-completion`，HEAD `7aa03ddde526423a5451fe34aa3879affd384915`；复核对象为 Python 最终暂存 diff，不以旧 HEAD 表示新修复已提交。
- 环境：Linux 6.12.94+ x86_64，Python 3.13.5。
- 范围：前一份 [Python 审计](2026-10-02-audit-python.md) 的 PY-A1 / PY-A2 修复；补查非有限 payload、锁继承与 fork、关闭/禁用状态、GC、会话路径优先级、loopback / proxy / redirect。
- 本 agent 未修改应用源码、测试或既有审计历史，未 commit/push；仅更新 `/tmp` 诊断探针并新增本报告。

结论：PY-A1、PY-A2 已通过独立复现与针对性回归，Python 范围内未发现剩余阻断项。前一份报告保留修复前发现，本报告提供修复后证据；Linux 结果不代表 Windows 或 macOS 原生验收。

## 修复确认

| 编号 | 最终实现位置 | 独立实测 | 复核状态 |
| --- | --- | --- | --- |
| PY-A1 | `python/jev_monitor/sender.py:195`、`:245` | `timeout` 与 `heartbeat_interval` 的 NaN / ±Inf 均在构造阶段抛出 `ValueError`；同时检查 enabled=True / False，没有创建 worker，也没有加入 sender 注册集合 | 已复核通过，解除该项阻断 |
| PY-A2 | `python/jev_monitor/paths.py:50`、`:74`；`python/jev_monitor/sender.py:176`、`:252` | Linux 上真实删除 cwd，使 `os.getcwd()` 实际抛出 `FileNotFoundError`；相对 `JEV_MONITOR_HOME` 加绝对、含 `..` 的 `JEV_MONITOR_SESSION` 能构造发送器并经真实本机 HTTP 送达 | 已复核通过 |

PY-A1 的参数校验位于队列、事件、锁、HTTP opener 和 worker 初始化之前。独立探针覆盖两参数 × 十个无效值 × 两种 enabled 状态，共 40 个拒绝组合：NaN、正无穷、负无穷、`10 ** 1000`、True、False、0、-1、字符串、None。用 worker spy 检查线程工厂未调用，同时断言 `_SENDERS` 数量不变。三个正有限构造对照（1、0.1、`sys.float_info.max`）均可在 disabled 状态构造；最后一个对照只验证构造，不声称超大 timeout 实际网络请求可用。旧 NaN 空转用例现在在 worker 初始化前即被拒绝，没有再启动空转线程。

PY-A2 的独立 HTTP 探针使用自己的 `ThreadingHTTPServer`、随机 loopback 端口和合成 token，没有复用仓库测试的接收器。实际验证：

1. 删除 cwd 后，环境中的绝对会话覆盖独立于相对数据 home；路径中的 `nonexistent/..` 被规范化后打开正确文件。
2. 前置三个嵌套 NaN / ±Inf payload 全部拒绝、计入 dropped；之后正常事件实际送达，sequence 为 1，没有错误遥测或序号空洞。
3. 将环境会话路径改成相对路径后，构造参数 `session_file=<绝对路径>` 仍优先于两个无法解析的环境路径，第二个 producer 也实际送达 sequence 1。
4. 仅有相对环境路径的 sender 能完成构造并保持 offline；`emit` 入队、关闭时正确计入丢弃，没有向服务器发送离线事件。
5. 只收到上述两条正常事件；三个 sender 的 worker 全部退出，释放对象并 GC 后弱引用全为空。
6. 三个平台的纯路径对照中，绝对 SESSION 同时绕过抛错的 `os.getcwd()` 与 `Path.home()`；Windows / macOS 分支仅在 Linux 上按平台参数模拟。

`resolve_paths()` 仍负责解析完整数据 home，因此上述相对 home 在 deleted cwd 下仍会抛出 `FileNotFoundError`；独立探针明确确认这一点。发送器改用专门的 `resolve_session_file()`，没有给完整路径接口捏造 home 回退。Python README 的说明与此行为一致。

## 实际执行的命令与结果

### 独立诊断

`python3 -u /tmp/jev-python-audit-2026-10-02.py`：通过。该探针从前次审计版本更新了 PY-A1 的拒绝预期和 PY-A2 的断言，保留其余独立检查。

- 160 个 sender 创建、关闭或释放后全部可 GC；本模块只有一个全局 fork callback 注册，没有每个 sender 注册一份强引用。
- 12 次真实 Linux fork：由消失的背景线程持有 sender lock、队列 mutex、wake / stop condition 以及关闭/禁用 sender 的锁；子进程的八个线程竞争首次启动，内存接收对照共记录 1,440 条事件。每个子进程序号 1–120 连续、producer_id 改变，关闭和禁用状态保留，没有死锁。此压测的 `_post` 是内存替身；真实 HTTP fork 投递另由下方仓库回归覆盖。
- 九种坏 payload（嵌套非有限数、NaN 键、set、循环、孤立 surrogate、超限字符串、非对象 payload）全部拒绝，不占用序号、不增加待报告遥测；后续有效事件从 sequence 1 入队，worker 存活。
- 40 个无效时间参数组合拒绝、三个有限构造对照及相对 HOME / 绝对 SESSION 对照通过。

`python3 -u /tmp/jev-python-recheck-combinations-2026-10-02.py`：通过。真实 cwd 删除、合成会话文件、路径优先级、坏 payload 后恢复、实际 HTTP、offline 关闭与对象释放的组合验证见上节。首次在沙盒内因 `socket.socket()` 得到 `PermissionError`，随后经自动审批在沙盒外重跑通过；沙盒拒绝不计为产品失败，也不把第一次执行写成绿灯。

`python3 -u /tmp/jev-python-network-audit-2026-10-02.py`：沙盒外通过。

- 301 / 302 / 303 / 307 / 308 × 六种 Location，共 30 个真实 HTTP 响应均拒绝跟随；服务器仅收到原始 `POST /events`，没有目标请求、改成 GET 或 Authorization 转发。
- 对外 HTTP / HTTPS / ALL proxy 环境变量不起作用；探针拦截 DNS，仅发生 `127.0.0.1` 查询，在任何外部查询前都会断言失败，没有外部连接。
- 15 个非标准 host、userinfo、路径/query/fragment、IPv6 或端口边界被拒绝；两个控制空白对照被规范化成精确 loopback origin。

### 针对性仓库回归

实际命令（沙盒外）：

```bash
PYTHONPATH=python:python/tests python3 -m unittest -v \
  test_paths \
  test_sender.SenderTest.test_nonfinite_time_parameters_raise_before_starting_worker \
  test_sender.SenderTest.test_nonfinite_numbers_are_rejected_before_enqueueing \
  test_sender.SenderTest.test_deleted_cwd_does_not_raise \
  test_sender.SenderTest.test_absolute_session_works_with_relative_home_and_deleted_cwd \
  test_sender.SenderTest.test_forked_child_is_a_new_producer \
  test_sender.SenderTest.test_fork_preserves_disabled_and_closed_state
```

结果：9/9 通过，3.202 秒，无跳过。关闭 offline 队列和向 closed sender 发送的预期 warning 不算失败；真实 HTTP fork 回归确认父队列仍由父发送、子 producer 序号从 1 开始且不重发父队列。

本 agent 未重复执行两个 Python 版本的完整 29 项测试；集成方已报告 Python 3.13 与 3.9 各 29/29 通过，该结论须由实施方在自己的验证记录中列明，不冒充本次独立实跑。

## 复核快照与限制

复核时应用文件 SHA-256：

```text
56aeb7796654ae86d05833136735664eab0734406e1f5c353d270d6744b480fd  python/jev_monitor/sender.py
fbea83b003cb47f68579ef72df1776f30ffe220c0566961da0ce086979184763  python/jev_monitor/paths.py
```

已检查 `AGENTS.md`、总需求、方向审计、`docs/AUDIT.md`、实施记录中的平台口径、Python diff 与 Python README。旧报告明确是修复前快照、旧 Windows 验证仍有具体边界；没有发现把本轮 Python / Linux 复核或路径平台模拟写成 Windows 10/11 实机通过的情况。

本次未在 Python 3.9、Windows 或 macOS 执行，没有验证 Electron 窗口、Windows 不抢焦点、混合 DPI、Defender 或干净机器解压即用。Windows 无 `os.fork`，Linux fork 检查不替代 Windows 原生验收。没有读取真实 `.env`、用户会话 token 或业务数据，也未 commit/push。

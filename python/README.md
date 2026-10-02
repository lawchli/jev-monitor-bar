# Python 发送器

仅使用标准库，支持 Python 3.9 及以上。把 `python/` 放到宿主可以导入的位置（或设置 `PYTHONPATH=python`）。不需要 `pip install`。

会话文件与桌面端相同：默认在数据目录的 `session.json`，可用 `JEV_MONITOR_HOME` 或 `JEV_MONITOR_SESSION` 覆盖。`emit` 只把事件放进内存队列，不阻塞宿主。

## 最小示例

```python
from jev_monitor import MonitorSender

with MonitorSender(host_name="my-host") as sender:
    sender.run_started("示例任务", simulated=True)
    sender.progress(phase="执行", completed=1, total=1)
    sender.run_completed()
```

接收端还没起来时事件留在队列里（队列满了就丢）。下次能送达时，会先补发一条 `telemetry.dropped`。`count` 是上次报告以来没能留下的事件：队列满丢掉的，以及已经交给接收端但被 409 或 400/413 拒绝的。调用参数不合法（未知类型、缺少必填 ID）只计入 `stats()['dropped']`，不进这条遥测。

入队时会把整条事件编码成不可变的 UTF-8 JSON。之后再改 payload 不会影响已经入队的内容。编码失败（例如 `set`、循环引用、无法用 UTF-8 表示的字符串、`NaN` 与正负无穷）或编码后超过 64 KiB 时，这条事件被丢弃，只计入 `stats()['dropped']`，不进 `telemetry.dropped`，也不占用序号。发送线程继续处理后面的事件。

发送器优先解析 `JEV_MONITOR_SESSION`，所以绝对会话覆盖可独立使用，即使 `JEV_MONITOR_HOME` 是相对路径且当前目录已被删除。未指定会话覆盖时才按数据 home 查找 `session.json`；相对路径无法解析时，发送器记录警告并保持离线，构造函数仍能完成；队列与丢弃计数照常工作。`emit` 返回 True 只表示事件已入队，实际送达看 `stats()['sent']`。

在 POSIX 宿主中 `fork` 后，子进程会使用新的 `producer_id`，序号从 1 起，队列和统计从空开始，保留原 `run_id`。父进程仍负责发送它自己的积压事件；子进程在首次 `emit` 时启动独立的发送线程，不重复发送父进程的队列。已经关闭或 `enabled=False` 的发送器保留原状态；Windows 没有 `fork`，行为不变。

## 参数

- `queue_size`：整数，至少为 1。小于 1 会抛出 `ValueError`。不要发送时用 `enabled=False`。
- `timeout`：秒，必须是大于 0 的有限数；`NaN` 和正负无穷会抛出 `ValueError`。
- `heartbeat_interval`：秒，必须是大于 0 的有限数；`NaN` 和正负无穷会抛出 `ValueError`。

会话文件里的 `url` 只能是 `http://127.0.0.1` 或 `http://127.0.0.1:<端口>`（路径最多一个 `/`）。不能带用户名、查询串或片段。`localhost`、其他地址和其他 scheme 都当成离线，不会发出请求，也不会把 token 送出本机。

事件 POST 若收到 301、302、303、307 或 308，发送器不跟随 `Location`，因此不会把 `Authorization` 复制到另一个地址。这条事件留在队列里，按其它未分类状态重试。

## 测试

```bash
python -m unittest discover -s python/tests -v
```

## 模拟宿主

先启动监视器，等它写出会话文件，再在仓库根目录运行：

```bash
python python/examples/fake_host.py
```

脚本会依次发送四个模拟运行：正常完成、规则覆盖、失败后重试、验证失败。运行名称都以「模拟：」开头。

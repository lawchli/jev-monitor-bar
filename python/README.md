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

## 参数

- `queue_size`：整数，至少为 1。小于 1 会抛出 `ValueError`。不要发送时用 `enabled=False`。
- `timeout`：秒，必须大于 0。
- `heartbeat_interval`：秒，必须大于 0。

会话文件里的 `url` 只能是 `http://127.0.0.1` 或 `http://127.0.0.1:<端口>`（路径最多一个 `/`）。不能带用户名、查询串或片段。`localhost`、其他地址和其他 scheme 都当成离线，不会发出请求，也不会把 token 送出本机。

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

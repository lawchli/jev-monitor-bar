# 接入指南

本文写给要把自己的任务程序（下称宿主）接到 JEV Monitor Bar 的人。内容按当前代码写：`src/paths.ts`、`src/session.ts`、`src/server.ts`、`src/store.ts`、`src/state.ts`、`src/redact.ts`、`src/protocol.ts`、`protocol/event.schema.json`、`python/jev_monitor/` 和 `python/examples/fake_host.py`。字段的完整规则见 [`docs/PROTOCOL.md`](PROTOCOL.md)。

监视器只读。它不调用 TypeSafe，不控制宿主，也看不到宿主没有发来的东西。宿主在自己的代码里调用 TypeSafe，再把判断、应用选择、执行和验证分别发成事件。

## 1. 宿主怎样找到监视器

### 会话文件

监视器启动时按这个顺序做：

1. 用 `resolveMonitorPaths` 算出数据目录和会话文件路径。
2. 在 `127.0.0.1` 上监听一个由系统分配的端口。
3. 把 `{"url":"http://127.0.0.1:<端口>","token":"<64 位十六进制>"}` 写进会话文件。

宿主读这个文件，拿到地址和 token，再 `POST <url>/events`。端口和 token 每次启动都会变，不要写进宿主的配置。

### 路径

| 平台 | 默认数据目录 |
| --- | --- |
| Windows | `%LOCALAPPDATA%\jev-monitor-bar\`。`LOCALAPPDATA` 为空时是用户主目录下的 `AppData\Local\jev-monitor-bar\` |
| macOS | `~/Library/Application Support/jev-monitor-bar/` |
| Linux 及其他 | `XDG_STATE_HOME` 是非空绝对路径时为 `$XDG_STATE_HOME/jev-monitor-bar/`，否则为 `~/.local/state/jev-monitor-bar/` |

- 会话文件默认是数据目录下的 `session.json`。
- `JEV_MONITOR_HOME` 非空时替换数据目录。`JEV_MONITOR_SESSION` 非空时单独指定会话文件。空字符串等于没设。
- 相对路径接在各自进程的当前目录上。宿主和监视器的当前目录不同，就会找不到对方。跨进程请用绝对路径。
- Python 的 `jev_monitor.resolve_paths()` 与桌面端用同一套规则，两边共用 `tests/fixtures/paths-cases.json` 里的用例。
- Windows 与 macOS 的默认目录写在代码里，还没有在这两个系统上实机验收。

从源码运行时，数据目录不是上表的默认值：

- `pnpm start`：没有设置 `JEV_MONITOR_HOME` 时，用仓库里的 `.runtime/dev`。设置了就沿用。宿主要连它，把 `JEV_MONITOR_HOME` 设成同一个绝对路径，例如 `<仓库>/.runtime/dev`。
- `pnpm demo`：固定用 `<仓库>/.runtime/demo`，会话文件是其中的 `session.json`。启动前先清空这个目录。
- 上表的默认目录只在直接运行桌面主进程、并且没有设置 `JEV_MONITOR_HOME` 时生效。

### 只走 127.0.0.1

- 接收端只监听 `127.0.0.1`，不监听 `0.0.0.0`。
- Python 发送器只接受 `http://127.0.0.1` 或 `http://127.0.0.1:<端口>` 形式的会话 `url`。`localhost`、IPv6、其他主机，以及带用户名、查询串、片段或路径的 `url`，都当作离线，不发请求。它也不用系统代理。
- 其他语言的宿主也应该先这样检查 `url`，再带 token 发请求。

### 监视器没在运行

- 监视器正常退出时，只有会话文件里的 token 仍是自己的，才删掉这个文件。
- 没有会话文件、文件内容不完整、端口没人监听，发送端都按离线处理。Python 发送器把事件留在有界队列里，每次重试前看会话文件有没有变，退避从 0.5 秒起翻倍，最长 5 秒。
- 监视器异常退出时，旧会话文件可能留下。旧端口通常已经没人监听，连接失败；如果被别的程序占用，会得到别的状态码。Python 发送器两种情况都按离线重试，直到监视器重新启动、写入新会话。
- 宿主任务不应该因为监视器离线而等待或失败。

### token 轮换

- 每次启动接收端都生成新 token（32 个随机字节的十六进制），端口通常也不同。
- 旧 token 得到 401。Python 发送器在会话文件的修改时间变化时重读它；收到 401 时强制重读，token 变了就立刻用新 token 重发，没变就退避。
- 发送端不需要手动重连，也不需要重启。

### 会话文件的权限

- POSIX：先写 `<会话文件>.<pid>.<随机>.tmp`（mode 0600），再 `rename` 覆盖，之后 `chmod` 0600。已有文件也会被改回 0600。
- Windows：`mode` 和 `chmod` 不改变 ACL。会话文件的保护依赖用户目录（`%LOCALAPPDATA%`）本身的权限。
- token 只对本机这一个接收端有效。不要打印它、写进日志、放进事件或发到别处。

## 2. Python 发送器

### 放进宿主

需要 Python 3.9 或更高，只用标准库。把 `python/jev_monitor/` 整个目录（`__init__.py`、`paths.py`、`sender.py`）复制到宿主能 import 的位置，或者设置 `PYTHONPATH=<仓库>/python`。不需要 `pip install`。

### 一次完整的闭环

先启动监视器，再在同一个 `JEV_MONITOR_HOME` 下运行：

```python
import time

from jev_monitor import MonitorSender

with MonitorSender(host_name='my-host') as sender:
    sender.run_started('模拟：接入示例', simulated=True)  # 真实任务去掉 simulated
    sender.progress(phase='规划', completed=0, total=3)

    # 1. 调用 TypeSafe 之前：问题和已知候选，还没有概率
    sender.decision_started(
        'd-1', 'req-1', 'next', 'choice', '下一步做什么？',
        candidates={'open_report': '打开完整报告', 'open_summary': '打开摘要'},
        summary='已读取目录，共 12 个文件',
    )
    started = time.monotonic()
    # answer = ...  宿主自己的 TypeSafe 调用，监视器不参与
    latency_ms = round((time.monotonic() - started) * 1000)

    # 2. 收到响应之后：只填上游实际返回的值
    sender.decision_resolved(
        'd-1', 'req-1', 'next', 'choice',
        choice='open_report',
        probabilities={'open_report': 0.62, 'open_summary': 0.38},
        confidence=0.41,
        model='example-model',
        latency_ms=latency_ms,
    )

    # 3. 应用的最终选择。这里规则把 open_report 改成了 open_summary
    sender.action_selected(
        'act-1', 'try-1', 'open_summary', 'rule',
        decision_id='d-1', rule='报告超过 50 页先读摘要', rule_source='host/policy.py',
    )
    sender.action_started('act-1', 'try-1', decision_id='d-1')
    sender.action_completed('act-1', 'try-1', decision_id='d-1')

    # 4. 验证。动作完成不等于目标达成
    sender.verification(
        'act-1', 'try-1', 'passed',
        [{'name': '摘要已打开', 'observed': '窗口标题含“摘要”', 'result': 'passed'}],
        decision_id='d-1',
    )
    sender.progress(phase='规划', completed=1, total=3)
    sender.run_completed()

    sender.close(timeout=5)  # 退出前最多等 5 秒把队列发完
    print(sender.stats())
```

正常时最后一行打印 `{'sent': 10, 'dropped': 0, 'conflicts': 0, 'rejected': 0, 'offline': False}`。`offline` 为 True 说明没找到会话，先检查 `JEV_MONITOR_HOME`。

- 一个 `MonitorSender` 对应一个 run。没给 `run_id` 时自动生成 `run-<UTC 时间>-<6 位十六进制>`。
- `producer_id` 是 `<host_name>-<pid>-<8 位十六进制>`，每个实例都不同。宿主重启后要接着同一个 run，就传同一个 `run_id`；新的 `producer_id` 让序号从 1 重新开始，不会得到 409。
- 值为 `None` 的 payload 字段不发送。

### 构造参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `run_id` | 自动生成 | 这次任务的 ID |
| `host_name` | `'host'` | `producer_id` 的前缀。不合规的字符换成 `-` |
| `session_file` | `resolve_paths()['session_file']` | 会话文件路径 |
| `queue_size` | 1000 | 队列最多几条。必须是 ≥1 的整数，否则 `ValueError` |
| `timeout` | 0.5 | 单次 HTTP 的超时秒数，必须大于 0 |
| `heartbeat_interval` | 5.0 | 多少秒没有成功发送就补一条 `heartbeat`，必须大于 0 |
| `enabled` | True | False 时所有方法直接返回 True，不启动线程，不计数 |

### 方法

| 方法 | 事件 |
| --- | --- |
| `run_started(name, simulated=False)` | `run.started` |
| `run_completed()`、`run_failed(reason)`、`run_cancelled(reason)` | `run.completed` / `run.failed` / `run.cancelled` |
| `progress(phase=None, completed=None, total=None, summary=None)` | `progress.updated` |
| `decision_started(decision_id, request_id, question_id, kind, question, candidates=None, summary=None)` | `decision.started` |
| `decision_resolved(decision_id, request_id, question_id, kind, *, choice, score, noul, probabilities, confidence, model, latency_ms, legend, explanation, explanation_source)` | `decision.resolved`（关键字参数都可省） |
| `decision_failed(decision_id, request_id, question_id, kind, reason)` | `decision.failed` |
| `action_selected(action_id, attempt_id, action, source, decision_id=None, rule=None, rule_source=None, reason=None)` | `action.selected` |
| `action_started` / `action_completed` / `action_failed` / `action_cancelled`（`action_id, attempt_id, decision_id=None, reason=None, retry=None`） | `action.*` |
| `verification(action_id, attempt_id, result, checks, decision_id=None, reason=None)` | `verification.completed` |
| `emit(type, payload=None, **ids)` | 任意类型。helper 没有的字段用它发，例如 `usage`、`action.selected` 的 `retry` |
| `stats()` | 返回 `sent`、`dropped`、`conflicts`、`rejected`、`offline` |
| `close(timeout=2.0)` | 最多等 `timeout` 秒把队列发完。`with` 退出时也会调用 |

发送器自己只检查：事件类型认识、payload 是字典、ID 是字符串、必填 ID 齐全、能编码成 JSON、编码后不超过 65536 字节。其余规则（字段名、取值范围、概率总和、`rule` 必须带 `rule_source` 等）由接收端检查，不合格得到 400，发送器记为 `rejected`。先对着 `pnpm demo` 或测试用的接收端跑一遍，确认 `stats()['rejected']` 为 0。

### 失败隔离

下表是 `python/jev_monitor/sender.py` 当前的行为。

| 情况 | 发送器怎么做 | 计数 |
| --- | --- | --- |
| 调用 `emit` 或 helper | `put_nowait` 入队，不阻塞，不抛异常 | |
| 未知类型、payload 不是字典、ID 不是字符串、缺必填 ID | 丢弃，返回 False | `dropped`，不进 `telemetry.dropped` |
| 无法编码（`set`、循环引用、无法用 UTF-8 表示的字符串），或编码后超过 65536 字节 | 入队前丢弃，返回 False，不占序号。入队时已冻结成 UTF-8 JSON，之后再改 payload 不影响已入队的内容 | `dropped`，不进 `telemetry.dropped` |
| 队列满 | 丢弃，返回 False | `dropped`；恢复连接后先补发一条 `telemetry.dropped` |
| `close` 之后再调用 | 丢弃，返回 False | `dropped` |
| 200（包括重复事件的 `accepted:false`） | 算送达 | `sent` |
| 409 | 告警，不重试 | `dropped`、`conflicts`，进 `telemetry.dropped` |
| 400、413 | 不重试 | `dropped`、`rejected`，进 `telemetry.dropped` |
| 401 | 强制重读会话。token 变了立刻重发，否则退避 | `offline` 为 True |
| 连接失败、超时、3xx、403、404、415、503 及其他状态 | 留住这条，退避后重试 | `offline` 为 True |
| 301、302、303、307、308 | 不跟随 `Location`，token 不会被带到别的地址。按上一行重试，不计入 `rejected` | |
| 发送线程里的意外异常 | 丢掉这一条，线程继续 | `dropped` |

另外几点：

- 投递在一个守护线程里做，这个线程不会阻止宿主进程退出。只有调用 `close` 时才等，最多等 `timeout` 秒。
- `telemetry.dropped` 在恢复连接后先于积压事件发送。它的 `sequence` 在生成时才占用，可能比积压事件的大，接收端照常接受。
- 心跳：距上次成功发送超过 `heartbeat_interval` 就发一条 `heartbeat`。界面按 run 最后一次接收的时间显示连接：10 秒内为「在线」，30 秒内为「N 秒无新事件」，更久为「可能断开 · 最后更新 …」。
- `close(timeout)` 超时后仍在队列里的事件，以及正在投递但没送达的那一条，直接丢掉并计入 `stats()['dropped']`，不会再补报给接收端。不调用 `close` 就退出进程时，队列里的事件同样丢掉，也不计数。
- 还有的限制：队列只限条数和单条 64 KiB，没有总字节上限（默认 1000 条，最坏约 64 MiB）。丢弃时在调用线程写 `logging.getLogger('jev_monitor')` 警告，慢的日志 handler 会拖慢 `emit`。

## 3. 一次决策闭环发哪些事件

| 顺序 | 宿主在做什么 | 事件 | 必带的 ID | payload 常用字段 | 界面状态 |
| --- | --- | --- | --- | --- | --- |
| 1 | 任务开始 | `run.started` | | `name`、`simulated` | 等待 |
| 2 | 阶段与进度（可选，随时发） | `progress.updated` | | `phase`、`completed`、`total`、`summary` | 不改状态 |
| 3 | 调用 TypeSafe 之前 | `decision.started` | `decision_id`、`request_id`、`question_id` | `kind`、`question`、`candidates`、`summary`（输入状态摘要） | 评估中 |
| 4 | 收到响应 | `decision.resolved` | 同上 | `kind` 与 `choice` / `score` / `noul`、`probabilities`、`confidence`、`legend`、`model`、`latency_ms`、`explanation` + `explanation_source` | 已选择 |
| 4′ | 调用失败 | `decision.failed` | 同上 | `reason` | 失败 |
| 5 | 应用定下最终动作 | `action.selected` | `action_id`、`attempt_id`，`decision_id` 可选 | `action`、`source`、`rule` + `rule_source`、`reason` | 已选择 |
| 6 | 开始执行 | `action.started` | 同上 | `reason`、`retry` | 执行中 |
| 7 | 执行结束 | `action.completed` / `action.failed` / `action.cancelled` | 同上 | `reason` | 已执行待验证 / 失败 / 取消 |
| 8 | 检查结果 | `verification.completed` | 同上 | `result`、`checks`、`reason` | 验证成功 / 验证失败 / 未知 |
| 9 | 任务结束 | `run.completed` / `run.failed` / `run.cancelled` | | `reason` | 任务结束 / 失败 / 取消 |

- run 结束之前，run 的状态跟着最新的判断或尝试走。结束事件之后，判断和尝试仍更新自己的记录，但不再改 run 状态。
- 只有 `action.selected` 时，界面写「应用选择/待执行」，不写成已执行。`action.completed` 之后、验证之前是「已执行待验证」，不算成功。
- 缺了中间事件也能算出状态，例如没有 `action.started` 的 `action.completed` 就是「已执行待验证」。完整规则见 `docs/PROTOCOL.md`「状态机」。

### Choice、Score、Noul

TypeSafe SDK 的名字和返回字段见 README「已核实的边界」，以官方文档为准。监视器不读 SDK 的响应对象，由宿主把返回值映射成下面的字段：

- Choice：`kind` 为 `choice`。`candidates` 的键是候选名，值是说明或 `null`。`choice` 是选中的键。`probabilities` 用同一组键，每个值在 0 到 1，总和与 1 相差不超过 0.02。`confidence` 在 0 到 1。
- Score：`kind` 为 `score`。`score` 是有序等级上的位置，≥0，可以是小数。`legend` 把等级键映射成文字。可以另带 `probabilities` 和 `confidence`。
- Noul：`kind` 为 `noul`。`noul` 是「是」的概率，0 到 1。不带 `confidence` 和 `probabilities`，带了整条事件会被拒绝。

界面按各自语义展示：Choice 画概率条；Score 在 legend 刻度上标位置；Noul 只显示「是」的概率。`confidence` 写成「分布集中度 …（不是正确率）」。

- `decision.started` 不带概率。响应回来之前，界面显示「正在评估候选」，概率为「未知」。不要先发估计值。
- `latency_ms` 是宿主量到的模型响应耗时，不是界面延迟。
- `explanation` 只放调用方明确提供的简短说明，并且必须带 `explanation_source`。没有就不发，界面显示「未提供」。监视器不会另调模型补理由。

### 一次请求问几个问题

一次 SDK 调用带几个问题时，共用 `request_id`，每个问题有自己的 `question_id` 和 `decision_id`：

```python
sender.decision_started('d-next', 'req-7', 'next_action', 'choice', '下一步？',
                        candidates={'left': '向左', 'right': '向右'})
sender.decision_started('d-goal', 'req-7', 'goal_reached', 'noul', '是否已到达目标？')
sender.decision_started('d-danger', 'req-7', 'danger', 'score', '危险程度？')
# ……同一次请求的响应回来后，逐题填写
sender.decision_resolved('d-next', 'req-7', 'next_action', 'choice',
                         choice='left', probabilities={'left': 0.55, 'right': 0.45}, confidence=0.1)
sender.decision_resolved('d-goal', 'req-7', 'goal_reached', 'noul', noul=0.2)
sender.decision_resolved('d-danger', 'req-7', 'danger', 'score', score=0.8,
                         legend={'0': '安全', '1': '危险'},
                         probabilities={'0': 0.2, '1': 0.8}, confidence=0.6)
```

调用失败时发 `decision.failed`，不要发一个假的结果：

```python
sender.decision_started('d-2', 'req-8', 'next_action', 'choice', '下一步？')
sender.decision_failed('d-2', 'req-8', 'next_action', 'choice', 'TypeSafe 请求超时')
```

### 规则直接决策

没有调用 TypeSafe、由规则直接定下动作时，不发 `decision.*`。`action.selected` 不带 `decision_id`，`source` 为 `rule`。界面把它标成「规则决策」，不写成 JEV 调用：

```python
sender.action_selected('act-stop', 'try-1', 'stop', 'rule',
                       rule='电量低于 5% 时停止', rule_source='host/rules.yaml')
```

### 覆盖模型的选择

`action.selected` 带上被覆盖的那个 `decision_id`，`action` 写实际要执行的动作：

- 规则改选：`source` 为 `rule`，带 `rule` 和 `rule_source`（见第 2 节的示例）。界面写「JEV 选择 A → 规则覆盖为 B（规则 X · 来源 Y）」。缺了 `rule` 或 `rule_source` 时，那一处显示「未提供」。
- 应用改选：`source` 为 `application`，可以用 `reason` 说明原因。界面写「应用覆盖为 B」，不会编造规则名或来源。
- 照模型的选择执行：`source` 为 `model`。

```python
sender.action_selected('act-2', 'try-1', 'right', 'application',
                       decision_id='d-next', reason='左侧通道已被占用')
sender.action_started('act-2', 'try-1', decision_id='d-next')
sender.action_completed('act-2', 'try-1', decision_id='d-next')
sender.verification('act-2', 'try-1', 'unknown',
                    [{'name': '位置', 'observed': '传感器没有读数', 'result': 'unknown'}],
                    decision_id='d-next', reason='无法观测')
```

### 重试

重试沿用 `action_id`，换一个新的 `attempt_id`。每次尝试都从 `action.selected` 发起：

```python
sender.action_selected('act-3', 'try-1', 'upload', 'model', decision_id='d-next')
sender.action_started('act-3', 'try-1', decision_id='d-next')
sender.action_failed('act-3', 'try-1', decision_id='d-next', reason='timeout')
sender.action_selected('act-3', 'try-2', 'upload', 'model', decision_id='d-next')
sender.action_started('act-3', 'try-2', decision_id='d-next', retry=1)
sender.action_completed('act-3', 'try-2', decision_id='d-next', retry=1)
```

重试次数按「同一 `action_id` 的尝试数减 1」统计，不读 `retry` 字段。上面第二次尝试只完成、没有验证，计入「未验证」，不算成功。

helper 没有的字段用 `emit` 发。例如带上游 usage 的结果：

```python
sender.emit(
    'decision.resolved',
    {'kind': 'noul', 'noul': 0.25, 'usage': {'input_tokens': 812, 'output_tokens': 3}},
    decision_id='d-goal', request_id='req-7', question_id='goal_reached',
)
```

### 验证

- `result` 为 `passed`、`failed` 或 `unknown`。
- `checks` 为 1–50 条，每条必填 `name`、`observed`、`result`，`evidence` 可选，放证据的引用（日志行号、文件名等），不要放大段原文。
- 执行失败或取消之后再发验证，尝试仍停在「失败」或「取消」。

### 稳定的 ID

- ID 长度 1–160，只能用 `A–Z`、`a–z`、数字和 `_ . : / -`。中文和空格都不行。宿主已有的 ID（例如参考宿主 `JevJudgment` 里的 `request_id`）不合规时，先转换。
- `request_id`：一次 SDK 调用一个。`question_id`：问题的固定名字，例如 `next_action`、`goal_reached`。`decision_id`：在 run 内唯一，例如 `<request_id>:<question_id>`。
- `action_id` 是一个逻辑动作，`attempt_id` 是它的一次尝试。
- 判断和尝试都按 run 记录。同一 run 里，一个 `decision_id` 不要换到另一个 request 或 question 上：后到的事件不会更新该判断，只让 `anomalies` 加 1。一次尝试已经记下 `decision_id` 之后又带来另一个，同样按异常处理。
- `event_id` 每条事件唯一。重发同一条时保持不变，接收端靠它去重。

## 4. 不要发送的内容

- 不要发 API key（包括 `TYPESAFE_API_KEY`）、`Authorization` 头、cookie、密码、环境变量、原始 prompt 或原始输入。只发摘要和必要字段。
- 接收端的脱敏是兜底，不是保证。自由文本只替换这几种写法：`Bearer <凭证>`；`sk-`、`ts-`、`key-`（或 `_`）后接至少 12 位；`api_key`、`password`、`secret`、`token`、`authorization` 用 `=` 或 `:` 带出的值。其他格式，例如 `ghp_` 开头的令牌，会原样保存。
- 对象里键名像 authorization、cookie、password、secret、token、api key、credential、environment、`env`、raw input、prompt、`state` 的，整个值换成 `[REDACTED]`。payload 的顶层字段由 schema 固定，这条实际作用于 `diagnostic` 这类嵌套对象。
- `candidates`、`probabilities`、`legend`、`usage` 的键是候选名，不按键名脱敏，否则候选和概率就对不上了。只对值做文本脱敏。这些键会原样出现在界面和导出里，不要把秘密放进候选名或 legend 的键。
- ID、`type`、`sequence` 和时间不做任何处理。不要把秘密或个人信息放进 ID。
- `diagnostic`：桌面端创建 `EventStore` 时没有打开诊断模式，也没有提供开关，所以现在 `diagnostic` 入库时总是被删掉。诊断模式只在代码层面存在（`EventStore` 的 `diagnostics` 参数），打开时仍按键名和内容脱敏。导出总是删掉 `diagnostic`。
- 监视器看不到模型的隐藏思考。它只显示宿主发来的事件，不读取 SDK 或模型的内部状态，不生成推理过程，也不补写理由。
- 事件只写在本机数据目录的 JSONL 里。导出文件的位置由用户选择。

## 5. 非 Python 宿主：直接发 HTTP

### 请求

- `POST <url>/events`，一个请求一条事件。
- 头：`Content-Type: application/json`（可以带 `; charset=utf-8`，前缀区分大小写）；`Authorization: Bearer <token>`。
- 不要带 `Origin` 头，带了就是 403。浏览器页面因此不能直接发送。
- 正文是 UTF-8 JSON，最多 65536 字节。
- 不要跟随重定向。
- 健康检查：`GET <url>/health`，用同一个 Bearer，返回 `{"ok":true,"cursor":N}`。路径要完全相同，带查询串就是 404。

事件的公共字段：

| 字段 | 怎么填 |
| --- | --- |
| `schema_version` | `1` |
| `event_id` | 每条事件唯一，例如 UUID。重发时不变 |
| `run_id` | 这次任务 |
| `producer_id` | 每次进程启动换一个新值，例如 `<宿主名>-<pid>-<随机串>` |
| `sequence` | 同一 `producer_id` 内递增的整数，从 1 起 |
| `occurred_at` | 发送端时间，ISO 8601，以 `Z` 或 `±HH:MM` 结尾。JavaScript 的 `new Date().toISOString()` 可以直接用 |
| `type` | 16 种事件类型之一 |
| `payload` | 对象。schema 没列出的字段会让整条被拒绝 |
| `decision_id` 等 | 按第 3 节的表 |

不要发 `received_at` 和 `cursor`，它们由接收端加上。

### 响应和该怎么做

| 状态 | 正文 | 含义 | 发送端怎么做 |
| --- | --- | --- | --- |
| 200 | `{"accepted":true,"cursor":N}` | 已写入 | 完成 |
| 200 | `{"accepted":false,"cursor":N}` | 这个 `event_id` 已在去重窗口里 | 当作已送达 |
| 409 | `{"accepted":false,"conflict":true,"cursor":N}` | 同一 `run_id` + `producer_id` + `sequence` 已被另一个 `event_id` 占用 | 不重试。记为丢弃并告警。多半是重启后沿用了旧 `producer_id`，换一个新值 |
| 400 | `{"error":"Invalid JSON"}` 或 `{"error":"Invalid protocol event"}` | 事件本身不合格 | 同一正文重发也会失败。记为丢弃，修正映射 |
| 400 | `{"error":"Incomplete request"}` | 正文没传完连接就断了 | 可以用同一个 `event_id` 重发 |
| 413 | `{"error":"64 KiB event limit"}` | 超过 65536 字节 | 丢弃，或缩短摘要后作为新事件发送 |
| 415 | `{"error":"JSON required"}` | `Content-Type` 不对 | 补上 `application/json` |
| 401 | `{"error":"Local session credential required"}` | 没带 token、token 已过期，或缺少区分大小写的 `Bearer ` 前缀 | 重读会话文件。token 变了就用新 token 重发，没变就退避 |
| 403 | `{"error":"Origin rejected"}` | 带了 `Origin`，或来源不是本机 | 去掉 `Origin`，确认连的是 `127.0.0.1`。这不是临时错误 |
| 404 | `{"error":"Not found"}` | 方法或路径不对。只有 `GET /health` 和 `POST /events` | 修正路径 |
| 503 | `{"error":"Storage unavailable"}` | 写盘失败，这条没有保存 | 退避后用同一个 `event_id` 重发 |
| 408 | 空（Node 内置） | 请求在 `requestTimeout`（2 秒）内没有发完。Node 每 0.5 秒检查一次，所以大约 2–2.5 秒回复 | 退避后重发 |
| 无响应 | | 连接失败或超时：监视器不在运行，或已换了端口 | 重读会话文件，按离线处理 |

一条请求有几个问题时，只报最先检查到的那个，顺序见 `docs/PROTOCOL.md`「版本与传输」。

发送端的做法：

- 放在后台队列里发，不要在宿主的主流程里等。队列要有上限，满了就丢并计数，恢复后发一条 `telemetry.dropped`（`payload.count` 为丢掉的条数）。单次超时要短，Python 发送器默认 0.5 秒。
- 重发时保持 `event_id` 和 `sequence` 不变。只要还在去重窗口内，重复会得到 200 和 `accepted:false`。
- 不要把一个 `sequence` 用在另一条事件上。
- 长时间没有事件时，每隔几秒发一条 `heartbeat`（Python 发送器默认 5 秒），界面才不会显示「可能断开」。
- `Authorization` 必须是 `Bearer <token>`。`Bearer ` 前缀区分大小写，不带前缀或写成 `bearer` 都得到 401。

### Node 示例

需要自带 `fetch` 的 Node（18 起），不需要第三方包。为了短，这里逐条 `await`、失败不重试；正式接入按上一节放进后台队列。

```js
// send-one.mjs：用法 node send-one.mjs <会话文件的绝对路径>
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';

const sessionFile = process.argv[2];
const producerId = `js-host-${process.pid}-${randomUUID().slice(0, 8)}`; // 每次启动换新值
let sequence = 0;

function readSession() {
  try {
    const {url, token} = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    const u = new URL(url);
    const loopback = u.protocol === 'http:' && u.hostname === '127.0.0.1';
    if (!loopback || u.username || u.password || u.pathname !== '/' || u.search || u.hash) return undefined;
    return {url: u.origin, token};
  } catch {
    return undefined; // 没有会话文件：监视器没在运行
  }
}

async function send(runId, type, payload = {}, ids = {}) {
  const session = readSession();
  if (!session) return 'offline';
  sequence += 1;
  const event = {
    schema_version: 1,
    event_id: randomUUID(),
    run_id: runId,
    producer_id: producerId,
    sequence,
    occurred_at: new Date().toISOString(),
    type,
    payload,
    ...ids,
  };
  try {
    const response = await fetch(`${session.url}/events`, {
      method: 'POST',
      headers: {'content-type': 'application/json', authorization: `Bearer ${session.token}`},
      body: JSON.stringify(event),
      redirect: 'manual', // 不跟随重定向，token 不离开这次请求
      signal: AbortSignal.timeout(500),
    });
    return `${response.status} ${await response.text()}`;
  } catch {
    return 'offline'; // 连接失败或超时
  }
}

const runId = `js-run-${Date.now()}`;
console.log(await send(runId, 'run.started', {name: '模拟：Node 发送示例', simulated: true}));
console.log(
  await send(runId, 'action.selected', {action: 'stop', source: 'rule', rule: '手动检查', rule_source: 'send-one.mjs'}, {
    action_id: 'act-1',
    attempt_id: 'try-1',
  }),
);
console.log(await send(runId, 'run.completed'));
```

正常时打印三行 `200 {"accepted":true,"cursor":N}`。

### 用 curl 手动检查

POSIX shell。token 会出现在命令行参数里，本机其他用户用 `ps` 能看到，只在自己的机器上手动检查时这样用：

```sh
SESSION=/绝对路径/session.json
URL=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["url"])' "$SESSION")
TOKEN=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["token"])' "$SESSION")
curl -s "$URL/health" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "$URL/events" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data-binary '{"schema_version":1,"event_id":"curl-1","run_id":"curl-run","producer_id":"curl-test","sequence":1,"occurred_at":"2026-09-30T00:00:00Z","type":"run.started","payload":{"name":"模拟：curl 检查","simulated":true}}'
```

第一次 POST 得到 `{"accepted":true,...}`，原样再发一次得到 `{"accepted":false,...}`。

## 6. 时间与顺序

- `occurred_at` 来自发送端时钟。`received_at` 由接收端在写入时加上，用接收端时钟。两者都保存。时间线在两者相差超过 5 秒时标「迟到」。
- 同一 `producer_id` 内，只按 `sequence` 排先后，不看 `occurred_at`。
- 不同 `producer_id` 之间（例如宿主重启后用新 `producer_id` 接着同一个 run，或两个进程写同一个 run），先比 `occurred_at`，相同再比 `event_id` 的字典序。跨 producer 的先后因此取决于发送端时钟（审计 C11）。时钟回拨或有偏差时，另一路更晚的时间戳可以盖过这一路更大的序号。`received_at` 不参与排序，不能纠正这种偏差。
- run 的结束事件只看 `occurred_at`：比已记下的结束时间更晚才替换。
- 建议一个 run 只由一个 producer 发送。必须多进程时，用同一台机器的系统时钟，`occurred_at` 用带毫秒的 UTC（Python 发送器就是这样）。不要为了排序去改 `occurred_at`。
- 去重只在内存窗口内：最近 20000 条，且序列化后合计不超过 32 MiB。窗口外的旧事件重发，可能被再次接受并再次计入状态（审计 C8）。

## 7. cursor 与损坏的尾行

- `cursor` 由接收端分配，从 1 开始，每接受一条新事件加 1。宿主不需要读它，界面分页和导出用它。
- 接收端在 `appendFileSync` 返回之后才回 200。写入没有调用 fsync。
- 重启恢复时，能 `JSON.parse`、并且 `cursor` 是安全整数的行计入高水位，即使校验失败。完全无法解析的残行（进程或系统在写一行时中断）只计入 `corruptLines`，不抬高 cursor（审计 C6）。如果这样的残行原来占用了某个 cursor，重启后这个 cursor 可能分给新事件。按 cursor 合并多份导出的工具要考虑这一点。
- 每次重启都新开一个段文件，残行不会和新事件写在同一行。

## 8. 不接 TypeSafe 也能试

```sh
pnpm install
pnpm demo
```

`pnpm demo` 构建后启动桌面窗口，数据目录固定为 `<仓库>/.runtime/demo`，启动前清空。演示宿主 `scripts/demo-host.mjs` 通过同一个 HTTP 接口循环播放 `fixtures/scenarios/` 的 7 个场景：正常完成、概率分散、规则覆盖、失败后重试、验证失败、断线恢复、并发决策。运行名都以「模拟：」开头，界面标「模拟数据」。关掉窗口就结束。

演示运行时，另开一个终端，在仓库根目录跑 Python 示例宿主：

```sh
JEV_MONITOR_HOME=.runtime/demo python python/examples/fake_host.py
```

- macOS / Linux 上 Python 可能叫 `python3`。Windows PowerShell 先执行 `$env:JEV_MONITOR_HOME = ".runtime\demo"`，再运行同一条 `python` 命令（这一步没有在 Windows 上执行过）。
- 相对路径能对上，是因为两边都从仓库根目录解析。
- 它依次发四个模拟运行：正常完成、规则覆盖、失败后重试、验证失败。每个运行打印一行 `<名字>: sent=N dropped=0 offline=False`。
- 窗口如果停在之前选中的运行上，在展开视图里切换运行。

对一个已经在运行的监视器，只播放一遍 7 个场景、不等待间隔：

```sh
pnpm demo:host --home <数据目录的绝对路径> --fast --once
```

它读 `<数据目录>/session.json`，20 秒内等不到接收端就退出。

接自己的宿主时，可以让它连 `pnpm demo` 的 `.runtime/demo`，或者 `pnpm start` 的 `.runtime/dev`。

## 9. 接入后自查

- 监视器关着时运行宿主：任务照常完成，`stats()['offline']` 为 True。
- 监视器开着时：`stats()` 里 `rejected` 和 `conflicts` 都是 0。
- 界面上模型选择、应用选择、执行、验证分开显示。只有选择时不显示已执行；完成但没验证时显示「已执行待验证」。
- 导出一份 JSONL，确认里面没有 token、密码、原始输入。

## 10. 本文示例怎样核对过

2026-09-30，macOS 27（arm64），Node 22.23.2，Python 3.13.13，以及 uv 提供的 Python 3.9.6。用仓库里的 `EventStore` + `startServer` 起接收端（没有启动 Electron），`JEV_MONITOR_HOME` 指向工作树里的临时目录：

- 第 2 节的完整示例，3.13 与 3.9 各一次：10 条全部 `sent`，run 为 `completed`，尝试为 `passed`。
- 第 3 节的片段放进同一个 run，3.13 与 3.9 各一次：22 条全部 `sent`。判断 3 个 `selected`、1 个 `failed`；尝试 `act-stop` 为 `selected`，`act-2` 为 `unknown`，`act-3/try-1` 为 `failed`，`act-3/try-2` 为 `unverified`；`anomalies` 为 0。
- 第 5 节的 Node 示例：三条都是 200 `accepted:true`。curl 覆盖了表里的 200（新事件与重复）、409、两种 400、401、403、404、413（带与不带 `Content-Length`）、415。把当前段文件设为只读得到 503，恢复后同一个 `event_id` 被接受。正文发一半不再发，约 10.7 秒后得到 408。不带 `Bearer ` 前缀的 token 通过了健康检查；小写 `bearer` 得到 401。这两条是修复前的结果：之后接收端改为必须带 `Bearer ` 前缀，并把 Node 的超时检查间隔改为 0.5 秒（见 `docs/PROTOCOL.md`「更正（2026-09-30）」），`tests/core.test.ts` 覆盖了这两处。
- 停掉接收端，再用同一目录重启（新端口、新 token）：发送器（`queue_size=5`）离线期间丢了 19 条，恢复后先发 `telemetry.dropped` `count=19`，其余 34 条全部写入，run 的 `dropped` 为 19。
- 第 4 节的脱敏（全用假值）：候选名 `password` 和 `sk-…` 原样保留，值被替换；`ghp_…` 没有被替换；`diagnostic` 被删掉。
- 没有接收端时：`queue_size=3` 下 5 次调用返回 True、True、True、False、False，共约 0.3 ms；`close(timeout=0.3)` 用了约 310 ms，之后 `dropped` 仍为 2。这是修复前的结果：之后 `close` 改为把队列里剩下的 3 条计入 `dropped`，同样条件下为 5（`test_close_timeout_counts_unsent_events_as_dropped`）。
- `python/examples/fake_host.py` 与 `pnpm demo:host --fast --once` 对同一个接收端：4 个与 7 个模拟运行的最终状态与预期一致。

没有在 Windows 或 Linux 上跑这些示例，也没有经过 Electron 窗口。

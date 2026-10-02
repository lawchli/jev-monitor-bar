# 2026-10-03 独立交付验收

- 验收者：codex 独立 QA agent，未参与本轮应用实现；模型系列未由本 agent 的执行上下文可靠提供，记为 unknown。
- 工作区：`/tmp/jev-monitor-bar-completion-20261003`，基线 `7aa03ddde526423a5451fe34aa3879affd384915` 加未提交集成改动。
- 实际环境：Linux x86_64，内核 6.12.94+，Node v22.23.2，Python 3.13.5 与 Python 3.9.25。
- 范围：Python 无 socket 回归、独立数值/路径组合检查、桌面协议与打包纯函数、恢复通知链路、现有 Linux 包静态快照。源码只读，没有 build/package、commit/push、依赖安装或真实凭证读取。

阶段结论：本 agent 实跑的 Python 子集与 Node 定向测试均通过，未发现新的代码阻断项。当前 Linux 包仅是界面新增需求合入之前的中间快照，不是最终交付物；最终包与最终源码的一致性核对待重新打包后追加。没有把静态结构检查写成 GUI、ASAR 运行时完整性、Windows 或 Defender 验收。

## Python：两个真实版本的可执行子集

先分别运行 `python3 --version`、`python3.9 --version`，得到 3.13.5 与 3.9.25。两个解释器均直接运行以下真实 unittest 选择，没有替换仓库用例实现：

```bash
PYTHONPATH=python:python/tests python3 -m unittest -v \
  test_paths \
  test_sender.SenderTest.test_emit_without_receiver_stays_under_100ms \
  test_sender.SenderTest.test_queue_overflow_counts_dropped \
  test_sender.SenderTest.test_loopback_origin_rejects_non_local_urls \
  test_sender.SenderTest.test_non_positive_limits_raise \
  test_sender.SenderTest.test_nonfinite_time_parameters_raise_before_starting_worker \
  test_sender.SenderTest.test_close_timeout_counts_unsent_events_as_dropped \
  test_sender.SenderTest.test_snapshot_rejects_events_over_64kib \
  test_sender.SenderTest.test_invalid_emit_returns_false_without_raising \
  test_sender.SenderTest.test_fork_preserves_disabled_and_closed_state \
  test_sender.SenderTest.test_disabled_sender_is_noop
```

第二次仅将 `python3` 替换为 `python3.9`。

| 实际解释器 | 仓库测试 | 时长 | 跳过 |
| --- | ---: | ---: | ---: |
| Python 3.13.5 | 13/13 通过 | 1.561 秒 | 0 |
| Python 3.9.25 | 13/13 通过 | 1.548 秒 | 0 |

其中包括三项共享路径测试；Windows/macOS 路径参数在 Linux 上模拟，不代表对应操作系统实测。`test_fork_preserves_disabled_and_closed_state` 在两个解释器上都实际调用 Linux `os.fork`，分别验证 disabled 与已关闭 sender 在继承锁后不死锁、不启动 worker，并保留统计口径；没有因平台 skip 绕过 fork。

另用 `PYTHONPATH=python <解释器> -c <临时 DeliveryChecks unittest>` 各执行三项独立生产函数检查：3.13.5 为 3/3、0.454 秒；3.9.25 为 3/3、0.424 秒，均无跳过。

1. 真实 offline sender 拒绝四类非有限 payload：NaN 值、嵌套正无穷、列表内负无穷及 NaN 字典键。仅增加四次 dropped，`_sequence=0`、`_unreported=0`，worker 仍存活；随后有效事件入队并从 sequence 1 开始，关闭后未送达的那一条计入 dropped。
2. 两个时间参数 × 十个无效值 × 两种 enabled 状态，共 40 组拒绝组合：NaN、±Inf、`10 ** 1000`、True、False、0、-1、字符串和 None。全部在构造时抛出 ValueError，线程工厂未调用，弱引用 sender 注册集合长度不变。
3. 在自己的临时目录中真实删除 cwd，确认 `os.getcwd()` 抛 FileNotFoundError；相对 HOME 加含 `..` 的绝对 SESSION 可以独立规范化，显式 `session_file` 优先；两个覆盖都为相对路径时仍能构造 offline sender，入队后关闭正确计入丢弃。

独立探针首轮错误地断言 `close(timeout)` 返回时 worker 必须立即退出，两个版本分别出现两次/一次该断言失败。检查实现后明确：超时返回前发出 stop，线程停止存在调度间隔；探针改为最多等待一秒 join 后核对退出，结果如上。未修改生产代码、仓库测试或 timeout；首轮失败不写成通过，也不把这个探针自身错误列为产品缺陷。

### 未执行的 Python 范围

本轮沙箱真实拒绝 `socket.socket()`，最小 loopback 诊断得到 `PermissionError: [Errno 1] Operation not permitted`，尚未进入 bind/listen。因而本 agent 没有执行完整 29 项 suite 中另外 16 项需要真实 HTTP/socket 的用例；这 16 项不是通过或 unittest skip。

尤其 `test_nonfinite_numbers_are_rejected_before_enqueueing`、两个 deleted-cwd HTTP 用例和 `test_forked_child_is_a_new_producer` 原仓库测试未在本轮独立执行。上述临时检查只证明编码/序号/路径/offline 行为，不证明 HTTP 送达、父子队列分别发送或重定向拒绝。前轮完整 29/29 与独立网络/fork 复核属于 [前轮 Python 报告](2026-10-02-audit-python-recheck.md) 和实施方证据，不冒充本 agent 本轮执行；最终完整 suite 仍由集成方/CI复验。

## Node：真实子测试计数

逐文件用 `node --import tsx tests/<文件>.test.ts` 直接执行，合计 39/39 通过、0 失败、0 跳过。没有使用会触发 IPC listen 的 tsx CLI；也没有把 `node --import tsx --test` 的文件级计数当作真实子测试数。

| 测试文件 | 通过 | 主要验收 |
| --- | ---: | --- |
| `deps` | 1 | 已安装运行时依赖及传递依赖无 native addon/install scripts |
| `boundaries` | 1 | 项目源码运行时禁区与平台隔离守卫 |
| `package-config` | 12 | 全量 fuse、ASAR 条目、版本、资源、签名计划与 SHA 规则 |
| `runtime-integrity` | 2 | 合法注释篡改与排除无关崩溃/语法错误的假阳性 |
| `renderer-protocol` | 6 | `app://renderer` 来源/资产白名单、方法、读取错误、真实 symlink 越界与 CSP |
| `store-changes` | 5 | recovered 单独通知、与新事件合批、当前 cursor、解除订阅、真实 store 锁解除后 duplicate/conflict 仍通知 |
| `smoke-lib` | 12 | smoke 参数、延迟统计、窗口辅助断言与 renderer URL 契约 |

## S5 恢复通知源码与生产链路

当前 `src/store.ts` 在补回段事件或元数据改变时发出独立 `recovered`，不冒充新确认事件。`src/main/store-changes.ts` 同时订阅 event/recovered，在同一 50ms 批次中去重 runIds，并在发送时读取 `store.cursor`；`src/main/index.ts` 已接入该订阅并向 `IPC.changed` 发送，退出解除订阅。

定向测试实际覆盖：启动段读锁导致空 snapshot，解除锁后重试既有事件得到 accepted:false；相同 sequence 新 event_id 得到 conflict；两者均补回一条原事件、导出仍仅一行，并收到含正确 runId/current cursor 的 UI 变更。这里只执行到主进程通知回调，不声称本轮 Electron 实际画面已刷新。

## Linux 包：中间快照静态检查，不是最终包

执行 `node scripts/verify-package.mjs --platform linux --arch x64` 返回 0：9 fuses 一致、ASAR 8 条目、bundle 只需 electron/Node built-ins、目录与 zip 的 77 条目含权限/symlink 一致、SHA256SUMS 一致。

独立直接读取 ASAR 与可执行文件也确认：

- 8 条目包含两个目录及六个文件：`package.json`、`dist/main.cjs`、`dist/preload.cjs`、renderer 的 `index.html/app.js/app.css`，没有 source map、node_modules、`.node` 或外部运行时依赖。
- 包内 package.json 无 dependencies/scripts，仅保留运行所需字段，入口为 `dist/main.cjs`。
- 9 个 fuse 实际值与配置一致；RunAsNode、NODE_OPTIONS、inspect、file extra privileges 为 false；OnlyLoadAppFromAsar 和 embedded integrity 为 true。静态 fuse 位不代表运行时验证已经通过。
- main bundle 包含 recovered 发出、recovered 订阅和 subscribeStoreChanges 接入；该快照 main 与当时 dist/main.cjs 字节相同。
- 对包内实际 main 用 harmlessMainTamper 得到 offset 272018、ASCII `s`→`S`；独立 TypeScript AST leading-comment 检查确认该偏移确在注释内，不仅凭 helper 自己的正则判断。

该**中间快照** zip SHA-256 为 `86ab6b967d91b9cf7ab6b97453034e6f887c64bd6580ec19d88296155afaebb7`；main SHA-256 为 `25d8646920d6ef45273171411cea773ea4377b17fc8d4b93d407796e5dcf8ff2`。用户新增 UI polish/时间线搜索后将重新构建；这两个值不得作为最终交付物的验收值。

最终包验收待集成方通知稳定后追加，包括 ASAR 各文件与最终 dist 一致、最终 zip/SHA 清单、变更后的 renderer 内容。此处没有实际启动 package:runtime/GUI。Linux 的 ASAR embedded integrity 运行时不在 Electron 支持范围内，不能把跳过记作通过。

## 交付边界

已阅读总需求、完整实施/AUDIT 历史、前轮独立审计与负载报告，并核对 README 与现有 CI。无额外组件、用户权限、只读/loopback 是产品要求；纯 JS 依赖、精简 ASAR、ASAR/fuse 静态结构符合当前检查，不等于在未安装 Node/Python 的干净 Windows 10/11 上运行已验。

没有执行 Windows/macOS 新版本窗口、启动不抢焦点、多显示器/混合 DPI、整屏叠放截图、SmartScreen/签名、Defender 扫描或干净机器解压启动。没有认证外部 GitHub CI 状态；CI 配置覆盖三平台不等于本轮 CI 已完成。前轮 Windows 11 与 macOS 实机记录继续保留为历史证据，不自动覆盖本轮改动。

## 最终 Linux 包独立复核（2026-10-03 追加）

- 本次复核署名补充：harness 为 codex，model 为 gpt-sol，按用户指定的 GPT-6.1 Sol / reasoning xhigh 执行配置记录；前节 unknown 是当时上下文的记录，保留不改写。
- 集成方确认 UI/业务源码冻结并重新打包后，本 agent 只读核验最终包，没有 build/package 或 GUI 启动；上文“待最终包”的静态检查现由本节完成，中间快照原文与 SHA 继续保留。

实际执行 `node scripts/verify-package.mjs --platform linux --arch x64`，退出码 0：9 个 fuse 实际值一致、ASAR 8 条目、bundle 仅 require electron/Node built-ins、zip 与目录的 77 条目（含权限和 symlink）一致、SHA256SUMS 清单一致。另执行系统 `sha256sum` 独立重算，最终 zip 得到：

```text
2543985c6a6e3688b35d2278540486f3418b9690a829209240bc16aa50a56c1c  jev-monitor-bar-0.1.0-linux-x64.zip
```

独立 Node 读取 ASAR 后，五个 dist 文件逐一用 Buffer 字节比较当前最终 dist；最小 package.json 按根 package.json 的 name/version/description/main、固定 productName 和 private 字段单独构造预期并 deepEqual。六个文件全部一致：

| ASAR 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `package.json` | 213 | `007357f11e74acafac18a149f889735decb069ea560ac61240efd006836676e3` |
| `dist/main.cjs` | 349170 | `25d8646920d6ef45273171411cea773ea4377b17fc8d4b93d407796e5dcf8ff2` |
| `dist/preload.cjs` | 1266 | `4bb1126b4c0bac2e234af89af139ac076ba34c054b3e2d05aa44a6ac1a390b66` |
| `dist/renderer/index.html` | 523 | `e04a49f813a0c3f729162c74d217a365b2d3dec15982d38d56b5ec4e251c2306` |
| `dist/renderer/app.js` | 804201 | `05fa66049dcb3d1db8f9b60d3d7f3cd7ddb8110885ca7ce935c7451e6fdb2df0` |
| `dist/renderer/app.css` | 13400 | `287ba5e1f9e0193dd3fb1ceee12e3086a04af3ccb11e9e5ab78b26645a5ca7bf` |

8 条目为上述六文件加 `dist`、`dist/renderer` 两个目录。最终包没有 source map、node_modules、`.node`、外部运行时依赖目录；包内最小 package.json 不含 dependencies 或 scripts，根目录新增 `stress:store` 开发脚本没有入包。

### 最终 bundle 中的功能证据

生产函数和字符串来自最终 ASAR 内实际 bundle，而非只查未打包源码：

- main 仍有 `this.emit("recovered", ...)`、`store.on("recovered", ...)`、main 对 subscribeStoreChanges 的接入；渲染来源由 scheme `app`、host `renderer` 与 `/index.html` 组合为 `app://renderer/index.html`。
- renderer 包含 searchTimelineItems、NFKC/小写规范化、literal terms AND 匹配；时间线搜索 input、搜索边界“仅搜索已加载的…脱敏事件”、没有匹配项提示均在 bundle 中。用 TypeScript AST 解码字符串字面量核验中文内容，没有把 esbuild 的 Unicode escape 误认为缺失。
- renderer 含决策/执行空状态、新 compact `data-empty`、共享 ViewTabs、tablist/tab/aria-selected 及 ArrowLeft/ArrowRight/Home/End 键盘导航；最终 CSS 含搜索控件与 `:focus-visible` 样式。
- 最终可执行文件的九个 fuse 再次直接读回并与全量 FUSE_SETTINGS deepEqual，关闭 file extra privileges 的位确为 false。静态位检查仍不代替真实启动。
- 对最终包的 main 再次执行 harmlessMainTamper，offset 272018、`s`→`S`；独立 AST 确认落在真实注释内。`integrityRejected` 对普通 SyntaxError 返回 false，`supportsAsarIntegrity('linux')` 返回 false。没有篡改磁盘上的交付包，也没有把这项方法检查称为运行时拒绝已验证。

### 新增 UI 回归的独立执行

最终源码上直接执行以下两个文件，9/9 通过、无跳过：

```bash
node --import tsx tests/timeline-search.test.ts
node --import tsx tests/timeline-search-ui.test.ts
```

纯搜索 4 项覆盖 AND/大小写/全角归一化、中文/ID/日期/嵌套值、literal 非正则、已脱敏输入、不修改事件与空搜索顺序。jsdom 组件 5 项覆盖搜索与错误筛选组合、Ctrl/Cmd+F/Escape、零匹配仍可加载更早且隔离其他 run、分页失败可重试、最多渲染 500 行、切 run 清空搜索及页签键盘环绕/焦点。这是 DOM 行为测试，不是实际 Electron 窗口或系统级快捷键验收。

另外重新直接执行 runtime-integrity（2）、renderer-protocol（6）、deps（1）、boundaries（1），10/10 通过、无跳过；这是前节已有用例的重跑，不额外计成十个新独立用例。

### 本轮 CI 与实机限制的更正补充

集成方实际报告：GitHub connector 读取可用，但 create_branch 返回 `requires approval`，而当前 approval policy 为 never；Git transport 又受 DNS 限制。没有通过等价写动作绕过权限，不能 push、创建本轮 PR/启动 CI。本 agent 没有重复外部写入，也没有亲自执行该 connector；此处明确归因于集成方实际错误反馈。没有本轮三平台 CI 绿灯结论，静态工作流配置与历史 CI 成功不替代本轮 CI。

本 agent 的最终结论：最终 Linux 包的来源一致性、精简打包、九个 fuse、六个 ASAR 文件、zip/SHA 与新增 UI 定向回归已独立复核通过；未发现本次交付静态范围内的新阻断项。完整 socket/HTTP suite、真实 GUI/package:runtime、Windows/macOS 新包、Defender、签名与干净 Windows 免组件启动的限制仍按前节保留，不因本节静态通过而解除。

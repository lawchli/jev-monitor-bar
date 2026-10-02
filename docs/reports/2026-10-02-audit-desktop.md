# 桌面、安全协议与聚合性能独立审计（2026-10-02）

- 审计者：codex / gpt-sol（独立只读 audit agent）
- 范围：本轮工作树中的 `src/main/renderer-protocol.ts`、主进程协议注册与 IPC/窗口联动、CSP、打包 fuse 配置、`scripts/verify-runtime.mjs` 与桌面 smoke，以及 `src/state.ts` 的 `bound()` 优化和回放基准统计。
- 方法：阅读 `AGENTS.md`、项目总需求、实施/审计记录与相应 diff；定向测试；独立生产函数差分探针；读取主 agent 产生的 Electron smoke 制品。没有改应用源码/测试，没有 commit/push，没有并行启动 GUI。
- 环境：Linux x64，内核 6.12.94+，Node v22.23.2；共享依赖为 Electron 42.11.6、Playwright 1.63.0。

## 结论（本次初审）

自定义协议的来源边界、静态资源 allowlist、IPC sender/frame/URL 校验和聚合键淘汰行为未发现阻断应用的回归。独立探针验证了新旧聚合结果一致。发现一个中等严重度的运行时验证假阳性：任意翻转主程序中点字节可能只是破坏 JavaScript 语法，却被记作 ASAR 完整性拒绝。该项已立即交给主 agent 修复；修复复核将追加在本文末尾。

Linux 源码版的 `app://` 加载与阻止实际 `file://` 脚本访问已有 smoke 证据；初审时尚未有本轮 release 包，因此没有把该证据扩大为“关闭 file 特权后的 ASAR 发布包已通过”，更没有扩大为 Windows/macOS 本轮实测。

## 问题 AD-01：ASAR 篡改验证可能由 JS 语法错误产生假阳性

- 严重度：中（验证结果正确性）。
- 位置：初审时 `scripts/verify-runtime.mjs:173` 的 `checkAsarTamper()`，字节修改在 179–185 行，通过条件在 193–196 行。
- 触发：把 `dist/main.cjs` 正中间字节 XOR `0x20`，只要求进程退出且没有会话文件，就报告 `tampered app.asar refused`。
- 独立复现：本轮开发构建 `dist/main.cjs` 长 342,500 字节，中点 171,250 的原字节为 `:`（58），修改后为控制字符 26。用 `new vm.Script(changed.toString())` 编译直接得到 `SyntaxError: Invalid or unexpected token`。此错误与 ASAR 完整性功能是否生效无关。
- 影响：即使完整性 fuse 不生效，普通的 JS 解析失败也满足原通过条件。尤其不能以 Linux 上这个结果证明完整性校验；[Electron 官方 fuse 文档](https://www.electronjs.org/docs/latest/tutorial/fuses#embeddedasarintegrityvalidation)将该功能限定为 macOS 与 Windows。
- 阻断范围：阻断“ASAR 完整性运行时已验证”的宣称；不是自定义协议产品修复本身的漏洞。
- 建议：篡改一个合法 JS 注释字符、保留文件长度和应用行为，明确记录平台支持范围，并要求完整性拒绝的具体证据；如果运行时无法证明，就记录未验证/不支持，而非通过。
- 状态：已向主 agent 报告，主 agent 接手修复。

## 已实跑的独立验证

### 生产聚合函数新旧完整状态差分

临时 Node 探针把 `git show HEAD:src/state.ts` 的旧实现通过 esbuild 转译后置于独立 VM，并逐条与当前实现比较完整 `RunState` 的 JSON。不是只比较键数或重用新测试的参考模型。

- 20,000 条固定种子的随机事件。
- 混合数字 ID、普通字符串 ID、`0`、`4294967294`、`4294967295`、`4294967296`、`01`、`-0`、`1e3`、空格开头、`7.0`、`NaN`、`__proto__`、`constructor`、`toString`。
- 包含重复 ID、被淘汰 ID 的再次插入、两个 producer、请求关联冲突，以及决策事件附带动作/尝试关联。
- 在第 350、1,500、7,000 条后通过 `structuredClone` 复制状态，再把表恢复成 null prototype，验证 WeakMap 未携带旧表缓存时的行为。
- 结果：逐条完整状态零差异，末尾 decisions 和 attempts 均恰好 500 键。
- 同一流上建立 `ReplayTimeline` 后做 75 次随机跳转，与 `replaySnapshot` 从头计算逐项 `deepStrictEqual`，全部一致。

### 定向测试

以下文件用 `node --import tsx <测试文件>` 直接执行，34 项全部通过、无跳过：

| 文件 | 通过项数 | 主要覆盖 |
| --- | ---: | --- |
| `tests/renderer-protocol.test.ts` | 6 | 两类路径 API、来源/路径 allowlist、HEAD/405、读错误、实际越界 symlink、CSP |
| `tests/state-bound.test.ts` | 4 | 键顺序/淘汰、复制表、回放检查点、初始超限表 |
| `tests/package-config.test.ts` | 12 | fuse 全量配置/读回、打包资源、ASAR 条目、版本/签名/SHA |
| `tests/smoke-lib.test.ts` | 12 | smoke 参数/断言、延迟统计、窗口检查辅助、渲染 URL 与主进程的一致性 |

`pnpm exec` 在这个 symlink 依赖工作树中触发 pnpm 自动安装并因 no-TTY 拒绝；审计没有批准它重建共享依赖，改用已安装的 Node/tsx 直接执行。因此该工具启动失败不计为产品测试失败，也不计为通过。

### 回放基准实际执行

`node --import tsx scripts/loadtest/replay-bench.mts --synthetic 2 --events 1400 --repeat 2` 正常结束。1400 条有效事件、无无效行/截断；基准内 6 个位置与从头计算的 deepEqual 自检通过。当前 `{runs, evicted}` 检查点统计正常：2 个检查点、2 个 distinct runs、4 张 distinct tables、2,000 个 table slots/entries。该短基准验证脚本适配与结果一致性，不代表长时负载或 Windows 性能验收。

### 主 agent Electron smoke 证据复核

读取 `.runtime/smoke/linux-x64/report.json`（2026-10-02T13:28:03Z 至 13:28:28Z）而未自行抢占 GUI：

- `renderer.origin`：`app://renderer/index.html`，passed。
- `renderer.localFilesBlocked`：对实际新建的本地 `.js` 文件注入 script 得到 error，标记未执行，fetch 为 `rejected: Failed to fetch`，passed。
- renderer 中 `require` 和 `process` 都为 undefined，bridge 存在；主进程报告 sandbox/contextIsolation/webSecurity 开启，nodeIntegration 关闭。
- `N=200`，无丢失标记；POST 到两帧可见 p95 为 82ms，接收到可见 p95 为 80ms。
- 正常闭环、导出/回放、回放期间继续接收等检查通过。

这份报告的 mode 为 build，并非 release 包。上述“已通过”仅指这份 Linux 源码构建报告中的断言。

## 审计判断与边界

1. `resolveRendererFile()` 只接受 `app://renderer`，拒绝凭证/端口/其他 origin；最终 pathname 必须是 5 个静态 renderer 资源之一。WHATWG URL 即使规范化 `..`，最终仍只能指向允许资源，不能变成 `main.cjs`、preload 或任意本地文件。
2. 磁盘 reader 同时 realpath 根与目标并验证相对路径，已实测允许文件的外部 symlink 返回空 404。与读取之间仍存在本机文件被并发替换的窗口，但这需要对应用文件本身的修改权限；未发现来自事件/renderer URL 的路径突破。
3. 404/405 不返回文件系统错误，MIME 和 `nosniff` 显式设置；协议只给 standard/secure，没有 CSP bypass 或 fetch/service worker 额外权限。CSP 的 script/style self 此后受 `app://renderer` origin 限制。
4. 主进程在 ready 前注册 scheme privileges，在创建/加载窗口前装 handler 和 IPC。IPC 同时校验既定 webContents、mainFrame 身份以及完整 renderer URL；导航/新窗口/权限仍拒绝。
5. `GrantFileProtocolExtraPrivileges` 配置变为 false，打包和静态核对都读取同一 `FUSE_SETTINGS`。关闭后从 ASAR 读取 renderer 的实际发布包验证须由对应主机执行；官方说明 [Electron 的 Node fs 会虚拟化 ASAR 内文件](https://www.electronjs.org/docs/latest/tutorial/asar-archives#node-api)，这不能替代本轮实际运行。
6. `bound()` 的新增计数与数值最小堆保留 Object.keys 的顺序语义。表被检查点复制后首次重新数键，shareEntries 仅改变条目引用不改键，未见缓存与检查点共享之间的失配；隐藏元数据用 WeakMap，不出 IPC。
7. 没有运行本轮 Windows/macOS GUI、Windows Defender、代码签名、干净 Windows 解压启动、混合 DPI 或 30 分钟负载。已有历史验证仍是历史结果，不能自动覆盖本轮变更。

## 后续复核：AD-01 已修复，运行时证据仍待本轮发布包产生

主 agent 新增 `scripts/runtime-integrity.mjs`、`tests/runtime-integrity.test.ts`，并修改 `scripts/verify-runtime.mjs`。独立复核通过：

- `harmlessMainTamper()` 在修改前后均用 `vm.Script` 编译，只切换 esbuild source comment 内一个 ASCII 字母大小写，不再改任意中点字节。
- 对当前真实 `dist/main.cjs` 独立执行 helper，修改位置为 272,426，字符 `s` → `S`；原文件仍为 342,500 字节，前后恰好 1 个字节不同。用 TypeScript 完整 JS parser 解析原 bundle，并通过 AST 节点的 leading comment ranges 独立确认该位置确实位于 `// src/main/index.ts` 单行注释内；不是以正则结果自证为注释。
- `integrityRejected()` 同时要求已退出、接收端未启动、出现明确 integrity failure/mismatch/invalid/ValidateIntegrityOrDie 日志。独立传入 syntax error、permissions failure、missing main、普通 startup failed 四种输出，全部不能报通过。
- `supportsAsarIntegrity('linux')` 为 false，Linux 分支明确跳过篡改测试；report 的 skip 是 `ok:null, skipped:true`，汇总只将 `ok:true` 计为通过，将 `ok:false` 计为失败，显示通过与跳过数量。
- 新的 runtime-integrity 两项测试直接执行通过。至此本审计定向测试共 36 项通过。

AD-01 的原始验证假阳性已经消除，当前没有未解决的代码审计阻断项。这里验证的是测试方法与代码正确性；**没有在本审计中执行本轮 release 包**。真实 ASAR renderer 加载、file fuse 行为与 Windows/macOS 完整性拒绝，仍须由主 agent 按相应平台实跑并登记。本文不把尚未执行的 runtime 结果写成已通过。

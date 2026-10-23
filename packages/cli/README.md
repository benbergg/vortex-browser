# @vortex-browser/cli

Vortex 命令行客户端 — 在终端直接调浏览器自动化能力，免写代码。底层走本地 `vortex-server` 的 HTTP API。

调试 vortex 时最方便的工具：单条 action 立刻反馈，省去搭 MCP 客户端。

## 安装

```bash
npm i -g @vortex-browser/cli
# 同时需要 vortex-server 在本地运行（默认 6800）
```

## 用法

```bash
vortex <module> <command> [options]
```

```bash
# 开新页面
vortex tab create --url https://example.com --active

# 截屏存盘
vortex capture screenshot --full-page --out shot.png

# 取标题 / DOM
vortex page info
vortex content getText --selector "h1"

# 跑 JS
vortex js evaluate --code "document.title"

# 抓 console / network
vortex console getErrors
vortex network filter --status-min 400
```

`vortex --help` 看全部模块；`vortex <module> --help` 看子命令。

## 模块

| 模块 | 子命令 |
|------|--------|
| `tab` | list / create / close / activate / getInfo |
| `page` | navigate / reload / back / forward / wait / info / waitForNetworkIdle |
| `dom` | query / queryAll / click / fill / type / select / scroll / hover / getAttribute / waitForMutation |
| `content` | getText / getHTML / getElementText / getAccessibilityTree / getComputedStyle |
| `js` | evaluate / evaluateAsync / callFunction |
| `keyboard` | press / shortcut |
| `mouse` | click / doubleClick / move |
| `capture` | screenshot / element / gifStart / gifFrame / gifStop |
| `console` | getLogs / getErrors / clear / subscribe |
| `network` | getLogs / getErrors / filter / getResponseBody / clear |
| `storage` | get/set/delete cookies + local/session storage + export/import |
| `file` | upload / download / getDownloads |
| `frames` | list / find |
| `shortcuts` | 常用组合：`vortex shortcuts copy-page-text` 等 |
| `raw` | `vortex raw <action> --params '{"k":"v"}'` 直接发任意 action |
| `observe` | 抓一份可访问性快照并列出元素 ref（一等命令） |
| `act` | 对元素执行 click / fill / type / select / scroll / hover（一等命令） |
| `sequence` | 一次跑多步，每步自证（一等命令） |

## observe / act / sequence

这三个是给人直接用的「一等命令」：默认输出**人看的几行**，`--json` 回到原始 JSON
（其余模块命令的默认 NDJSON 不变）。

```bash
# 快照：stdout 是可读摘要，ref 列表走 stderr（[refs] 行不污染 stdout）
vortex observe
vortex observe --json | jq '.result.elements'

# 动作：target 吃 observe 给的 @ref，也吃裸 CSS selector
vortex act --action click --target @e12

# 「点了没有」不能只看 success：开副作用信号采集，输出里逐项列出来
vortex act --action click --target @e12 --observe-effect
# click @e12 → success
# effect: domMutations=2 networkRequests=1 urlChanged=false focusChanged=true ariaChanged=false userFeedback=toast

# 多步序列：每步自证，click 自动开副作用信号采集
vortex sequence --steps '[{"action":"click","target":"@e12"},{"action":"fill","target":"@e13","value":"hi"}]'
# sequence 2 steps
#  1. click  @e12 → executed_verified | effect: confirmed
#  2. fill   @e13 → executed_verified | effect: confirmed
# summary: total=2 verified=2 unverified=0 failed=0 not_executed=0

# 默认失败即停（只有验证通过才继续）；--on-failure continue 可让失败后继续
vortex sequence --on-failure continue --steps '[...]'
```

`@ref` 来自最近一次 `vortex observe`，**与 tab 绑定**：换了 tab 就要重新 observe。

**tab 身份怎么算**（`@ref` 的校验口径）：快照按**解析后的实际 tab**登记与校验 ——
不是按「有没有传 `--tab`」。

- `observe --tab 5` ⇒ 快照属于 tab 5；
- `observe`（没传 `--tab`）⇒ **请求发出前**先解析出目标 tab（该 session 当时的当前 tab），
  请求带这个显式 `tabId` 发出、快照也登记到这个 tab：请求与登记同源，
  期间同 session 切了 current tab，快照也不会被登记到别的 tab 上；
- `act --tab 5`（与 observe 同一个 tab）⇒ 放行；
- `act`（没传 `--tab`）但当前 tab 已经换人 ⇒ 报错并提示「先对该 tab 重新 observe」，
  **不会**沿用旧 tab 的快照（旧 snapshotId 会被扩展按 `boundTabId` 打在旧 tab 上）；
- 实际 tab 判不出来时**先报错**（连 observe 请求都不发），也不沿用可能属于别的 tab 的快照。

**哪些动作参与自证**：`click`（副作用信号）、`fill`/`type`/`select`（值回读）、
`scroll`（moved 标志）有自证通道。`hover` **没有**：扩展侧 `dom.hover` 既不消费
`observeEffect`、结果里也没有 `effect`，「悬停有没有生效」无从判定。这类步
**不参与自证判定**（报告里标 `verification: not_applicable`）—— 既不是「判定失败」，
也不会让序列停下；但 hover 动作本身真失败时仍然算 `failed`。

`sequence` 的每步判定口径与 MCP 的 `vortex_sequence` 同源（`@vortex-browser/shared` 的
`sequence.ts`），两条路给出的 verified / unverified 结论一致。

## 通用选项

| 选项 | 默认 | 说明 |
|------|------|------|
| `--port <n>` | `6800` | vortex-server 端口（或 `VORTEX_PORT` env） |
| `--tab-id <n>` | active tab | 跨 tab 操作时指定 |
| `--json` | — | 部分命令支持机读 JSON 输出 |

## 退出码

- `0`：成功
- `1`：vortex action 失败（参数缺失 / 元素未找到 / 超时等）
- `2`：连接 vortex-server 失败（server 未启动）

`vortex sequence` 的报告里出现 `failed` 步 ⇒ 退出码 `1`（报告照常完整打印到 stdout，
退出码只是把「命令失败」告诉调用脚本）。

## 调试

加 `DEBUG=vortex:*` 可看出请求/响应：

```bash
DEBUG=vortex:* vortex page info
```

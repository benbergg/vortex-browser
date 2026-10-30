# vortex 使用遥测（usage log）

MCP server 自己落的调用流水，一行一次调用，JSONL。

## 为什么有它

诊断 vortex 的问题，过去只能反解各家 agent 的 transcript —— Claude Code / Pi / Codex
三种记录形态各不相同，脚本要跟着每家格式改；而且 transcript 里只有**客户端看到的东西**：
服务端真实耗时、哪一层超时、页面侧到底发生了什么，取不到。

本 sink 补的是**服务端真相**。它**不是** transcript 的替代品：客户端侧的 schema 校验
拒绝发生在请求到达服务端之前（例：`Failed to call tool: data/tabId must be number`），
服务端无从知晓，那一类仍要靠 transcript。

## 怎么开

默认**关**（写用户磁盘的默认行为不该由装包替用户决定）。给 MCP server 进程加环境变量：

```bash
VORTEX_USAGE_LOG=1
```

关：`VORTEX_USAGE_LOG=0`（或 `off` / `false` / 不设置）。

## 落哪、留多久

- 路径：`~/.vortex/logs/mcp-YYYY-MM-DD.jsonl`（按日切分）
- 保留期：14 天，启动后首次落盘时清理更早的文件

## 一行里有什么

```json
{"ts":"2026-10-30T10:00:00.000Z","tool":"vortex_evaluate","outcome":"error","errorCode":"TIMEOUT","durationMs":30000,"argLen":60,"resultLen":120,"client":"claude-code@1.0.0","pid":1234}
```

| 字段 | 含义 |
|---|---|
| `ts` | 服务端处理开始时间（ISO） |
| `tool` | 工具名（**只保留已注册的工具名**，未注册的记 `<unknown-tool>`） |
| `outcome` | `ok` / `error` |
| `errorCode` | vortex 错误码（**只保留白名单内的值**，其余记 `UNKNOWN`）；成功为 `null`；抛异常的调用记 `UNHANDLED` |
| `durationMs` | 服务端处理耗时（含 hub 往返） |
| `argLen` / `resultLen` | 入参 / 返回的**长度**（只记长度） |
| `client` | 客户端标识（name@version）；**只保留严格形态** `[A-Za-z0-9._@-]{1,64}`，否则记 `unknown` |
| `pid` | MCP server 进程号 |

## 边界

- **不写内容**：不写页面文本、用户输入、URL、错误原文、选择器。只写长度与错误码。
  错误原文可能含用户代码或选择器，落盘即泄露。
- **外部可控字段一律收敛**：`tool` / `errorCode` / `client` 都来自外部（请求里的工具名、
  错误文本里的大写词、握手时客户端自报的 name/version），直接落盘会把 URL 或敏感标识
  写进本机日志。故三者分别只保留「已注册工具名」「已知错误码」「严格形态标识」，
  其余归固定标识（`<unknown-tool>` / `UNKNOWN` / `unknown`）。
- **异步落盘**：写盘与保留期清理都在后台完成，工具响应不等待落盘 —— 文件系统延迟不进
  响应路径。
- **写盘失败不影响调用**：磁盘满 / 权限 / 并发写失败时静默降级并计数，连续失败 3 次后
  本进程不再尝试；工具调用结果不受影响。
- **不保证崩溃场景下每次调用恰好一行**：正常 / 错误 / 超时路径都有可解析的行
  （行数 ≤ 调用数）；**抛异常的调用记一行 UNHANDLED 后原样抛出**；进程崩溃时无法保证。
- **CLI 不经过 MCP server**：`packages/cli` 直连 hub，CLI 的调用不在这个 sink 里。
- **与 transcript 是互补，不是替代**：客户端侧的 schema 校验拒绝发生在请求到达服务端之前，
  这个 sink 看不到；反过来 sink 能给出 transcript 里没有的服务端耗时与错误码。
  采集时**不要把两者相加**（同一次调用会双计）：`collect.mjs --sources` 默认不含 sink，
  需要服务端口径时单独用 `--sources sink` 采集。

## 怎么读

仓库内的抽取器已支持这个源：

```bash
node scripts/usage-baseline/collect.mjs --label week --days 7 --sources sink
```

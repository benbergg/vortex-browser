# 模型自选浏览器 + 自动拉起 真机验收（2026-08-09）

环境：macOS，Chrome 与 Edge 均已注册 native messaging host（同一 dist、固定扩展 ID `fbonhj…`）。MCP 走真实 stdio 协议（独立 client 进程，非 Claude Code 会话内连接）。

对应设计/计划：知识库 `12-Projects/N0016-vortex多客户端多浏览器/20260809-*-v3-{设计,计划}文档.md`。

## 1. service worker 冷启动延迟（设计假设被推翻）

设计文档原假设：扩展没有 `chrome.runtime.onStartup`，靠 `chrome.alarms` 的 24 秒 keepalive 唤醒，"拉起后可能等半分钟才连上 hub"。

实测（Edge，完全退出后 `open -a` 到 `/health` 出现该 label）：

```
第 1 次  5.58s
第 2 次  4.67s
第 3 次  3.96s
```

**稳定在 4–6 秒**，30 秒超时预算有 5–7 倍余量。原假设过于悲观，无需为此加长超时或改唤醒机制。

## 2. 端到端自动拉起（核心验收）

起点：hub 未运行、目标浏览器未运行。一次普通工具调用触发全链路。

```
起点 — Edge:0 hub:0
VORTEX_BROWSER=edge → vortex_tab_list()  4215ms  isError=false
  [{ "title": "新建标签页", "browserLabel": "Microsoft Edge" }]
结束 — Edge:1 hub:1
```

`ensureHubRunning` 拉起 hub、`open -a` 拉起浏览器、SW 连上、返回真实 tab，全自动，**4.2 秒**。`VORTEX_BROWSER` 正确影响了拉起目标（否则按 `installed[0]` 会选 Chrome）。

## 3. 扩展未连接时的降级

浏览器已装但扩展未加载时（新装机常见状态）：

```
vortex_tab_list()  30046ms  isError=true  → BROWSER_LAUNCHING
```

首次给足 30 秒机会后如实回报，不崩溃、不静默。

### 3.1 修复：每次调用都空等 30 秒

首轮实测同一进程内连续调用：

```
修复前  30055ms → 30058ms → 30015ms   （累计 90 秒）
修复后  30054ms →     7ms →     4ms
```

拉起超时后进入 60 秒冷却，期间探测到浏览器仍立即恢复（`3ed6779`）。

## 4. `vortex_browser` 工具

```
零浏览器      vortex_browser()            29ms  {"current":null,"browsers":[]}
双浏览器      vortex_browser()            34ms  {"current":"Microsoft Edge","browsers":["Google Chrome","Microsoft Edge"]}
切换          vortex_browser(chrome)       2ms  {"current":"Google Chrome","switched":true,"online":true}
切换          vortex_browser(edge)         3ms  {"current":"Microsoft Edge","switched":true,"online":true}
未命中        vortex_browser(safari)       2ms  EXTENSION_NOT_CONNECTED: No browser matching "safari"; online: Google Chrome
空参          vortex_browser("  ")              INVALID_PARAMS: browser is required
```

零浏览器时 `vortex_browser` **不被自动拉起预检挡住** —— 它正是模型判断"一个都没有"的手段。切换耗时 2–3ms，证实 hub 拦截后不发帧给扩展。未命中报错并列出在线浏览器，不降级。

## 5. `tab_list` 的 `otherBrowsers`

```
单浏览器        [ {...} ]                                    # 裸数组，不加噪声
绑 Chrome      { tabs:[...], otherBrowsers:["Microsoft Edge"] }
绑 Edge        { tabs:[...], otherBrowsers:["Google Chrome"] }
```

双向对称，且单浏览器场景形状不变。

## 6. 与 `VORTEX_BROWSER`（v2 能力）叠加

```
VORTEX_BROWSER=edge 启动  → tab_list 落在 Microsoft Edge
运行时 vortex_browser(chrome) → tab_list 落在 Google Chrome
```

环境变量定初值，运行时选择可覆盖，两代能力正确叠加。

## 7. hub 重启后 agent 重连

`POST /hub/shutdown` 后 hub 由 agent 自动 respawn，浏览器 **2 秒内**重新出现在 `/health`。

---

## 未纳入验收的环境问题

本机 Chrome 的 unpacked 扩展**无法跨浏览器重启存活**（3/3 稳定复现），与 vortex 代码无关。根因在 Chrome profile 的 `Default/Secure Preferences`：

- 4 个 unpacked 扩展记录指向已删除目录（`.worktrees/v0.6-pr1`、`.worktrees/v0.6-pr5`、`.openclaw/browser/chrome-extension`、`Downloads/…/chrome-mcp-server-0`）
- 扩展 ID `jkbbajlkdidpelfb` 与 `fbonhjdohmkcejfg` **指向同一个 `packages/extension/dist`**。该目录 manifest 带固定 `key`，真实 ID 恒为 `fbonhj…`，因此加载 `jkbbajlkdidpelfb` 必然 ID 不匹配而失败，同目录的正版记录被牵连清除。

这些失效记录在 `chrome://extensions` 里不显示（加载失败即不列出），无法从 UI 移除。冷启动延迟因此改用 Edge 测量（Edge profile 无 ID 冲突，vortex 记录完好）。

# 多浏览器指定能力真机验收（2026-08-09）

环境：Chrome + Edge 同时加载扩展（同一 dist，固定扩展 ID `fbonhj…`），两者的 native messaging host 均已注册并指向 `packages/server/native-host.sh`。hub 重启后两个 browser-agent 均自动重连。

对应设计/计划：知识库 `12-Projects/N0016-vortex多客户端多浏览器/20260809-*-v2-{设计,计划}文档.md`。

## 1. 浏览器 label 可读

```
GET /health → browsers: [('Microsoft Edge', '1.0.0+msl4gk7c'), ('Google Chrome', '1.0.0+msl4gk7c')]
```

改造前两条记录的 `label` 都是随机 UUID，与 `browserId` 相同。

> 这一项同时验证了 `detectBrowserLabel` 对真实 `navigator.userAgentData.brands` 的过滤：Edge 与 Chrome 的 brands 里都带 `Chromium` 与 `Not…A…Brand` 占位品牌，取到的都是真实品牌名。

## 2. 按浏览器名分流

```
x-vortex-browser: edge   → [('Microsoft Edge', '新建标签页')]                       # edge://newtab
x-vortex-browser: chrome → [('Google Chrome', '商业计划 | Meridian'), ('Google Chrome', '火山引擎 ECS …')]
```

同一个 hub、同一条 `matchBrowser`，两个会话各自落在指定浏览器上，互不干扰。

## 3. 匹配不到时不降级

```
x-vortex-browser: firefox →
  EXTENSION_NOT_CONNECTED
  No browser matching "firefox"; online: Google Chrome, Microsoft Edge
  hint: Ensure the target browser (Chrome / Edge / …) is open with the vortex extension enabled … Set VORTEX_BROWSER to pin a specific browser.
```

没有静默落到任意在线浏览器；错误消息列出此刻真正可用的浏览器，拼错名字能立刻看出来。

## 4. trusted-mode 路由

```
GET /trusted-mode              → 400  browserId 必填，可选: Google Chrome, Microsoft Edge
GET /trusted-mode?browserId=edge → 200 {"trustedMode":false}
```

多浏览器提示从裸 UUID 列表变成可读浏览器名。

## 5. dev/reload-extension 路由

```
POST /dev/reload-extension {"browserId":"edge"} →
  {"ok":true,"triggered":true,"targetStamp":"1.0.0+msl4gk7c"}
```

重载后两个浏览器均在册。`vortex_dev_reload` 走的就是这条路由，多浏览器下不再要求人肉贴 UUID。

## 6. MCP 的 VORTEX_BROWSER env

直接用真实 MCP client（`packages/mcp/dist/src/client.js` 的 `sendRequest`）发真 hello 帧，经真 hub 打到真浏览器：

```
VORTEX_BROWSER=chrome → Google Chrome
VORTEX_BROWSER=edge   → Microsoft Edge
VORTEX_BROWSER=safari → EXTENSION_NOT_CONNECTED
                        No browser matching "safari"; online: Google Chrome, Microsoft Edge
```

对照：不设该 env 的 MCP 会话（本次是 Claude Code 自己的 vortex MCP）被自动分配到了 Microsoft Edge —— 正是本次改造要解决的原始场景（浏览网站在 Chrome，MCP 落在 Edge）。

## 未在真机覆盖的一项

- **偏好指向的浏览器晚于客户端上线**：真机需要反复开关浏览器，本轮未做；由 `packages/hub/tests/browser-pref.test.ts` 的「目标浏览器晚于客户端上线时自动绑上」覆盖。

## 代码层验证（同日）

| 检查 | 结果 |
|------|------|
| `hub tsc --noEmit` | 通过 |
| hub / shared / mcp / extension / server vitest | 179 / 260 / 624 / 1881 / 54 用例全绿 |
| `pnpm build` 全量（含 7 个 page-side bundle） | 通过 |

> 注：除 hub 外各包的 vitest 需要 `--minWorkers=1 --maxWorkers=2`，只传 `--maxWorkers=2` 会因默认 minWorkers 大于它而抛 `RangeError`。这是既有配置问题，与本次改动无关。

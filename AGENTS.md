# vortex 项目规则(opencode)

vortex 是浏览器自动化 MCP 工具(`@vortex-browser/*`)。本文件给在本仓库工作的 opencode agent(含评测用的 M3 子模型)提供项目级工作流知识。

## MCP 架构(评测/联调必读)

opencode 经一个**常驻 supervisor** 连接 vortex MCP(`~/.config/opencode/opencode.json` 的 `mcp.vortex` 指向 `packages/mcp/dist/src/supervisor.js`)。链路:

```
opencode ─stdio─► supervisor(常驻,永不退出)
                    │ spawn + 转发 JSON-RPC
                    ▼
                 MCP child(server.js,可随意重启)
                    ▼  WS → vortex-server → Chrome 扩展 → 页面
```

## 改完 MCP 代码:免重连热重载 ⭐

**改 `packages/mcp/` 下的代码后,只需:**

```bash
pnpm -C packages/mcp build
```

build 完成后约 1–2 秒,**supervisor 会自动检测 dist 变更、排空在飞请求、重启 child、保持与 opencode 的连接不断**。无需任何手动重连——继续调用 vortex 工具即可,新 child 已加载新代码。

- **不要**手动杀进程或重连 MCP。
- **不要**为了"看到新代码"去重启 opencode 会话。
- 多包一起改时,改扩展用 `pnpm -C packages/extension build`(只刷扩展,见下),改 MCP 用 `pnpm -C packages/mcp build`;避免无脑 `pnpm -r build` 顺带触发 MCP child 重启(虽无害)。

**诚实边界**:supervisor 重启时会向客户端发 `notifications/tools/list_changed`。
- **连接存活**(child 重启后通道不断、工具调用继续可用)对任何 MCP 客户端都成立——这是免重连的核心。
- **工具 schema 热刷新**依赖客户端支持 `tools/list_changed`。**handler 逻辑改动**(observe/act 行为等,占评测迭代绝大多数)新 child 立即生效、不受此影响;仅当你改了**工具 schema 形状**(增删参数/改 enum)且发现 opencode 仍用旧 schema 时,才需重启 opencode 会话拿新工具面。

## 改完扩展代码:既有 reload 链路

改 `packages/extension/` 下的代码后:

```bash
pnpm -C packages/extension build
```

vortex-server 会自动 watch 扩展 dist 变更并推 `reload-extension` 控制消息触发 `chrome.runtime.reload()`。需确认新构建生效时,调用 `vortex_dev_reload` 工具(轮询 `buildStamp` 直到变化)。这条链路同样**无需重连**。

## 评测

真站评测经 `scripts/run-opencode-eval.mjs` 包装(注入代理/NO_PROXY/key)。`--selfcheck` 会校验 supervisor.js + server.js 存在、模型可用、端点可达。评测只用 vortex MCP 工具。

## 提交规范

遵循 Conventional Commits(`feat`/`fix`/`docs`/`test`/`refactor`/`chore` …),中文描述,动词开头、结尾无句号,禁止 `Co-Authored-By` 等署名。

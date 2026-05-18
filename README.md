# Vortex

让 LLM 直接驱动你正在用的本地 Chrome — 一套面向 AI Agent 的浏览器自动化协议与工具链。

不是另一个 Playwright（无头、独立浏览器），而是接管**用户已登录的真实浏览器会话**，做 Cookie/插件/历史都在的真实操作，适合：抓登录后才能看到的内容、跑日常 Web 任务、半监督的 RPA。

## 架构

```
LLM (Claude Code / 自写客户端)
    │
    │ MCP / HTTP / WS
    ▼
┌─────────────────────────┐
│  @bytenew/vortex-mcp    │  MCP server（stdio）
│  @bytenew/vortex-cli    │  命令行
└────────────┬────────────┘
             │  ws / http
             ▼
┌─────────────────────────┐
│  @bytenew/vortex-server │  本地桥接
└────────────┬────────────┘
             │  Native Messaging (stdio)
             ▼
┌─────────────────────────┐
│ @bytenew/vortex-extension│ Chrome 扩展（MV3）
└─────────────────────────┘
             │
             ▼
       真实 Chrome 页面
```

## 子项目

| 包 | 作用 | README |
|----|------|--------|
| [`@bytenew/vortex-shared`](packages/shared) | 共享类型 / action 名 / 错误码 | [README](packages/shared/README.md) |
| [`@bytenew/vortex-extension`](packages/extension) | Chrome 扩展（MV3）— 真正执行浏览器操作 | [README](packages/extension/README.md) |
| [`@bytenew/vortex-server`](packages/server) | 本地桥接服务（NM ↔ HTTP/WS） | [README](packages/server/README.md) |
| [`@bytenew/vortex-cli`](packages/cli) | 命令行客户端 — 终端直调 action | [README](packages/cli/README.md) |
| [`@bytenew/vortex-mcp`](packages/mcp) | MCP server — 接 Claude Code 等 LLM 工具 | [README](packages/mcp/README.md) |

完整设计：[`docs/DESIGN.md`](docs/DESIGN.md)（架构图、协议、关键设计决策、安全模型、路线图）。

## 快速上手（接 Claude Code）

```bash
# 1. 装 server
npm i -g @bytenew/vortex-server

# 2. 装扩展（dev 模式）
git clone <this-repo> && cd vortex
pnpm install && pnpm -r build
# Chrome 扩展页 → 加载 packages/extension/dist/

# 3. 装 NM host（让扩展能拉起 server，详见 server README）

# 4. 注册到 Claude Code
claude mcp add vortex --scope user -- npx -y @bytenew/vortex-mcp
```

打开 Claude Code 后让它调 `mcp__vortex__vortex_tab_create`，应能创建一个新标签页。

## 能力一览（**11 个工具**，v0.6 起）

三动词 + 八基础原子：

| 类型 | 工具 |
|------|------|
| 写操作 | `vortex_act`（click / fill / type / select / scroll / hover 合一） |
| 读结构 | `vortex_extract`（HTML / text / 引用 ref 等） |
| 探查 | `vortex_observe`（候选元素 + assigned ref） |
| 导航 | `vortex_navigate` / `vortex_tab_create` / `vortex_tab_close` |
| 截图 / 等待 | `vortex_screenshot` / `vortex_wait_for` |
| 输入 / 调试 / 存储 | `vortex_press` / `vortex_debug_read` / `vortex_storage` |

详见 [`packages/mcp/README.md`](packages/mcp/README.md)。

## v0.5 → v0.6 升级

v0.6 收敛工具面 36 → 11，是一次破坏性变更。

- **迁移指南**：[`docs/v0.5-to-v0.6-migration.md`](docs/v0.5-to-v0.6-migration.md)
- **自动迁移工具**：`npx @bytenew/vortex-migrate ./src`（dry-run 默认，`--write` 应用）
- **暂不迁移**：可继续锁版本到 `@bytenew/vortex-mcp@^0.5`，[`v0.5.x` LTS 维护分支](https://github.com/benbergg/vortex/tree/v0.5.x)在 v0.6.0 起至少维护两个月（仅 critical bug fix）

## 开发

```bash
pnpm install
pnpm -r build              # 全量构建
pnpm --filter <pkg> dev    # 单包 watch
```

每个子包 README 有独立的调试/构建指引。

## License

MIT

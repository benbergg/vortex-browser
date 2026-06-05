# Vortex

> 让你的 AI Agent 驱动你**真实的、已登录的 Chrome**——而非无头克隆。

专为 LLM Agent（MCP / HTTP / WS）打造的浏览器自动化工具。与 Playwright/Puppeteer（无头、隔离浏览器）或 browser-use（自启独立会话）不同，Vortex **直接接管你已登录的 Chrome**——Cookie、扩展、历史记录全部保留。轻松抓取需登录的内容、执行日常 Web 任务、实现半监督 RPA。

[English](README.md) | 简体中文

![demo](docs/assets/demo.gif)

## 为什么选 Vortex（对比同类方案）

| | Vortex | Playwright / Puppeteer | browser-use |
|---|---|---|---|
| 真实已登录会话 | ✅ 你的真实 Chrome | ❌ 全新上下文 | ❌ 独立浏览器 |
| 专为 LLM Agent 设计 | ✅ MCP 原生 | ⚠️ 通用用途 | ✅ |
| Bench 覆盖率 | ✅ 50/50 公开工具 | n/a | n/a |

## 工作原理

Vortex 由**三个组件**组成，但你只需安装其中两个：

```
AI 客户端（Claude Code / Cursor / 任意 MCP 客户端）
    │
    │  MCP stdio（无需安装——npx 按需拉起）
    ▼
@vortex-browser/mcp          ← 由 AI 客户端自动启动
    │
    │  ws://localhost:6800/ws
    ▼
@vortex-browser/server       ← 装在你的机器上；由 Chrome 通过 Native Messaging 自动启动
    │                           你永远不需要手动运行它
    │  Native Messaging（stdio，宿主名：com.vortexbrowser.host）
    ▼
Chrome 扩展（MV3）           ← 装在你的 Chrome 里
    │
    ▼
你真实的、已登录的 Chrome 页面
```

**核心要点：**
- **你只装 2 个东西：** Chrome 扩展 + `@vortex-browser/server`。
- **`@vortex-browser/mcp` 自动安装：** AI 客户端会执行 `npx -y @vortex-browser/mcp` 自动拉起，无需手动安装。
- **服务端自动启动：** 扩展激活时，Chrome 通过 Native Messaging 自动启动 server，你永远不需要手动运行 `vortex-server`。
- **先加载扩展：** `vortex-server install` 已内置钉死的扩展 ID，无需手动复制。

## 快速开始

完整步骤：**[docs/INSTALL.zh-CN.md](docs/INSTALL.zh-CN.md)**

**1. 安装 server**
```bash
npm i -g @vortex-browser/server
```

**2. 构建扩展**
```bash
git clone https://github.com/benbergg/vortex-browser
cd vortex-browser && pnpm install && pnpm -r build
```

**3. 在 Chrome 加载扩展**
- 打开 `chrome://extensions`
- 打开右上角的 **开发者模式** 开关
- 点 **加载已解压的扩展程序** → 选择 `packages/extension/dist/` 文件夹

> 扩展 ID 已钉死，无需复制。

**4. 注册原生宿主**
```bash
vortex-server install
```

**5. 重新加载扩展**，让它连上原生宿主
- 回到 `chrome://extensions`，点 Vortex 卡片上的 **↻ 重新加载** 图标

**6. 接入 AI 客户端**（以 Claude Code 为例）
```bash
claude mcp add vortex --scope user -- npx -y @vortex-browser/mcp
```

### 接入 AI 客户端

**Claude Code**
```bash
claude mcp add vortex --scope user -- npx -y @vortex-browser/mcp
```

**Cursor** — 添加到 `~/.cursor/mcp.json` 或项目的 `.cursor/mcp.json`：
```json
{
  "mcpServers": {
    "vortex": { "command": "npx", "args": ["-y", "@vortex-browser/mcp"] }
  }
}
```

**Claude Desktop / 其他 MCP 客户端** — 在其 MCP 配置中使用相同的 stdio 命令：
```json
{ "command": "npx", "args": ["-y", "@vortex-browser/mcp"] }
```

**其他支持 MCP 的客户端** — 任何支持 MCP stdio 传输协议的客户端均可使用上述命令接入。

> 设置 `VORTEX_PORT=<端口号>` 可修改 server 端口（默认：`6800`）。

---

## 架构图

```
LLM（Claude Code / 自定义客户端）
    │
    │ MCP / HTTP / WS
    ▼
┌─────────────────────────┐
│  @vortex-browser/mcp    │  MCP 服务端（stdio）
│  @vortex-browser/cli    │  CLI 客户端
└────────────┬────────────┘
             │  ws / http
             ▼
┌─────────────────────────┐
│  @vortex-browser/server │  本地桥接服务
└────────────┬────────────┘
             │  Native Messaging（stdio）
             ▼
┌─────────────────────────┐
│ @vortex-browser/extension│ Chrome 扩展（MV3）
└─────────────────────────┘
             │
             ▼
       真实的 Chrome 页面
```

## 软件包

| 包名 | 用途 | 文档 |
|------|------|------|
| [`@vortex-browser/shared`](packages/shared) | 共享类型 / 动作名称 / 错误码 | [README](packages/shared/README.md) |
| [`@vortex-browser/extension`](packages/extension) | Chrome 扩展（MV3）—— 执行浏览器操作 | [README](packages/extension/README.md) |
| [`@vortex-browser/server`](packages/server) | 本地桥接服务（NM ↔ HTTP/WS） | [README](packages/server/README.md) |
| [`@vortex-browser/cli`](packages/cli) | CLI 客户端 —— 从终端调用操作 | [README](packages/cli/README.md) |
| [`@vortex-browser/mcp`](packages/mcp) | MCP 服务端 —— 连接 Claude Code 及其他 LLM 工具 | [README](packages/mcp/README.md) |

完整设计文档：[`docs/DESIGN.md`](docs/DESIGN.md)（架构图、协议、关键设计决策、安全模型、路线图）。

## 工具列表（15 个工具）

| 分类 | 工具 |
|------|------|
| 交互 | `vortex_act`（点击 / 输入 / 选择 / 滚动 / 悬停）· `vortex_fill`（表单填写）· `vortex_press`（键盘）· `vortex_mouse_drag` |
| 检查 | `vortex_observe`（候选元素 + 引用）· `vortex_extract`（HTML / 文本 / 引用）· `vortex_screenshot` |
| 导航 | `vortex_navigate` · `vortex_tab_create` · `vortex_tab_close` · `vortex_wait_for` |
| 高级 | `vortex_evaluate`（执行 JS）· `vortex_file_upload` · `vortex_storage` · `vortex_debug_read` |

完整工具文档见 [`packages/mcp/README.md`](packages/mcp/README.md)。

## 开发

```bash
pnpm install
pnpm -r build              # 完整构建
pnpm --filter <pkg> dev    # 单包 watch 模式
```

各子包 README 含各自的调试与构建说明。

## 许可证

MIT

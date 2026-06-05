# Vortex — 安装指南

[English](INSTALL.md) | 简体中文

> **5 分钟完成安装。** 你只需安装 **2 个东西**：Chrome 扩展 + `@vortex-browser/server`。第三个组件（`@vortex-browser/mcp`）由你的 AI 客户端按需自动拉取，无需手动安装。

---

## 前置要求

| 要求 | 版本 |
|------|------|
| Node.js | ≥ 18 |
| Chrome | 任意近期稳定版 |
| 操作系统 | macOS、Linux 或 Windows（WSL） |

---

## 三个组件如何协同工作

```
AI 客户端（Claude Code / Cursor / 任意 MCP 客户端）
    │
    │  MCP stdio  ← @vortex-browser/mcp（无需安装，npx 按需拉取）
    ▼
@vortex-browser/server       ← 你来安装（npm i -g）
    │                           Chrome 通过 Native Messaging 自动启动它
    │  ws://localhost:6800/ws
    ▼
Chrome 扩展（MV3）           ← 你来安装（加载已解压的扩展）
    │
    ▼
你真实的、已登录的 Chrome 页面
```

**为什么先加载扩展：** Chrome 的 Native Messaging 需要在宿主清单中列出扩展 ID。由于扩展 ID 已通过 `manifest.json` 钉死，`vortex-server install` 已内置默认 ID，无需手动复制。

---

## 第 1 步 — 安装 server

```bash
npm i -g @vortex-browser/server
```

完成后，`vortex-server` 命令即可在你的 PATH 中使用。

---

## 第 2 步 — 构建并加载 Chrome 扩展

> **Chrome Web Store 上架即将推出。** 发布后，此步骤将变为一键安装。在此之前，请从源码加载扩展。

**2a. 构建扩展**

```bash
git clone https://github.com/benbergg/vortex-browser
cd vortex-browser
pnpm install
pnpm -r build
```

构建完成的扩展位于 `packages/extension/dist/`。

**2b. 在 Chrome 中加载扩展**

1. 打开 Chrome，导航到 `chrome://extensions/`
2. 开启右上角的**开发者模式**
3. 点击**加载已解压的扩展程序**
4. 选择 `packages/extension/dist/` 文件夹
5. 扩展加载完成——扩展 ID 已钉死为 `fbonhjdohmkcejfgmaicnkknpfafihnd`，无需复制

---

## 第 3 步 — 注册原生宿主

```bash
vortex-server install
```

扩展 ID 已通过 `manifest.json` 钉死（`fbonhjdohmkcejfgmaicnkknpfafihnd`），命令无需参数，自动使用默认 ID。

> **ID 不同的构建？** 如果你加载的是 ID 不同的版本（例如 Chrome Web Store 版），请显式传入 ID：`vortex-server install <你的扩展ID>`

此命令会将 Native Messaging 宿主清单（`com.vortexbrowser.host`）写入对应的系统路径：

| 操作系统 | 路径 |
|----------|------|
| macOS | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.vortexbrowser.host.json` |
| Linux | `~/.config/google-chrome/NativeMessagingHosts/com.vortexbrowser.host.json` |
| Windows | `%LOCALAPPDATA%\Google\Chrome\User Data\NativeMessagingHosts\com.vortexbrowser.host.json` |

命令执行完毕后，回到 `chrome://extensions/`，点击 Vortex 扩展的**重新加载**按钮。此后，Chrome 会在扩展激活时自动启动 `vortex-server`——你永远不需要手动运行它。

**验证连接：**
1. 前往 `chrome://extensions/` → Vortex → **检查视图：Service Worker**
2. 应当看到：`[NM] connected`
3. 或运行：`curl http://localhost:6800/health`——应返回 `OK`

---

## 第 4 步 — 接入 AI 客户端

### Claude Code

```bash
claude mcp add vortex --scope user -- npx -y @vortex-browser/mcp
```

### Cursor

添加到 `~/.cursor/mcp.json`（全局）或项目目录的 `.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "vortex": {
      "command": "npx",
      "args": ["-y", "@vortex-browser/mcp"]
    }
  }
}
```

### Claude Desktop

添加到 Claude Desktop 的 MCP 配置文件：

```json
{
  "mcpServers": {
    "vortex": {
      "command": "npx",
      "args": ["-y", "@vortex-browser/mcp"]
    }
  }
}
```

### 其他支持 MCP 的客户端

任何支持 MCP stdio 传输协议的客户端均可使用相同的命令：

- **command：** `npx`
- **args：** `["-y", "@vortex-browser/mcp"]`

> **关于 OpenClaw 及其他客户端：** 早期的 OpenClaw 专用桥接已移除。Vortex 现在使用标准 MCP stdio 传输协议，兼容任何符合规范的 MCP 客户端。

### 修改端口

Server 默认监听端口 `6800`。如需修改，在启动 AI 客户端前设置环境变量：

```bash
VORTEX_PORT=7000 claude mcp add vortex --scope user -- npx -y @vortex-browser/mcp
```

或在 Cursor/Claude Desktop 的 JSON 配置块中添加 `"env": { "VORTEX_PORT": "7000" }`。

---

## 排错

### Server 无法访问

检查 server 是否正在运行并监听端口：

```bash
lsof -iTCP:6800
curl http://localhost:6800/health
```

如果 server 未运行，请查看扩展的 Service Worker 控制台（`chrome://extensions/` → Vortex → 检查视图：Service Worker）中的错误信息。

### 扩展无法连接 server

1. 前往 `chrome://extensions/` → Vortex → **检查视图：Service Worker**
2. 查找 `[NM] connected`——若缺失，说明原生宿主注册可能有误
3. 验证宿主清单文件是否存在且包含正确的扩展 ID：

```bash
# macOS
cat "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.vortexbrowser.host.json"

# Linux
cat "$HOME/.config/google-chrome/NativeMessagingHosts/com.vortexbrowser.host.json"
```

`allowed_origins` 字段必须包含你的完整扩展 ID：
```json
"allowed_origins": ["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"]
```

### 扩展 ID 变了

由于扩展 ID 通过 `manifest.json` 钉死，删除并重新添加扩展后 ID 不变（仍为 `fbonhjdohmkcejfgmaicnkknpfafihnd`）。直接重新执行注册命令，无需参数：

```bash
vortex-server install
```

然后在 `chrome://extensions/` 中重新加载扩展。该命令可安全重复执行——它会覆盖之前的清单文件。

> 如果你加载的是 ID 确实不同的构建（例如 Chrome Web Store 版），请显式传入 ID：`vortex-server install <你的扩展ID>`

### 修改清单后需完全重启 Chrome

修改原生宿主清单后，需要完全重启 Chrome（关闭所有窗口，而非仅刷新标签页）才能生效。

### `vortex-server` 命令未找到

确保 npm 全局 bin 目录已加入 PATH：

```bash
npm bin -g   # 显示全局 bin 路径
```

如果输出的路径未在 PATH 中，将其添加到 shell 配置文件（`.bashrc`、`.zshrc` 等）。

---

## Chrome Web Store

> **即将上线。** 扩展发布到 Chrome Web Store 后，安装将变为一键操作——无需克隆仓库或从源码构建。届时，上述第 2a 和第 2b 步将被一个"添加至 Chrome"按钮所取代。

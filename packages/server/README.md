# @bytenew/vortex-server

Vortex 桥接服务。一边是 Chrome 扩展（Native Messaging stdio），一边是本地客户端：
- **MCP server**（`@bytenew/vortex-mcp`）通过本地 WebSocket
- **CLI**（`@bytenew/vortex-cli`）通过本地 HTTP

## 安装

```bash
npm i -g @bytenew/vortex-server
# 或在仓库内
pnpm --filter @bytenew/vortex-server build
```

## 启动

### 单机本地（默认）

```bash
vortex-server
# 等价：监听 127.0.0.1:6800（HTTP + WS），等 Chrome 扩展通过 NM 连过来
```

| 端点 | 用途 |
|------|------|
| `ws://localhost:6800/ws` | MCP 客户端连接 |
| `http://localhost:6800/...` | CLI / 直接调用（见 [http-routes.ts](src/http-routes.ts)） |

### 通过 Chrome NM 自动启动

由 Chrome 扩展通过 [`native-host.sh`](native-host.sh) 拉起。需要先安装 NM host manifest（见下方）。

## 命令行参数

| 参数 | 默认 | 说明 |
|------|------|------|
| `--port <n>` | `6800` | 本地 HTTP/WS 端口（也可用 `VORTEX_PORT` 环境变量） |

## Native Messaging Host 安装

Chrome 通过 NM host manifest 找到 `native-host.sh`：

```bash
# macOS
mkdir -p "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
cat > "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.bytenew.vortex.json" <<EOF
{
  "name": "com.bytenew.vortex",
  "description": "Vortex NM host",
  "path": "$(npm root -g)/@bytenew/vortex-server/native-host.sh",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://<EXTENSION_ID>/"]
}
EOF
```

替换 `<EXTENSION_ID>` 为 Chrome 加载扩展后的实际 ID。Linux 路径：`~/.config/google-chrome/NativeMessagingHosts/`。

## 模块结构

```
src/
├── index.ts            # startServer 入口
├── ws-server.ts        # 本地 WS（给 MCP 客户端）
├── http-routes.ts      # 本地 HTTP（给 CLI 与外部脚本）
├── native-messaging.ts # Chrome NM stdio 协议
├── message-router.ts   # VtxRequest ↔ NmRequest 互转 + pending 管理
└── session.ts
bin/
└── vortex-server.ts    # commander CLI
native-host.sh          # Chrome NM 入口脚本（自动加载 nvm）
```

## 调试

- 日志全部走 stderr（避免污染 NM stdio）
- 关键事件：`[NM] connected`、`[ws] client connected`
- 验证 WS：`websocat ws://localhost:6800/ws` 或 `wscat -c ...`
- 验证 HTTP：`curl http://localhost:6800/health`

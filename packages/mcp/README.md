# @vortex-browser/mcp

Connect Claude Code to your local Chrome via MCP (Model Context Protocol) — let Claude drive the browser you're already logged into: navigate, click, fill forms, screenshot, scrape the DOM, read console/network logs, run JS, and more.

Built on the [Vortex](https://github.com/benbergg/vortex-browser) browser automation suite: Vortex Chrome extension ↔ vortex-server (local WS) ↔ this MCP server (stdio) ↔ Claude Code.

---

## Prerequisites

1. **Install the Vortex Chrome extension** (lets the extension take over the current browser)
2. **Run vortex-server** (local WebSocket, listens on port 6800)

   ```bash
   # Install globally via npm
   npm i -g @vortex-browser/server

   # Or from the vortex repo
   pnpm --filter @vortex-browser/server build
   node packages/server/dist/bin/vortex-server.js
   ```

   Once started it will listen at `ws://localhost:6800/ws`; the extension connects automatically.

3. **Node ≥ 18** (MCP server uses ESM)

---

## Add to Claude Code (global)

Claude Code registers MCP servers via `claude mcp add`. Pass `--scope user` to share across all projects.

### Recommended: pull via npx (no local build needed)

```bash
claude mcp add vortex \
  --scope user \
  -- npx -y @vortex-browser/mcp
```

### Local build / dev mode

```bash
# 1. Build
cd /path/to/vortex/packages/mcp
pnpm install && pnpm build

# 2. Register (point to dist/src/server.js)
claude mcp add vortex \
  --scope user \
  -- node /absolute/path/to/vortex/packages/mcp/dist/src/server.js
```

### Custom port / timeout

```bash
claude mcp add vortex \
  --scope user \
  --env VORTEX_PORT=6800 \
  --env VORTEX_TIMEOUT_MS=60000 \
  -- npx -y @vortex-browser/mcp
```

| Env var | Default | Description |
|---------|---------|-------------|
| `VORTEX_PORT` | `6800` | Local vortex-server WS port |
| `VORTEX_TIMEOUT_MS` | `30000` | Per-tool-call timeout (ms) |

### Verify

```bash
claude mcp list
# Should show:
#   vortex: npx -y @vortex-browser/mcp - ✓ Connected
```

Or type `/mcp` inside a Claude Code session to check connection status, then ask Claude to call `mcp__vortex__vortex_observe` on the current page.

---

## Manual config (optional)

`claude mcp add` writes to the `mcpServers` section of `~/.claude.json`. Direct editing is equivalent:

```json
{
  "mcpServers": {
    "vortex": {
      "command": "npx",
      "args": ["-y", "@vortex-browser/mcp"],
      "env": {
        "VORTEX_PORT": "6800",
        "VORTEX_TIMEOUT_MS": "30000"
      }
    }
  }
}
```

---

## Tool surface (15 tools)

| Category | Tools |
|----------|-------|
| Interact | `vortex_act` (click / type / select / scroll / hover) · `vortex_fill` (form fields) · `vortex_press` (keyboard) · `vortex_mouse_drag` |
| Inspect | `vortex_observe` (candidate elements + refs) · `vortex_extract` (HTML / text / refs) · `vortex_screenshot` |
| Navigate | `vortex_navigate` · `vortex_tab_create` · `vortex_tab_close` · `vortex_wait_for` |
| Advanced | `vortex_evaluate` (run JS) · `vortex_file_upload` · `vortex_storage` · `vortex_debug_read` |

---

## Remove

```bash
claude mcp remove vortex --scope user
```

---

## Troubleshooting

| Symptom | Cause / Fix |
|---------|-------------|
| `Failed to connect to vortex-server at localhost:6800` | vortex-server is not running, or the port is taken. Check with `lsof -iTCP:6800 -sTCP:LISTEN` |
| Tool calls keep timing out | Extension not connected to server. Open Chrome extensions page and confirm Vortex status; or raise `VORTEX_TIMEOUT_MS` |
| Screenshot response too large, truncated | Images over 500 KB are automatically saved to a local file; the path is returned (Claude can still read it) |
| `claude mcp list` shows ✗ Failed | Run `claude mcp get vortex` to see the error, or run `npx -y @vortex-browser/mcp` manually to inspect stderr |

---

## License

MIT

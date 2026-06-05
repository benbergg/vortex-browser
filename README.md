# Vortex

> Let your AI agent drive your **real, logged-in Chrome** — not a headless clone.

Browser automation built for LLM agents (MCP / HTTP / WS). Unlike Playwright/Puppeteer (headless, isolated browsers) or browser-use (spins up its own session), Vortex **takes over the Chrome you're already logged into** — cookies, extensions, history all intact. Scrape behind-login content, run daily web tasks, do semi-supervised RPA.

English | [简体中文](README.zh-CN.md)

![demo](docs/assets/demo.gif)

## Why Vortex (vs alternatives)

| | Vortex | Playwright / Puppeteer | browser-use |
|---|---|---|---|
| Real logged-in session | ✅ your actual Chrome | ❌ fresh context | ❌ own browser |
| Built for LLM agents | ✅ MCP-native | ⚠️ general | ✅ |
| Bench coverage | ✅ 50/50 public-tool | n/a | n/a |

## How it works

Vortex has **three components**, but you only install two:

```
AI client (Claude Code / Cursor / any MCP client)
    │
    │  MCP stdio  (no install needed — npx pulls it on demand)
    ▼
@vortex-browser/mcp          ← launched automatically by your AI client
    │
    │  ws://localhost:6800/ws
    ▼
@vortex-browser/server       ← installed on your machine; auto-started by Chrome
    │                           via Native Messaging — you never run it manually
    │  Native Messaging (stdio, host: com.vortexbrowser.host)
    ▼
Chrome extension (MV3)       ← installed in your Chrome
    │
    ▼
Your real, logged-in Chrome page
```

**Key points:**
- **You only install 2 things:** the Chrome extension + `@vortex-browser/server`.
- **`@vortex-browser/mcp` installs itself** — your AI client runs `npx -y @vortex-browser/mcp` automatically; nothing to install.
- **The server starts itself** — when the extension activates, Chrome launches it via Native Messaging. You never run `vortex-server` manually.
- **Load the extension first:** `vortex-server install` uses the pinned extension ID automatically — no need to copy anything.

## Quick start

Full step-by-step guide: **[docs/INSTALL.md](docs/INSTALL.md)**

**1. Install the server**
```bash
npm i -g @vortex-browser/server
```

**2. Build the extension**
```bash
git clone https://github.com/benbergg/vortex-browser
cd vortex-browser && pnpm install && pnpm -r build
```

**3. Load the extension in Chrome**
- Open `chrome://extensions`
- Turn on **Developer mode** (top-right toggle)
- Click **Load unpacked** → select the `packages/extension/dist/` folder

> The extension ID is pinned, so you never need to copy it.

**4. Register the native messaging host**
```bash
vortex-server install
```

**5. Reload the extension** so it picks up the native host
- Back on `chrome://extensions`, click the **↻ reload** icon on the Vortex card

**6. Connect your AI client** (Claude Code example)
```bash
claude mcp add vortex --scope user -- npx -y @vortex-browser/mcp
```

### Connect your AI client

**Claude Code**
```bash
claude mcp add vortex --scope user -- npx -y @vortex-browser/mcp
```

**Cursor** — add to `~/.cursor/mcp.json` or `.cursor/mcp.json` in your project:
```json
{
  "mcpServers": {
    "vortex": { "command": "npx", "args": ["-y", "@vortex-browser/mcp"] }
  }
}
```

**Claude Desktop / other MCP clients** — use the same stdio command in their MCP config:
```json
{ "command": "npx", "args": ["-y", "@vortex-browser/mcp"] }
```

**Any other MCP-compatible client** — any client that supports MCP stdio transport works with the command above.

> Set `VORTEX_PORT=<port>` to change the server port (default: `6800`).

---

## Architecture

```
LLM (Claude Code / custom client)
    │
    │ MCP / HTTP / WS
    ▼
┌─────────────────────────┐
│  @vortex-browser/mcp    │  MCP server (stdio)
│  @vortex-browser/cli    │  CLI client
└────────────┬────────────┘
             │  ws / http
             ▼
┌─────────────────────────┐
│  @vortex-browser/server │  local bridge
└────────────┬────────────┘
             │  Native Messaging (stdio)
             ▼
┌─────────────────────────┐
│ @vortex-browser/extension│ Chrome extension (MV3)
└─────────────────────────┘
             │
             ▼
       Real Chrome page
```

## Packages

| Package | Purpose | README |
|---------|---------|--------|
| [`@vortex-browser/shared`](packages/shared) | Shared types / action names / error codes | [README](packages/shared/README.md) |
| [`@vortex-browser/extension`](packages/extension) | Chrome extension (MV3) — executes browser actions | [README](packages/extension/README.md) |
| [`@vortex-browser/server`](packages/server) | Local bridge service (NM ↔ HTTP/WS) | [README](packages/server/README.md) |
| [`@vortex-browser/cli`](packages/cli) | CLI client — invoke actions from the terminal | [README](packages/cli/README.md) |
| [`@vortex-browser/mcp`](packages/mcp) | MCP server — connects Claude Code and other LLM tools | [README](packages/mcp/README.md) |

Full design: [`docs/DESIGN.md`](docs/DESIGN.md) (architecture diagrams, protocol, key design decisions, security model, roadmap).

## Tool surface (15 tools)

| Category | Tools |
|----------|-------|
| Interact | `vortex_act` (click / type / select / scroll / hover) · `vortex_fill` (form fields) · `vortex_press` (keyboard) · `vortex_mouse_drag` |
| Inspect | `vortex_observe` (candidate elements + refs) · `vortex_extract` (HTML / text / refs) · `vortex_screenshot` |
| Navigate | `vortex_navigate` · `vortex_tab_create` · `vortex_tab_close` · `vortex_wait_for` |
| Advanced | `vortex_evaluate` (run JS) · `vortex_file_upload` · `vortex_storage` · `vortex_debug_read` |

See [`packages/mcp/README.md`](packages/mcp/README.md) for full tool documentation.

## Development

```bash
pnpm install
pnpm -r build              # full build
pnpm --filter <pkg> dev    # single package watch mode
```

Each sub-package README has its own debug/build instructions.

## License

MIT

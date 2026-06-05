# Vortex

> Let your AI agent drive your **real, logged-in Chrome** — not a headless clone.

Browser automation built for LLM agents (MCP / HTTP / WS). Unlike Playwright/Puppeteer (headless, isolated browsers) or browser-use (spins up its own session), Vortex **takes over the Chrome you're already logged into** — cookies, extensions, history all intact. Scrape behind-login content, run daily web tasks, do semi-supervised RPA.

![demo](docs/assets/demo.gif)

## Why Vortex (vs alternatives)

| | Vortex | Playwright / Puppeteer | browser-use |
|---|---|---|---|
| Real logged-in session | ✅ your actual Chrome | ❌ fresh context | ❌ own browser |
| Built for LLM agents | ✅ MCP-native | ⚠️ general | ✅ |
| Bench coverage | ✅ 50/50 public-tool | n/a | n/a |

## Quick start (Claude Code)

```bash
claude mcp add vortex --scope user -- npx -y @vortex-browser/mcp
```

Then install the Chrome extension + native host — see [install guide](docs/INSTALL.md).

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

## Full installation

For step-by-step setup (extension, native host, server), see [docs/INSTALL.md](docs/INSTALL.md).

## Development

```bash
pnpm install
pnpm -r build              # full build
pnpm --filter <pkg> dev    # single package watch mode
```

Each sub-package README has its own debug/build instructions.

## License

MIT

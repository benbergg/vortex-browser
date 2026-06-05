# Vortex — Installation Guide

English | [简体中文](INSTALL.zh-CN.md)

> **5-minute setup.** You install exactly **2 things**: the Chrome extension and `@vortex-browser/server`. The third component (`@vortex-browser/mcp`) is pulled automatically by your AI client — nothing to install.

---

## Prerequisites

| Requirement | Version |
|-------------|---------|
| Node.js | ≥ 18 |
| Chrome | Any recent stable release |
| OS | macOS, Linux, or Windows (WSL) |

---

## How the three components fit together

```
AI client (Claude Code / Cursor / any MCP client)
    │
    │  MCP stdio  ← @vortex-browser/mcp (no install — npx pulls on demand)
    ▼
@vortex-browser/server       ← you install this (npm i -g)
    │                           Chrome auto-starts it via Native Messaging
    │  ws://localhost:6800/ws
    ▼
Chrome extension (MV3)       ← you install this (load unpacked)
    │
    ▼
Your real, logged-in Chrome page
```

**Why the extension loads first:** Chrome's Native Messaging requires the extension ID to be listed in the host manifest. Because the extension ID is now pinned in `manifest.json`, `vortex-server install` already knows the correct ID — no need to copy anything.

---

## Step 1 — Install the server

```bash
npm i -g @vortex-browser/server
```

After this, the `vortex-server` command is available in your PATH.

---

## Step 2 — Build and load the Chrome extension

> **Chrome Web Store listing is coming soon.** Once published, this step becomes a one-click install. Until then, load the extension from source.

**2a. Build the extension**

```bash
git clone https://github.com/benbergg/vortex-browser
cd vortex-browser
pnpm install
pnpm -r build
```

The built extension will be at `packages/extension/dist/`.

**2b. Load the extension in Chrome**

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the `packages/extension/dist/` folder
5. The extension loads — the extension ID is pinned to `fbonhjdohmkcejfgmaicnkknpfafihnd`, no need to copy it

---

## Step 3 — Register the native host

```bash
vortex-server install
```

The extension ID is pinned in `manifest.json` (`fbonhjdohmkcejfgmaicnkknpfafihnd`), so the command works without arguments — it uses the default ID automatically.

> **Different build?** If you're loading a build with a different ID (e.g. a Chrome Web Store version), pass the ID explicitly: `vortex-server install <your-extension-id>`

This command writes the Native Messaging host manifest (`com.vortexbrowser.host`) to the correct system path:

| OS | Path |
|----|------|
| macOS | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.vortexbrowser.host.json` |
| Linux | `~/.config/google-chrome/NativeMessagingHosts/com.vortexbrowser.host.json` |
| Windows | `%LOCALAPPDATA%\Google\Chrome\User Data\NativeMessagingHosts\com.vortexbrowser.host.json` |

After running the command, go back to `chrome://extensions/` and click **Reload** on the Vortex extension. Chrome will now auto-start `vortex-server` when the extension activates — you never need to run `vortex-server` manually.

**Verify the connection:**
1. Navigate to `chrome://extensions/` → Vortex → **Inspect views: service worker**
2. You should see: `[NM] connected`
3. Or run: `curl http://localhost:6800/health` — should return `OK`

---

## Step 4 — Connect your AI client

### Claude Code

```bash
claude mcp add vortex --scope user -- npx -y @vortex-browser/mcp
```

### Cursor

Add to `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` in your project:

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

Add to Claude Desktop's MCP configuration file:

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

### Other MCP-compatible clients

Any client that supports MCP stdio transport can use the same command:

- **command:** `npx`
- **args:** `["-y", "@vortex-browser/mcp"]`

> **Note on OpenClaw and other clients:** The earlier OpenClaw-specific bridge has been removed. Vortex now uses standard MCP stdio transport, which works with any compliant MCP client.

### Port configuration

By default the server listens on port `6800`. To use a different port, set the environment variable before starting your AI client:

```bash
VORTEX_PORT=7000 claude mcp add vortex --scope user -- npx -y @vortex-browser/mcp
```

Or add `"env": { "VORTEX_PORT": "7000" }` to the JSON config block for Cursor/Claude Desktop.

---

## Troubleshooting

### Server not reachable

Check whether the server is running and listening:

```bash
lsof -iTCP:6800
curl http://localhost:6800/health
```

If the server is not running, check the extension's service worker console (`chrome://extensions/` → Vortex → Inspect views: service worker) for errors.

### Extension not connecting to server

1. Go to `chrome://extensions/` → Vortex → **Inspect views: service worker**
2. Look for `[NM] connected` — if missing, the native host registration may be wrong
3. Verify the host manifest exists and contains the correct extension ID:

```bash
# macOS
cat "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.vortexbrowser.host.json"

# Linux
cat "$HOME/.config/google-chrome/NativeMessagingHosts/com.vortexbrowser.host.json"
```

The `allowed_origins` field must contain your exact extension ID:
```json
"allowed_origins": ["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"]
```

### Extension ID changed

Because the extension ID is pinned via `manifest.json`, removing and re-adding the extension keeps the same ID (`fbonhjdohmkcejfgmaicnkknpfafihnd`). Simply re-run the registration without any argument:

```bash
vortex-server install
```

Then reload the extension in `chrome://extensions/`. The command is safe to re-run — it overwrites the previous manifest.

> If you're loading a build with a genuinely different ID (e.g. Chrome Web Store), pass the ID explicitly: `vortex-server install <your-extension-id>`

### After any manifest change

Fully restart Chrome (close all windows, not just the tab) for the new native host manifest to take effect.

### `vortex-server` command not found

Make sure your global npm bin directory is in your PATH:

```bash
npm bin -g   # shows the global bin path
```

Add the printed path to your shell's `PATH` if it's missing.

---

## Chrome Web Store

> **Coming soon.** Once the extension is published to the Chrome Web Store, installation will be a one-click process — no need to clone the repository or build from source. Steps 2a and 2b above will be replaced by a single "Add to Chrome" button.

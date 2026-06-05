# Installing Vortex Browser

Vortex consists of two parts that work together:

1. **`@vortex-browser/server`** — a local bridge server that runs on your machine and speaks [Native Messaging](https://developer.chrome.com/docs/extensions/mv3/nativeMessaging/) with the Chrome extension
2. **`@vortex-browser/extension`** — a Chrome extension (Manifest V3) that exposes browser automation capabilities

Both must be installed and connected for Vortex to work.

---

## Prerequisites

| Requirement | Version |
|-------------|---------|
| Node.js     | ≥ 18    |
| Chrome      | Any recent stable release |
| OS          | macOS or Linux (Windows: see [manual steps](#windows-manual-steps)) |

---

## Three-Step Installation

### Step 1 — Install the bridge server

**Option A: npm global install (recommended after public release)**

```bash
npm i -g @vortex-browser/server
```

Expected result: `vortex-server` command is available in your PATH.

**Option B: build from source (development / pre-release)**

```bash
# From the repository root
pnpm --filter @vortex-browser/server build
```

Expected result: `packages/server/dist/` is populated with the compiled JS.

---

### Step 2 — Register the Native Messaging host + load the extension

Run the one-command installer from the repository root:

```bash
bash scripts/install.sh
```

The script will:
1. Detect your OS (macOS / Linux)
2. Check Node.js ≥ 18
3. Auto-build the server if `dist/` is missing
4. Prompt you for your Chrome extension ID (see below how to get it)
5. Write the NM host manifest to the correct system path
6. Print extension load instructions

**Getting your extension ID:**

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked** and select:
   ```
   packages/extension/dist/
   ```
4. After loading, copy the extension ID shown under the extension name (32 lowercase letters, e.g. `abcdefghijklmnopabcdefghijklmnop`)
5. Paste it into the `install.sh` prompt

**Passing the extension ID non-interactively:**

```bash
# Via positional argument
bash scripts/install.sh abcdefghijklmnopabcdefghijklmnop

# Via environment variable
VORTEX_EXTENSION_ID=abcdefghijklmnopabcdefghijklmnop bash scripts/install.sh
```

Expected result:
- NM host manifest written to:
  - macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.vortexbrowser.host.json`
  - Linux: `~/.config/google-chrome/NativeMessagingHosts/com.vortexbrowser.host.json`
- Script exits with code 0

---

### Step 3 — Start the server and verify

```bash
# From source
node packages/server/dist/bin/vortex-server.js

# Or if globally installed
vortex-server
```

Expected result:

```
[server] listening on 127.0.0.1:6800
```

Then open Chrome. If the extension is loaded and the NM host is registered correctly, the service worker will connect automatically. Check the service worker console:

1. `chrome://extensions/` → Vortex → **Inspect views: service worker**
2. You should see: `[NM] connected`

---

## Chrome Web Store

> **Coming in a future release.** The Chrome Web Store listing will eliminate the need to manually load an unpacked extension. For now, the "Load unpacked" method in Step 2 is the supported installation path.

---

## Troubleshooting

### NM host not connecting

**Symptom:** Service worker logs `Failed to connect to native messaging host` or `Specified native messaging host not found`.

**Checks:**

1. Verify the manifest file exists:
   ```bash
   # macOS
   cat "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.vortexbrowser.host.json"

   # Linux
   cat "$HOME/.config/google-chrome/NativeMessagingHosts/com.vortexbrowser.host.json"
   ```

2. Confirm the `path` field in the manifest points to an existing, executable file:
   ```bash
   # The path printed above — run it directly to test
   ls -l <path-from-manifest>
   ```

3. Confirm the `allowed_origins` field contains your exact extension ID:
   ```json
   "allowed_origins": ["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"]
   ```
   If the ID changed (e.g. you reloaded the extension), re-run `install.sh` with the new ID.

4. After any manifest change, fully restart Chrome (all windows, not just reload the tab).

### Server not starting

**Symptom:** `node: command not found` or `Cannot find module`

- Ensure Node.js ≥ 18 is installed: `node --version`
- If building from source, ensure the build completed: `ls packages/server/dist/bin/`

### vortex tools returning errors

- Confirm `vortex-server` is running (`curl http://localhost:6800/health` should return `OK`)
- Confirm the extension is loaded and enabled in `chrome://extensions/`
- Check the service worker console for `[NM] connected`

### Re-registering after extension reload

Chrome assigns a new extension ID if you remove and re-add the extension. In that case:

```bash
bash scripts/install.sh <new-extension-id>
```

The script is idempotent — running it again overwrites the manifest safely.

---

## Manual NM Host Registration

If you prefer not to use `install.sh`, register the host manually:

```bash
# macOS
NM_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"

# Linux
# NM_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"

mkdir -p "$NM_DIR"
node packages/server/dist/scripts/install-nm-host.js <extension-id>
```

---

## Windows Manual Steps

Windows is not supported by the `install.sh` script. To install manually:

1. Build the server: `pnpm --filter @vortex-browser/server build`
2. Load the extension in Chrome (Step 2 above, same process)
3. Create the NM host manifest directory:
   ```
   %LOCALAPPDATA%\Google\Chrome\User Data\NativeMessagingHosts\
   ```
4. Create `com.vortexbrowser.host.json` in that directory:
   ```json
   {
     "name": "com.vortexbrowser.host",
     "description": "Vortex browser automation middleware",
     "path": "C:\\path\\to\\packages\\server\\native-host.sh",
     "type": "stdio",
     "allowed_origins": ["chrome-extension://<extension-id>/"]
   }
   ```
   Replace `<extension-id>` with your actual extension ID.
5. Note: `native-host.sh` is a bash script. On Windows you may need WSL or Git Bash, and to adjust the `path` to point to a `.bat` or `.cmd` wrapper accordingly.

# Contributing to Vortex

Thanks for contributing! This guide covers the local dev loop, testing, and conventions.

## Setup

```bash
pnpm install
pnpm -r build      # build all packages once
pnpm test          # run all unit tests (pnpm test:integration for process-spawning ones)
```

Requires Node 20+ and pnpm. The monorepo has six packages (`shared`, `extension`, `server`, `cli`, `mcp`, `hub`) — see [README → Packages](README.md#packages).

## Dev loop

For most work you iterate on the **extension** (browser action handlers) and the **mcp** layer (tool schemas).

```bash
# One command — orchestrates all watchers + registers this worktree's NM host
pnpm dev:all          # add --smoke to run a bench case once ready

# …or per-package:
pnpm --filter @vortex-browser/extension dev   # Vite serve + @crxjs HMR + page-side watch
pnpm --filter @vortex-browser/mcp dev         # tsc --watch
pnpm --filter @vortex-browser/server dev      # tsc --watch
```

**Loading the extension is a one-time step.** Chrome 137+ removed `--load-extension` (verified dead on Chrome 148 stable; Chrome for Testing loads it but the MV3 service worker stays dormant on `about:blank`), so there is no reliable headless auto-load. Load `packages/extension/dist` once via `chrome://extensions` → Developer mode → Load unpacked. The ID is pinned, so the load persists; from then on `@crxjs` HMR auto-reloads on every code change — no manual reload, and the MCP↔server WebSocket auto-reconnects so you don't need `/mcp reconnect` either (only mcp-code changes need that). Fixed ID + single port 6800 (the hub) supports multiple Chrome profiles/instances: each profile spawns its own browser-agent, which connects outbound to the hub, and the hub distinguishes them by `browserId`. Prefer separate profiles in one Chrome installation. The Native Messaging manifest directory is channel-scoped and shared by all profiles of that channel, so one `vortex-server install` covers every profile of Chrome stable. Other channels and other Chromium browsers (Edge, Canary, Chromium) each have their own directory — `vortex-server install --all-channels` registers with all of them at once, skipping the ones not installed. Known limitation: `POST /relaunch-trusted` returns 409 when more than one browser is connected because `relauncher.ts` still restarts all Chrome processes; profile-level restart is not implemented.

**Reload semantics** (full table in [`packages/extension/README.md`](packages/extension/README.md#dev-loop-hmr)):

| You change… | What happens |
|-------------|--------------|
| extension handler / background | `@crxjs` auto-reloads the extension (no manual 🔄). The reload bounces the Native-Messaging server, but the MCP→server WebSocket auto-reconnects on the next tool call (`client.ts` `ensureConnected` + transient retry) — **no `/mcp reconnect` needed** (verified). |
| extension page-side (`src/page-side/*`) | Rebuilt by the watcher; picked up on the next `executeScript({files})` call — no reload needed. |
| mcp schemas / dispatch | The stdio MCP server is a long-lived child of your LLM client running compiled `dist`. Only this case needs `/mcp reconnect` to respawn it with fresh code. |

Loading the unpacked extension and the fixed extension ID are documented in the [extension README](packages/extension/README.md#安装到-chrome). The ID is pinned by a `key` in `manifest.json`, so it is stable across worktrees and the Native Messaging `allowed_origins` needs configuring only once.

<details>
<summary><b>Why there's no headless extension auto-load (Chrome 137+)</b></summary>

The one manual step — loading the unpacked extension once — can't be automated away on a normal Chrome, and the reasons are worth recording so nobody re-treads this:

- **`--load-extension` is dead on stable Chrome (137+).** Verified on **Chrome 148**: the flag is ignored and the extension never appears in the profile's `Preferences`. The historical `--disable-features=DisableLoadExtensionCommandLineSwitch` workaround no longer has any effect.
- **Chrome for Testing _loads_ it but the worker stays dormant.** CfT 145 (bundled in the Playwright cache, `~/Library/Caches/ms-playwright/chromium-*/…/Google Chrome for Testing.app`) does honor `--load-extension` — the extension ID shows up in `Default/Secure Preferences`. But with a start page of `about:blank`, the MV3 service worker never wakes, so it never runs `connectNative` and no `vortex-server` spawns. `/health` stays down.
- **CfT also looks elsewhere for the NM host manifest** — `~/Library/Application Support/Google/Chrome for Testing/NativeMessagingHosts/`, not the regular-Chrome dir — so the manifest must be copied there too.

**If you want to chase true zero-touch auto-load** (e.g. for CI), the viable path is Chrome for Testing with the service worker woken explicitly:
1. Copy the NM manifest into CfT's `NativeMessagingHosts/` dir.
2. Launch CfT with `--load-extension=…/dist --remote-debugging-port=<p>` and a **real start URL** (a content-scripted page, e.g. the bench playground) instead of `about:blank`, or use CDP to target the worker and call `chrome.runtime.connectNative` / dispatch an event that starts it.
3. Poll `/health` to confirm the server came up.

For day-to-day work this isn't worth it: load once in your normal Chrome, and `@crxjs` HMR handles every reload after that.

</details>

## Testing

```bash
pnpm test                                      # unit tests, all packages
pnpm test:integration                          # process-spawning tests only
pnpm --filter @vortex-browser/extension test   # one package
pnpm --filter @vortex-browser/extension exec vitest run <file>   # one file
```

- **Name a test `*.integration.test.ts` whenever it spawns a real process.** `pnpm test` excludes that pattern; `pnpm test:integration` runs it serially (`fileParallelism: false`, `maxWorkers: 1`). See `packages/{hub,mcp}/vitest.integration.config.ts`.
- **Why the split:** `pnpm -r test` runs 8 packages in parallel and each vitest spawns one worker per core. Add a few tests that fork real hub/MCP processes and the machine is oversubscribed, which pushes timing-sensitive cases (short `killTimeoutMs`, sub-200ms performance thresholds) past their budgets. The symptom is distinctive — the failing file **moves between runs** and passes when run alone. If you see that, check what new process-spawning tests landed rather than chasing the test that happened to fail.
- **TDD is expected** for features and bug fixes: write a failing test first, watch it fail for the right reason, then make it pass.
- **Page-side func tests must be scope-detached.** `chrome.scripting.executeScript({func})` serializes the func via `toString()` and injects it into the page MAIN world, losing module scope. A test that calls the captured func directly in Node passes via the module closure even when the func references a module-level helper that would be `undefined` in the page. Reconstruct with `new Function('return (' + fn.toString() + ')')()` to faithfully reproduce injection. (See `tests/js-evaluate-host-object-serialize.test.ts`.)

## Code conventions

- **Structured errors only.** Handler/lib code must `throw vtxError(VtxErrorCode.X, "msg", { ... })` from `@vortex-browser/shared` — never `throw new Error(...)`. Enforced by `pnpm lint:errors` (runs on `prebuild`).
- Comments are written in Chinese; keep API/identifier/exception names in English.
- Match the surrounding code's style and altitude.

## Commits

Follow [Conventional Commits](https://www.conventionalcommits.org/): `<type>(<scope>): <description>`.

- Types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `chore`, `ci`.
- Scope is usually the package: `fix(extension): …`, `feat(mcp): …`.
- Description is a concise imperative, no trailing period. Body explains *what/why*, not *how*.
- Do **not** add `Co-Authored-By` / `Signed-off-by` trailers.

## Before shipping a release

```bash
pnpm ship:preflight        # automated ship-checklist gates
```

Gates: CHANGELOG `[Unreleased]` rolled into a version, file paths in the version section actually appear in the diff, numeric claims cross-checked against commit messages, and new silent fallbacks (`??` / `||`) have a touched test. Exit `0` PASS / `1` FAIL / `2` WARN.

## Architecture & docs

- [README → Architecture](README.md#architecture) — the LLM → mcp/cli → server → extension → page chain.
- [README → Tool surface](README.md#tool-surface-15-tools) and [`packages/mcp/README.md`](packages/mcp/README.md) — the public tools.
- [`docs/INSTALL.md`](docs/INSTALL.md) · [`docs/trusted-mode.md`](docs/trusted-mode.md) — install and trusted-mode setup.
- Per-package `README.md` — module layout and debug instructions for each package.

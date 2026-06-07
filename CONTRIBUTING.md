# Contributing to Vortex

Thanks for contributing! This guide covers the local dev loop, testing, and conventions.

## Setup

```bash
pnpm install
pnpm -r build      # build all packages once
pnpm -r test       # run all test suites
```

Requires Node 20+ and pnpm. The monorepo has five packages (`shared`, `extension`, `server`, `cli`, `mcp`) — see [README → Packages](README.md#packages).

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

**Loading the extension is a one-time step.** Chrome 137+ removed `--load-extension` (verified dead on Chrome 148 stable; Chrome for Testing loads it but the MV3 service worker stays dormant on `about:blank`), so there is no reliable headless auto-load. Load `packages/extension/dist` once via `chrome://extensions` → Developer mode → Load unpacked. The ID is pinned, so the load persists; from then on `@crxjs` HMR auto-reloads on every code change — no manual reload, and the MCP↔server WebSocket auto-reconnects so you don't need `/mcp reconnect` either (only mcp-code changes need that). Fixed ID + single port 6800 means only one Chrome instance can run the extension at a time.

**Reload semantics** (full table in [`packages/extension/README.md`](packages/extension/README.md#dev-loop-hmr)):

| You change… | What happens |
|-------------|--------------|
| extension handler / background | `@crxjs` auto-reloads the extension (no manual 🔄). The reload drops Native Messaging, so run `/mcp reconnect` in your LLM client afterwards. |
| extension page-side (`src/page-side/*`) | Rebuilt by the watcher; picked up on the next `executeScript({files})` call — no reload needed. |
| mcp schemas / dispatch | The stdio MCP server is a child of your LLM client; run `/mcp reconnect` to respawn it with fresh `dist`. |

Loading the unpacked extension and the fixed extension ID are documented in the [extension README](packages/extension/README.md#安装到-chrome). The ID is pinned by a `key` in `manifest.json`, so it is stable across worktrees and the Native Messaging `allowed_origins` needs configuring only once.

## Testing

```bash
pnpm -r test                                   # everything
pnpm --filter @vortex-browser/extension test   # one package
pnpm --filter @vortex-browser/extension exec vitest run <file>   # one file
```

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

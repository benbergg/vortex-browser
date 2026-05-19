# vortex-bench reports

This directory holds three kinds of artifacts:

| File / dir | Tracked in git? | Purpose |
|------------|-----------------|---------|
| `baseline.json` | yes | The reference run that `vortex-bench diff` compares `latest.json` against. **Must be re-generated whenever the case set, the playground, or the public tool surface changes.** |
| `boxes-budget-*.json` | yes | SPEC R6 token-budget sweep artifacts (`vortex-bench compare-boxes`). Dated. PR evidence; don't delete. |
| `archive/` | yes | Historical baselines kept for audit. Naming convention: `baseline-vX.Y-Ncases-YYYY-MM-DD.json`. |
| `latest.json` | **no** (gitignored) | Output of the most recent `vortex-bench run`. Overwritten every run. |

## Refreshing the baseline

Whenever you add / remove cases or change a public tool's surface, `baseline.json` becomes a stale reference and `vortex-bench diff` starts emitting noise (every new case shows as `added`, every removed one as `removed`).

```bash
# 1) Bring up the playground server (in another shell)
pnpm -F @bytenew/vortex-bench playground

# 2) Load packages/extension/dist as an unpacked Chrome extension and
#    make sure native-host.sh is wired into your NM host config.
#    See packages/server/README.md for the one-time setup.

# 3) From the repo root, run the full bench and promote it
pnpm -F @bytenew/vortex-bench bench:baseline                        # single-shot
pnpm -F @bytenew/vortex-bench bench run --all --repeats 3 && \
  cp packages/vortex-bench/reports/latest.json \
     packages/vortex-bench/reports/baseline.json                    # recommended
```

**`--repeats N` is recommended for baseline refresh** (default `N=3`). The runner executes each case N times, then collapses the results: numeric metrics use the median, `passed` uses majority-pass (`passRate ≥ 0.5`). Single-flake runs no longer poison the baseline, and the reporter prints `n=3 pass=0.67` for borderline cases so you can see exactly which cases are on the edge.

`bench:baseline` still wraps the single-shot path (back-compat); pass `--repeats N` explicitly when you want aggregation. The previous baseline should first be moved into `archive/` with a dated filename so the audit trail is preserved:

```bash
mv reports/baseline.json reports/archive/baseline-vX.Y-Ncases-$(date +%F).json
pnpm -F @bytenew/vortex-bench bench run --all --repeats 3
cp reports/latest.json reports/baseline.json
```

## When a run looks like an env failure

`v0.8.x` reports include a `failureClass` field on each `CaseMetrics`. If all (or most) cases show `failureClass: "env_failure"` (typical message: `PERMISSION_DENIED` on `chrome-extension://…`), the extension hasn't been granted access to the playground origin in this Chrome profile — re-load `packages/extension/dist` as an unpacked extension and re-run. **Do not** promote such a run to `baseline.json`; it would lock the broken state in.

The `archive/baseline-v0.5-26cases-2026-04-22.json` baseline that lived at `baseline.json` until v0.8.0 is kept here as the historical reference point — it predates 12 of the current 38 cases and the v0.6/v0.7/v0.8 tool-surface reshuffles, so it can't be used as a current diff target.

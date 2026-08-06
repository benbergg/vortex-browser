/**
 * Author: qingwa
 * Description: Hub process entry point with listen locking and graceful shutdown.
 */
import { appendFileSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { vtxError, VtxErrorCode } from "@vortex-browser/shared";
import { createHub } from "./hub.js";
import { hubLogPath, hubPidPath, hubSpawnLockPath, resolveHubPort, runtimeDir } from "./paths.js";

export async function runHubProcess(port = resolveHubPort()): Promise<void> {
  mkdirSync(runtimeDir(), { recursive: true });
  let hub;
  try {
    hub = await createHub({ port });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      removeQuietly(hubSpawnLockPath(port));
      process.exitCode = 0;
      return;
    }
    throw error;
  }

  appendFileSync(hubLogPath(port), `[hub] listening on ${port}\n`);
  writeFileSync(hubPidPath(port), `${process.pid}\n`);
  removeQuietly(hubSpawnLockPath(port));
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await hub.close();
    removeQuietly(hubPidPath(port));
    process.exitCode = 0;
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
}

function parsePort(args: string[]): number | undefined {
  const index = args.indexOf("--port");
  if (index < 0) return undefined;
  const value = Number(args[index + 1]);
  if (!Number.isInteger(value) || value <= 0 || value > 65_535) {
    throw vtxError(VtxErrorCode.INVALID_PARAMS, "Invalid hub port");
  }
  return value;
}

function removeQuietly(path: string): void {
  try { unlinkSync(path); } catch { /* best effort */ }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runHubProcess(parsePort(process.argv.slice(2))).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[hub] fatal: ${message}`);
    process.exitCode = 1;
  });
}

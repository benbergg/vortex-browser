/**
 * Author: qingwa
 * Description: Runs the five-process listen race outside the Vitest worker.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [loader, main] = process.argv.slice(2);
const runtime = process.env.VORTEX_RUNTIME_DIR;
let port;
let children = [];
let cleanupPromise;

process.once("SIGTERM", () => {
  void cleanupChildren().then(() => {
    process.exitCode = 143;
  });
});

try {
  port = await freePort();
  await writeFile(join(runtime, "race-port"), String(port));
  children = Array.from({ length: 5 }, () => spawn(process.execPath, [
    "--experimental-transform-types", "--experimental-loader", loader, main, "--port", String(port),
  ], { env: { ...process.env, VORTEX_RUNTIME_DIR: runtime }, stdio: "ignore" }));
  const exits = children.map(waitForExit);
  await waitForHealth(port);
  await waitForExitCount(children, exits, 4);
  const stable = children.filter(isRunning);
  if (stable.length !== 1 || stable[0].pid === undefined) throw new Error("Expected one stable hub process");
  const stablePid = stable[0].pid;
  const stablePidSamples = await sampleStablePid(children, stablePid);
  await shutdown(port);
  await waitForGone(port);
  await Promise.all(exits);
  const result = {
    stablePid,
    stablePidSamples,
    children: children.map((child) => ({ pid: child.pid, exitCode: child.exitCode, signal: child.signalCode })),
  };
  await writeFile(join(runtime, "race-result.json"), JSON.stringify(result));
} catch (error) {
  await cleanupChildren();
  await writeFile(join(runtime, "race-error"), String(error));
  process.exitCode = 1;
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForHealth(port) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // The five child processes are still racing to bind the port.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Hub did not become ready");
}

async function shutdown(port) {
  await fetch(`http://127.0.0.1:${port}/hub/shutdown`, { method: "POST" }).catch(() => {});
}

async function waitForExitCount(children, exits, count) {
  const pending = new Map(children.map((child, index) => [child, exits[index]]));
  for (let exited = 0; exited < count; exited += 1) {
    const child = await Promise.race([...pending].map(async ([candidate, exit]) => {
      await exit;
      return candidate;
    }));
    pending.delete(child);
  }
}

async function sampleStablePid(children, stablePid) {
  const samples = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const live = children.filter(isRunning);
    if (live.length !== 1 || live[0].pid !== stablePid) {
      throw new Error(`Stable hub pid changed: expected ${stablePid}, got ${live.map((child) => child.pid).join(",")}`);
    }
    samples.push(live[0].pid);
    if (attempt < 4) await delay(25);
  }
  return samples;
}

async function waitForGone(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (!response.ok) return;
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Hub did not close");
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}

function isRunning(child) {
  return child.exitCode === null && child.signalCode === null;
}

async function cleanupChildren() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    if (port !== undefined) await shutdown(port);
    await Promise.all(children.map(stopChild));
  })();
  return cleanupPromise;
}

async function stopChild(child) {
  if (!isRunning(child)) return;
  const exit = waitForExit(child);
  child.kill("SIGTERM");
  await Promise.race([exit, delay(1_000)]);
  if (isRunning(child)) child.kill("SIGKILL");
  await exit;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

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

try {
  port = await freePort();
  await writeFile(join(runtime, "race-port"), String(port));
  children = Array.from({ length: 5 }, () => spawn(process.execPath, [
    "--experimental-transform-types", "--experimental-loader", loader, main, "--port", String(port),
  ], { env: { ...process.env, VORTEX_RUNTIME_DIR: runtime }, stdio: "ignore" }));
  const exits = children.map(waitForExit);
  await waitForHealth(port);
  const stablePid = children.find((child) => child.exitCode === null)?.pid;
  if (!stablePid) throw new Error("No stable hub process");
  await shutdown(port);
  await waitForGone(port);
  await Promise.all(exits);
  const result = {
    stablePid,
    children: children.map((child) => ({ pid: child.pid, exitCode: child.exitCode, signal: child.signalCode })),
  };
  await writeFile(join(runtime, "race-result.json"), JSON.stringify(result));
} catch (error) {
  if (port !== undefined) await shutdown(port);
  await Promise.all(children.map(waitForExit));
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

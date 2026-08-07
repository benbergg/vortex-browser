import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const handlersDir = fileURLToPath(new URL("../src/handlers/", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("getActiveTabId single source", () => {
  it("handlers do not define local getActiveTabId copies", () => {
    const definitions = sourceFiles(handlersDir).filter((path) => {
      const source = readFileSync(path, "utf8");
      return /function\s+getActiveTabId\b|const\s+getActiveTabId\s*=/.test(source);
    });

    expect(definitions.map((path) => relative(handlersDir, path))).toEqual([]);
  });
});

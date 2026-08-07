/**
 * Description: A publicly published package must not depend on a workspace package that cannot be published.
 */
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packagesRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface Manifest {
  name?: string;
  private?: boolean;
  publishConfig?: { access?: string };
  dependencies?: Record<string, string>;
}

describe("workspace publishability", () => {
  it("every workspace dependency of a public package is itself publishable", async () => {
    const manifests = await readManifests();
    const byName = new Map(manifests.map((m) => [m.name ?? "", m]));
    const offenders: string[] = [];

    for (const manifest of manifests) {
      if (manifest.private === true || manifest.publishConfig?.access !== "public") continue;
      for (const [dep, range] of Object.entries(manifest.dependencies ?? {})) {
        if (!range.startsWith("workspace:")) continue;
        const target = byName.get(dep);
        // 作用域包默认 restricted：发布后使用者 npm i 会 E404/E403
        if (target && target.private !== true && target.publishConfig?.access !== "public") {
          offenders.push(`${manifest.name} → ${dep}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

async function readManifests(): Promise<Manifest[]> {
  const entries = await readdir(packagesRoot, { withFileTypes: true });
  const manifests: Manifest[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      manifests.push(JSON.parse(await readFile(join(packagesRoot, entry.name, "package.json"), "utf8")));
    } catch {
      // 不是包目录
    }
  }
  return manifests;
}

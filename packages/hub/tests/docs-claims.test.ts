/**
 * Author: qingwa
 * Description: Locks the multi-browser claims and retained evidence in dogfood docs.
 */
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const contributing = join(repoRoot, "CONTRIBUTING.md");
const sop = join(repoRoot, "docs/dogfood-cycle-sop.md");
const retainedEvidence = "防 page-side 缓存漂移，0008 实证";
const lockedClaims = [
  { file: contributing, claims: ["only one Chrome instance"] },
  { file: sop, claims: ["无法并发", "浏览器串行铁律"] },
];

describe("documentation source lock", () => {
  it("does not retain the invalid single-browser claims", async () => {
    expect(await scanFiles(lockedClaims)).toEqual([]);
  });

  it("retains the 0008 page-side cache evidence", async () => {
    expect(await readFile(sop, "utf8")).toContain(retainedEvidence);
  });

  it("reports a forbidden claim in a fixture", () => {
    expect(scanSources([{ file: "fixture", source: "only one Chrome instance" }], ["only one Chrome instance"]))
      .toEqual(["fixture: only one Chrome instance"]);
  });
});

async function scanFiles(files: Array<{ file: string; claims: string[] }>): Promise<string[]> {
  return (await Promise.all(files.map(async ({ file, claims }) => ({
    claims,
    file,
    source: await readFile(file, "utf8"),
  })))).flatMap(({ claims, file, source }) => scanSources([{ file, source }], claims));
}

function scanSources(sources: Array<{ file: string; source: string }>, claims: string[]): string[] {
  return sources.flatMap(({ file, source }) =>
    claims.filter((claim) => source.includes(claim)).map((claim) => `${file}: ${claim}`),
  );
}

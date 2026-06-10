import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = readFileSync(
  fileURLToPath(new URL("../src/server.ts", import.meta.url)),
  "utf8",
);

describe("server compact 分支用树渲染", () => {
  it("imports and calls renderObserveTree in the compact branch", () => {
    expect(src).toMatch(/renderObserveTree/);
    const compactBlock = src.slice(src.indexOf('detail === "compact"'));
    expect(compactBlock).toMatch(/renderObserveTree\(/);
  });
});

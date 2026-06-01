import { describe, it, expect } from "vitest";
import { extractDiscrepancies, selfTestPassed } from "../src/runner/fuzz-run.js";
import type { FixtureScanResult } from "../src/scan-types.js";

function mkScan(findings: FixtureScanResult["findings"]): FixtureScanResult {
  return {
    fixture: "fuzz-1", pattern: "fuzz", path: "/p.html",
    recall: { matched: 0, expected: 0 }, precision: { matchedNoise: 0, emitted: 0 },
    invariants: { inv1: true, inv2: true, inv3: true, inv4: true },
    findings,
  };
}

describe("extractDiscrepancies", () => {
  it("maps recall-miss → structural, name-mismatch → name", () => {
    const scan = mkScan([
      { severity: "P0", kind: "recall-miss", fixture: "f", pattern: "p", detail: "漏", oracleId: "p1" },
      { severity: "P1", kind: "name-mismatch", fixture: "f", pattern: "p", detail: "名", oracleId: "p2" },
    ]);
    const fs = extractDiscrepancies(7, scan);
    expect(fs.find((f) => f.kind === "recall-miss")!.cls).toBe("structural");
    expect(fs.find((f) => f.kind === "name-mismatch")!.cls).toBe("name");
    expect(fs.every((f) => f.seed === 7)).toBe(true);
  });

  it("ignores invariant findings (only recall/precision/name)", () => {
    const scan = mkScan([
      { severity: "P1", kind: "inv1-instability", fixture: "f", pattern: "p", detail: "x" },
    ]);
    expect(extractDiscrepancies(1, scan)).toHaveLength(0);
  });
});

describe("selfTestPassed", () => {
  it("true when no structural findings across solo scans", () => {
    expect(selfTestPassed([mkScan([]), mkScan([])])).toBe(true);
  });
  it("false when any solo scan has a structural finding", () => {
    const bad = mkScan([{ severity: "P0", kind: "recall-miss", fixture: "f", pattern: "p", detail: "x" }]);
    expect(selfTestPassed([mkScan([]), bad])).toBe(false);
  });
});

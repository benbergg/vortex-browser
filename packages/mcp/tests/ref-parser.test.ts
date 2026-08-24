import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  parseRef,
  resolveTargetParam,
  getBareRefStats,
  _resetBareRefStats,
} from "../src/lib/ref-parser.js";

describe("parseRef", () => {
  it("@e3 → { index: 3, frameId: 0 }", () => {
    expect(parseRef("@e3")).toEqual({ kind: "ref", index: 3, frameId: 0 });
  });
  it("@f1e2 → { index: 2, frameId: 1 }", () => {
    expect(parseRef("@f1e2")).toEqual({ kind: "ref", index: 2, frameId: 1 });
  });
  it("@f12e345 → { index: 345, frameId: 12 }", () => {
    expect(parseRef("@f12e345")).toEqual({ kind: "ref", index: 345, frameId: 12 });
  });
  it("CSS selector 原样返回", () => {
    expect(parseRef("#my-btn")).toEqual({ kind: "selector", selector: "#my-btn" });
    expect(parseRef(".btn.primary")).toEqual({ kind: "selector", selector: ".btn.primary" });
  });
  it("空串抛错", () => {
    expect(() => parseRef("")).toThrow();
  });
  it("@ 开头但格式错误抛错", () => {
    expect(() => parseRef("@x3")).toThrow(/invalid ref format/i);
    expect(() => parseRef("@e")).toThrow();
    expect(() => parseRef("@f1")).toThrow();
  });
  // Regression: descriptor target object → friendly INVALID_PARAMS, not raw TypeError
  // Repro: agent passes target={role:"textbox", name:"密码"} → schema dist still ad-
  // vertised the old object form, runtime crashed with `input.startsWith is not a
  // function`. Source schema has since been narrowed to string-only; this guards
  // against any client (or stale schema cache) still sending a non-string target.
  it("非字符串输入 → INVALID_PARAMS（防 input.startsWith 崩溃）", () => {
    expect(() => parseRef({ role: "textbox", name: "密码" } as never)).toThrow(
      /target must be a string/i,
    );
    expect(() => parseRef(123 as never)).toThrow(/target must be a string/i);
    expect(() => parseRef(true as never)).toThrow(/target must be a string/i);
  });
  // Regression: v0.6 dogfood run 1 (2026-05-01) — LLM emitted "snap_xxx#54"
  // (v0.5 habit) and parseRef silently treated it as a CSS selector. The raw
  // string then hit document.querySelector inside page-side actionability,
  // throwing SyntaxError; chrome.scripting returned a nullish result and
  // `.ok` access surfaced as JS_EXECUTION_ERROR("Cannot read properties of
  // null (reading 'ok')"). Pre-flight reject these shapes with a clear
  // migration message instead.
  it("v0.5 风格 snap_xxx#N → INVALID_PARAMS 含 @eN 提示", () => {
    expect(() => parseRef("snap_momm8049_1#54")).toThrow(/v0\.5 snapshot reference/i);
    expect(() => parseRef("snap_abc#3")).toThrow(/@eN/);
  });
  it("v0.5 风格纯 #N / 纯数字 → 同样拒绝", () => {
    expect(() => parseRef("#54")).toThrow(/v0\.5 snapshot reference/i);
    expect(() => parseRef("54")).toThrow(/v0\.5 snapshot reference/i);
  });
  it("CSS id 选择器（非纯数字）依旧通过", () => {
    expect(parseRef("#my-btn")).toEqual({ kind: "selector", selector: "#my-btn" });
    expect(parseRef("#btn-3a")).toEqual({ kind: "selector", selector: "#btn-3a" });
  });
});

describe("parseRef — hashed dual-format (v0.8)", () => {
  it("parses bare ref @eN (legacy)", () => {
    expect(parseRef("@e12")).toEqual({ kind: "ref", index: 12, frameId: 0 });
  });

  it("parses bare ref with frame @fNeM (legacy)", () => {
    expect(parseRef("@f3e12")).toEqual({ kind: "ref", index: 12, frameId: 3 });
  });

  it("parses hashed ref @<hash>:eN", () => {
    expect(parseRef("@a3f7:e12")).toEqual({
      kind: "ref",
      index: 12,
      frameId: 0,
      hash: "a3f7",
    });
  });

  it("parses hashed ref with frame @<hash>:fNeM", () => {
    expect(parseRef("@a3f7:f3e12")).toEqual({
      kind: "ref",
      index: 12,
      frameId: 3,
      hash: "a3f7",
    });
  });

  it("lowercases an uppercase hash prefix", () => {
    expect(parseRef("@A3F7:e12")).toEqual({
      kind: "ref",
      index: 12,
      frameId: 0,
      hash: "a3f7",
    });
  });

  it("rejects a hash of the wrong length (3 hex)", () => {
    expect(() => parseRef("@abc:e12")).toThrow(/invalid ref format/);
  });

  it("rejects a hash with non-hex chars", () => {
    expect(() => parseRef("@xy12:e12")).toThrow(/invalid ref format/);
  });

  it("rejects a hashed ref missing the colon (`@a3f7e12`)", () => {
    expect(() => parseRef("@a3f7e12")).toThrow(/invalid ref format/);
  });
});

describe("resolveTargetParam", () => {
  it("ref → { index, snapshotId, frameId }", () => {
    const out = resolveTargetParam("@e5", "s_abc", null);
    expect(out).toEqual({ index: 5, snapshotId: "s_abc", frameId: 0 });
  });
  it("跨 frame ref 携带 frameId", () => {
    const out = resolveTargetParam("@f2e7", "s_xyz", null);
    expect(out).toEqual({ index: 7, snapshotId: "s_xyz", frameId: 2 });
  });
  it("selector → { selector }", () => {
    const out = resolveTargetParam(".foo", "s_xyz", null);
    expect(out).toEqual({ selector: ".foo" });
  });
  it("ref 但无活跃 snapshot → 抛 StaleRef", () => {
    expect(() => resolveTargetParam("@e1", null, null)).toThrow(/no active snapshot/i);
  });
});

describe("resolveTargetParam — hash strict check (v0.8)", () => {
  it("matches a hashed ref against activeSnapshotHash", () => {
    expect(resolveTargetParam("@a3f7:e1", "s_xyz", "a3f7")).toEqual({
      index: 1,
      snapshotId: "s_xyz",
      frameId: 0,
    });
  });

  it("rejects a hashed ref when hash mismatches", () => {
    expect(() => resolveTargetParam("@a3f7:e1", "s_xyz", "b2c8")).toThrow(
      /Ref bound to expired snapshot/,
    );
  });

  it("passes a bare ref through unchanged (legacy compat)", () => {
    expect(resolveTargetParam("@e1", "s_xyz", "b2c8")).toEqual({
      index: 1,
      snapshotId: "s_xyz",
      frameId: 0,
    });
  });

  it("hashed ref + no activeSnapshotId throws STALE_SNAPSHOT", () => {
    expect(() => resolveTargetParam("@a3f7:e1", null, null)).toThrow(
      /no active snapshot/,
    );
  });

  it("hashed ref against null activeSnapshotHash → mismatch", () => {
    // Theoretically impossible once Task 4 wires id+hash together, but the
    // function contract today allows the caller to pass (snapshotId, null);
    // lock in the strict-check behavior in that state.
    expect(() => resolveTargetParam("@a3f7:e1", "s_xyz", null)).toThrow(
      /Ref bound to expired snapshot/,
    );
  });

  it("matches a hashed ref with frame prefix", () => {
    expect(resolveTargetParam("@a3f7:f3e1", "s_xyz", "a3f7")).toEqual({
      index: 1,
      snapshotId: "s_xyz",
      frameId: 3,
    });
  });
});

describe("resolveTargetParam — query producer 后拒绝裸 ref", () => {
  it("query producer 已登记时拒绝裸 ref，并提示带 hash 或重新 observe", () => {
    expect(() => resolveTargetParam("@e1", "s_xyz", "a3f7", undefined, undefined, true)).toThrow(
      /hash|observe/i,
    );
  });

  it("没有 query producer 时保留 observe-only 裸 ref 兼容行为", () => {
    expect(resolveTargetParam("@e1", "s_xyz", "a3f7", undefined, undefined, false)).toEqual({
      index: 1,
      snapshotId: "s_xyz",
      frameId: 0,
    });
  });
});

describe("resolveTargetParam — bare-ref deprecation telemetry (v0.8 → v0.9)", () => {
  beforeEach(() => {
    _resetBareRefStats();
  });

  it("bare ref increments the counter", () => {
    resolveTargetParam("@e1", "s_xyz", "a3f7");
    expect(getBareRefStats().hits).toBe(1);
  });

  it("counter accumulates across calls", () => {
    resolveTargetParam("@e1", "s_xyz", "a3f7");
    resolveTargetParam("@f2e3", "s_xyz", "a3f7");
    resolveTargetParam("@e5", "s_xyz", "a3f7");
    expect(getBareRefStats().hits).toBe(3);
  });

  it("hashed ref does not increment the counter", () => {
    resolveTargetParam("@a3f7:e1", "s_xyz", "a3f7");
    resolveTargetParam("@a3f7:f2e3", "s_xyz", "a3f7");
    expect(getBareRefStats().hits).toBe(0);
  });

  it("plain selector does not increment the counter", () => {
    resolveTargetParam(".foo", "s_xyz", "a3f7");
    expect(getBareRefStats().hits).toBe(0);
  });

  it("firstSeenAt is set on the first bare hit and stays stable", () => {
    expect(getBareRefStats().firstSeenAt).toBeNull();
    resolveTargetParam("@e1", "s_xyz", "a3f7");
    const first = getBareRefStats().firstSeenAt;
    expect(first).not.toBeNull();
    resolveTargetParam("@e2", "s_xyz", "a3f7");
    expect(getBareRefStats().firstSeenAt).toBe(first);
  });

  it("stderr deprecation warn fires exactly once per session", () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      resolveTargetParam("@e1", "s_xyz", "a3f7");
      resolveTargetParam("@e2", "s_xyz", "a3f7");
      resolveTargetParam("@f2e3", "s_xyz", "a3f7");
      const bareRefWarns = writeSpy.mock.calls.filter(
        (c) => typeof c[0] === "string" && (c[0] as string).includes("bare ref"),
      );
      expect(bareRefWarns).toHaveLength(1);
      expect(bareRefWarns[0][0]).toContain("deprecated");
      expect(bareRefWarns[0][0]).toContain("@e1");
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("counter still increments even when activeSnapshotId is null (call throws after recording)", () => {
    expect(() => resolveTargetParam("@e1", null, null)).toThrow();
    expect(getBareRefStats().hits).toBe(1);
  });
});

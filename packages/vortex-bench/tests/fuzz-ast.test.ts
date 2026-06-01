import { describe, it, expect } from "vitest";
import { renderHtml, deriveManifest } from "../src/runner/fuzz-ast.js";
import type { FuzzPage } from "../src/fuzz-types.js";

const page: FuzzPage = {
  seed: 1,
  root: {
    type: "noise", tag: "div", className: "n0",
    children: [
      { type: "primitive", kind: "native-button", id: "p1", name: "保存" },
      { type: "noise", tag: "div", className: "n1", hidden: "display-none", children: [
        { type: "primitive", kind: "cursor-pointer-div", id: "p2", name: "菜单" },
      ]},
      { type: "primitive", kind: "srcdoc-button", id: "p3", name: "子框" },
    ],
  },
};

describe("fuzz-ast renderHtml", () => {
  it("emits doctype + every primitive's data-vtx-oracle id", () => {
    const html = renderHtml(page);
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('data-vtx-oracle="p1"');
    expect(html).toContain('data-vtx-oracle="p2"');
    expect(html).toContain('data-vtx-oracle="p3"');
  });
  it("native-button renders a <button>; cursor div has cursor:pointer", () => {
    const html = renderHtml(page);
    expect(html).toMatch(/<button[^>]*data-vtx-oracle="p1"[^>]*>保存<\/button>/);
    expect(html).toMatch(/cursor:pointer/);
  });
  it("srcdoc-button renders an <iframe srcdoc>", () => {
    const html = renderHtml(page);
    expect(html).toMatch(/<iframe[^>]*srcdoc=/);
  });
});

describe("fuzz-ast deriveManifest", () => {
  it("one interactive entry per primitive, with expectedName", () => {
    const m = deriveManifest(page, "fuzz-abc", "/synth/.fuzz-tmp/1.html");
    expect(m.fixture).toBe("fuzz-abc");
    expect(m.path).toBe("/synth/.fuzz-tmp/1.html");
    const ids = m.entries.map((e) => e.id).sort();
    expect(ids).toEqual(["p1", "p2", "p3"]);
    expect(m.entries.every((e) => e.interactive !== undefined)).toBe(true);
    const p1 = m.entries.find((e) => e.id === "p1")!;
    expect(p1.expectedName).toBe("保存");
    expect(p1.interactive).toBe(true);
  });
  it("hidden subtree primitive → interactive:false", () => {
    const m = deriveManifest(page, "fuzz-abc", "/synth/.fuzz-tmp/1.html");
    const p2 = m.entries.find((e) => e.id === "p2")!; // under display-none
    expect(p2.interactive).toBe(false);
  });
  it("srcdoc primitive sets joinBy:name and frames:all-same-origin", () => {
    const m = deriveManifest(page, "fuzz-abc", "/synth/.fuzz-tmp/1.html");
    expect(m.frames).toBe("all-same-origin");
    const p3 = m.entries.find((e) => e.id === "p3")!;
    expect(p3.joinBy).toBe("name");
  });
  it("page with no srcdoc keeps frames main", () => {
    const noSrcdoc: FuzzPage = { seed: 2, root: { type: "noise", tag: "div", className: "n", children: [
      { type: "primitive", kind: "native-button", id: "x", name: "X" },
    ]}};
    const m = deriveManifest(noSrcdoc, "f", "/p.html");
    expect(m.frames).toBe("main");
  });
  it("aria-hidden wrapper does NOT make primitive non-interactive (still clickable)", () => {
    const ariaPage: FuzzPage = { seed: 3, root: { type: "noise", tag: "div", className: "n", children: [
      { type: "noise", tag: "div", className: "ah", hidden: "aria-hidden", children: [
        { type: "primitive", kind: "native-button", id: "ah1", name: "提交" },
      ]},
      { type: "noise", tag: "div", className: "dn", hidden: "display-none", children: [
        { type: "primitive", kind: "native-button", id: "dn1", name: "隐藏" },
      ]},
    ]}};
    const m = deriveManifest(ariaPage, "f", "/p.html");
    expect(m.entries.find((e) => e.id === "ah1")!.interactive).toBe(true);   // aria-hidden 仍可点
    expect(m.entries.find((e) => e.id === "dn1")!.interactive).toBe(false);  // display:none 真非交互
  });
});

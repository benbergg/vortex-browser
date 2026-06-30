// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { styleProbeFunc } from "../src/handlers/query.js";

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("styleProbeFunc", () => {
  it("自身有色+背景 → 取 color/background + WCAG 对比度(黑底白≈21)", () => {
    const el = document.createElement("div");
    el.className = "t";
    el.style.color = "rgb(0, 0, 0)";
    el.style.backgroundColor = "rgb(255, 255, 255)";
    el.textContent = "x";
    document.body.appendChild(el);
    const r = styleProbeFunc(".t", 10) as any;
    expect(r.elements[0].color).toBe("rgb(0, 0, 0)");
    expect(r.elements[0].background).toBe("rgb(255, 255, 255)");
    expect(r.elements[0].contrastRatio).toBeCloseTo(21, 0);
    expect(r.elements[0].wcagAA).toBe(true);
  });

  it("自身背景透明 → 上溯祖先 painted bg(⑦ 徽章背景在祖先)", () => {
    const wrap = document.createElement("div");
    wrap.style.backgroundColor = "rgb(255, 255, 255)";
    const el = document.createElement("span");
    el.className = "t2";
    el.style.color = "rgb(0, 0, 0)";
    // 自身背景不设(透明)
    wrap.appendChild(el);
    document.body.appendChild(wrap);
    const r = styleProbeFunc(".t2", 10) as any;
    expect(r.elements[0].background).toBe("rgb(255, 255, 255)");
    expect(r.elements[0].bgFromAncestor).toBe(true);
  });

  it("低对比(浅灰字白底) → wcagAA=false", () => {
    const el = document.createElement("div");
    el.className = "t3";
    el.style.color = "rgb(200, 200, 200)";
    el.style.backgroundColor = "rgb(255, 255, 255)";
    document.body.appendChild(el);
    const r = styleProbeFunc(".t3", 10) as any;
    expect(r.elements[0].wcagAA).toBe(false);
  });

  it("含字重/字号字段", () => {
    const el = document.createElement("div");
    el.className = "t4";
    el.style.color = "rgb(0, 0, 0)";
    el.style.backgroundColor = "rgb(255, 255, 255)";
    el.style.fontWeight = "700";
    document.body.appendChild(el);
    const r = styleProbeFunc(".t4", 10) as any;
    expect(r.elements[0].fontWeight).toBe("700");
  });

  it("无命中 → total=0", () => {
    const r = styleProbeFunc(".none", 10) as any;
    expect(r.total).toBe(0);
    expect(r.elements).toEqual([]);
  });
});

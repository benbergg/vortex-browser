// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { geometryProbeFunc } from "../src/handlers/query.js";

/** stub getBoundingClientRect。 */
function rect(el: Element, x: number, y: number, w: number, h: number) {
  Object.defineProperty(el, "getBoundingClientRect", {
    value: () => ({ x, y, left: x, top: y, right: x + w, bottom: y + h, width: w, height: h, toJSON() {} }),
    configurable: true,
  });
  return el as HTMLElement;
}
/** stub scrollWidth/clientWidth(文字 ellipsis 检测)。 */
function scrollDims(el: Element, scrollW: number, clientW: number) {
  Object.defineProperty(el, "scrollWidth", { value: scrollW, configurable: true });
  Object.defineProperty(el, "clientWidth", { value: clientW, configurable: true });
}

beforeEach(() => {
  document.body.innerHTML = "";
  Object.defineProperty(window, "innerWidth", { value: 1000, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
});
afterEach(() => {
  // 还原 elementFromPoint
  (document as any).elementFromPoint = undefined;
});

describe("geometryProbeFunc", () => {
  it("元素完整在视口内 → inViewport=true,未遮挡", () => {
    const el = rect(document.createElement("div"), 100, 100, 200, 50);
    el.className = "card";
    document.body.appendChild(el);
    (document as any).elementFromPoint = () => el; // 中心点命中自身
    const r = geometryProbeFunc(".card", 10) as any;
    expect(r.elements[0].inViewport).toBe(true);
    expect(r.elements[0].occluded).toBe(false);
    expect(r.elements[0].bbox).toEqual([100, 100, 200, 50]);
  });

  it("元素超出视口右下 → inViewport=false", () => {
    const el = rect(document.createElement("div"), 900, 100, 200, 50); // right=1100>1000
    el.className = "wide";
    document.body.appendChild(el);
    (document as any).elementFromPoint = () => el;
    const r = geometryProbeFunc(".wide", 10) as any;
    expect(r.elements[0].inViewport).toBe(false);
  });

  it("中心点被浮层遮挡 → occluded=true", () => {
    const el = rect(document.createElement("div"), 100, 100, 200, 50);
    el.className = "target";
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    document.body.append(el, overlay);
    (document as any).elementFromPoint = () => overlay; // 中心点命中 overlay(非自身/后代)
    const r = geometryProbeFunc(".target", 10) as any;
    expect(r.elements[0].occluded).toBe(true);
    expect(r.elements[0].occludedBy).toContain("overlay");
  });

  it("中心点命中自身后代 → 不算遮挡(occluded=false)", () => {
    const el = rect(document.createElement("div"), 100, 100, 200, 50);
    el.className = "target";
    const child = document.createElement("span");
    el.appendChild(child);
    document.body.appendChild(el);
    (document as any).elementFromPoint = () => child; // 后代,非遮挡
    const r = geometryProbeFunc(".target", 10) as any;
    expect(r.elements[0].occluded).toBe(false);
  });

  it("文字 ellipsis 截断(scrollWidth>clientWidth)但未被祖先裁剪 → textClipped=true / clippedByAncestor=false", () => {
    const el = rect(document.createElement("div"), 100, 100, 120, 30);
    el.className = "cell";
    scrollDims(el, 300, 120); // 内容 300 > 可视 120 → ellipsis
    document.body.appendChild(el);
    (document as any).elementFromPoint = () => el;
    const r = geometryProbeFunc(".cell", 10) as any;
    expect(r.elements[0].textClipped).toBe(true);
    expect(r.elements[0].clippedByAncestor).toBe(false);
  });

  it("两元素重叠 + a 在 b 上方判定", () => {
    const a = rect(document.createElement("div"), 100, 100, 200, 50); // bottom=150
    a.className = "g";
    const b = rect(document.createElement("div"), 100, 100, 200, 50); // 完全重叠
    b.className = "g";
    document.body.append(a, b);
    (document as any).elementFromPoint = () => a;
    const r = geometryProbeFunc(".g", 10) as any;
    expect(r.pair.overlap).toBe(true);
    expect(r.pair.sameLeft).toBe(true);
    expect(r.pair.sameTop).toBe(true);
  });

  it("两元素左对齐 + a 在 b 正上方(不重叠)", () => {
    const a = rect(document.createElement("div"), 100, 100, 200, 40); // bottom=140
    a.className = "h";
    const b = rect(document.createElement("div"), 100, 200, 200, 40); // top=200 > a.bottom
    b.className = "h";
    document.body.append(a, b);
    (document as any).elementFromPoint = () => a;
    const r = geometryProbeFunc(".h", 10) as any;
    expect(r.pair.overlap).toBe(false);
    expect(r.pair.aAboveB).toBe(true);
    expect(r.pair.sameLeft).toBe(true);
  });

  it("选择器无命中 → total=0,无 pair", () => {
    const r = geometryProbeFunc(".none", 10) as any;
    expect(r.total).toBe(0);
    expect(r.pair).toBeUndefined();
  });
});

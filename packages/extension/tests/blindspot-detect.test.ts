// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { detectBlindspot } from "../src/page-side/blindspot-detect.js";

function withRect(el: Element, width: number, height: number) {
  Object.defineProperty(el, "getBoundingClientRect", {
    value: () => ({ width, height, x: 0, y: 0, top: 0, left: 0, right: width, bottom: height }),
    configurable: true,
  });
  return el as HTMLElement;
}

describe("detectBlindspot", () => {
  it("aria-rowcount 远大于渲染行 → virtual", () => {
    document.body.innerHTML = `<div role="grid" aria-rowcount="1000">${"<div role='row'></div>".repeat(32)}</div>`;
    const grid = document.querySelector("[role=grid]")!;
    expect(detectBlindspot(grid as HTMLElement, 32)).toEqual({ kind: "virtual", total: 1000, rendered: 32 });
  });
  it("短列表 rowcount≈渲染 → 不报（负例）", () => {
    document.body.innerHTML = `<div role="grid" aria-rowcount="5">${"<div role='row'></div>".repeat(5)}</div>`;
    expect(detectBlindspot(document.querySelector("[role=grid]") as HTMLElement, 5)).toBeNull();
  });
  it("listbox aria-setsize 远大于渲染 → virtual", () => {
    document.body.innerHTML = `<div role="listbox" aria-setsize="500"></div>`;
    expect(detectBlindspot(document.querySelector("[role=listbox]") as HTMLElement, 10)).toEqual({ kind: "virtual", total: 500, rendered: 10 });
  });
  it("大尺寸 canvas → canvas", () => {
    document.body.innerHTML = `<canvas></canvas>`;
    const c = withRect(document.querySelector("canvas")!, 800, 600);
    expect(detectBlindspot(c, 0)).toEqual({ kind: "canvas" });
  });
  it("装饰性小 canvas(sparkline) → 不报（负例）", () => {
    document.body.innerHTML = `<canvas></canvas>`;
    const c = withRect(document.querySelector("canvas")!, 40, 16);
    expect(detectBlindspot(c, 0)).toBeNull();
  });
  it("自定义元素无可观察后代 → shadow 低置信", () => {
    document.body.innerHTML = `<x-widget></x-widget>`;
    const w = withRect(document.querySelector("x-widget")!, 200, 80);
    expect(detectBlindspot(w, 0)).toEqual({ kind: "shadow", confidence: "low" });
  });
  it("自定义元素有可观察后代 → 不报（负例,open shadow 已穿）", () => {
    document.body.innerHTML = `<x-widget></x-widget>`;
    const w = withRect(document.querySelector("x-widget")!, 200, 80);
    expect(detectBlindspot(w, 3)).toBeNull();
  });
  it("普通 div → 不报（负例）", () => {
    document.body.innerHTML = `<div>hi</div>`;
    expect(detectBlindspot(withRect(document.querySelector("div")!, 100, 40), 0)).toBeNull();
  });
});

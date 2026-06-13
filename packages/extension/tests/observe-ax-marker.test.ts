import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { STAMP_MARKERS, CLEAR_MARKERS } from "../src/handlers/observe-ax-overlay.js";

describe("data-vtx-ax marker", () => {
  it("STAMP_MARKERS 给元素按下标打 data-vtx-ax", () => {
    const dom = new JSDOM(`<button>a</button><a href="#">b</a>`);
    const els = [...dom.window.document.querySelectorAll("button,a")];
    STAMP_MARKERS(els as Element[]);
    expect(els[0].getAttribute("data-vtx-ax")).toBe("0");
    expect(els[1].getAttribute("data-vtx-ax")).toBe("1");
  });
  it("CLEAR_MARKERS 清掉所有 data-vtx-ax", () => {
    const dom = new JSDOM(`<button data-vtx-ax="0">a</button>`);
    CLEAR_MARKERS(dom.window.document);
    expect(dom.window.document.querySelector("[data-vtx-ax]")).toBeNull();
  });
});

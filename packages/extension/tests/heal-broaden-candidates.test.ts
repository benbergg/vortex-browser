import { describe, it, expect, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { __healInlineBody } from "../src/action/heal.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const inlineMatch = new Function(
  "candidates", "desc",
  `${__healInlineBody}; return __inlineMatch(candidates, desc);`,
) as (c: Element[], d: { role?: string; name: string }) => { kind: string; el?: Element };

describe("B1 heal 候选集放宽:裸单元格可被名字命中", () => {
  beforeEach(() => {
    const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
    (globalThis as any).document = dom.window.document;
    (globalThis as any).Element = dom.window.Element;
  });
  function el(html: string): Element {
    const d = document.createElement("div");
    d.innerHTML = html;
    return d.firstElementChild!;
  }
  it("窄选择器集捞不到裸 td(无 role/onclick/tabindex)", () => {
    const narrow = "a,button,input,select,textarea,[role],[onclick],[tabindex]";
    const wrap = el(`<table><tr><td>订单 A123</td></tr></table>`);
    document.body.appendChild(wrap);
    expect(document.querySelectorAll(narrow).length).toBe(0);
  });
  it("宽集含 td → 内联匹配体按可访问名唯一命中", () => {
    const wrap = el(`<table><tr><td>订单 A123</td><td>订单 B456</td></tr></table>`);
    document.body.appendChild(wrap);
    const broad = Array.from(document.querySelectorAll("a,button,input,select,textarea,[role],[onclick],[tabindex],td,th,li,[class]"));
    const r = inlineMatch(broad, { name: "订单 A123" });
    expect(r.kind).toBe("unique");
  });
});

const HEAL_SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "src", "action", "heal.ts"), "utf8");
describe("B1 heal.ts 候选集源码契约", () => {
  it("零命中时回退宽集(含 td)", () => {
    expect(HEAL_SRC).toMatch(/r\.kind\s*===\s*"none"/);
    expect(HEAL_SRC).toMatch(/td,th,li/);
  });
});

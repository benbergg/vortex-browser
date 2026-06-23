// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * getAccessibleName 末位兜底用 textContent(绕 text-overflow:ellipsis 截断),副作用是把
 * visibility:hidden 的镜像文本也拼进名。Radix header「hover-swap」用 visible + visibility:hidden
 * 两份同文 span → "ThemesThemes";平时 AX overlay(CDP 正确排除 hidden)盖住,但 Select/Dialog
 * 打开等致 AX overlay 跳过、回退本启发式时叠字暴露(2026-06-23 radix-ui.com Select-open dogfood,
 * live 复证)。visibleTextContent 排除 visibility:hidden/display:none 子树(对齐 ACCNAME 规范),
 * 但保留 visibility:visible 元素被 ellipsis 裁剪的文本。
 *
 * scan 内联于 executeScript,source-lock 守护关键契约;行为用 jsdom 复刻函数直测。
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const OBSERVE_SRC = readFileSync(
  join(__dirname, "..", "src", "handlers", "observe.ts"),
  "utf8",
);

describe("visibleTextContent source-lock(排除 visibility:hidden/display:none 子树)", () => {
  it("定义 visibleTextContent helper", () => {
    expect(OBSERVE_SRC).toMatch(/const visibleTextContent = \(el: Element\): string =>/);
  });

  it("叶子(无子元素)走 textContent 快路径", () => {
    expect(OBSERVE_SRC).toMatch(/if \(el\.childElementCount === 0\) return el\.textContent \?\? "";/);
  });

  it("排除 visibility:hidden / display:none 子树", () => {
    expect(OBSERVE_SRC).toMatch(
      /if \(cs\.visibility === "hidden" \|\| cs\.display === "none"\) continue;/,
    );
  });

  it("perf 双 early-exit:文本超 96 或访问超 250 节点即停", () => {
    expect(OBSERVE_SRC).toMatch(/if \(out\.length > 96 \|\| count > 250\) return;/);
  });

  it("名提取末位兜底改用 visibleTextContent(叠字修复点)", () => {
    expect(OBSERVE_SRC).toMatch(/const text = normName\(visibleTextContent\(el\)\);/);
  });

  it("checkbox/radio 包裹 label 文本也用 visibleTextContent", () => {
    expect(OBSERVE_SRC).toMatch(/const labelText = normName\(visibleTextContent\(el\)\);/);
  });
});

// jsdom 行为复刻(与 observe.ts 内联体同语义;source-lock 守护对齐)。
function visibleTextContent(el: Element): string {
  if (el.childElementCount === 0) return el.textContent ?? "";
  let out = "";
  let count = 0;
  const visit = (node: Node): void => {
    const kids = node.childNodes;
    for (let i = 0; i < kids.length; i++) {
      if (out.length > 96 || count > 250) return;
      const child = kids[i];
      if (child.nodeType === 3) {
        out += child.nodeValue || "";
        continue;
      }
      if (child.nodeType !== 1) continue;
      count++;
      const cs = getComputedStyle(child as Element);
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      visit(child);
    }
  };
  visit(el);
  return out;
}

describe("visibleTextContent 行为(jsdom)", () => {
  it("Radix hover-swap:visible + visibility:hidden 同文 span → 不叠字", () => {
    const a = document.createElement("a");
    a.innerHTML =
      '<span style="visibility:visible">Themes</span>' +
      '<span style="visibility:hidden">Themes</span>';
    expect(visibleTextContent(a).replace(/\s+/g, " ").trim()).toBe("Themes");
  });

  it("display:none 子树文本被排除", () => {
    const div = document.createElement("div");
    div.innerHTML = 'Save<span style="display:none">(hidden tip)</span>';
    expect(visibleTextContent(div).replace(/\s+/g, " ").trim()).toBe("Save");
  });

  it("全可见多 span 文本保留(无误删)", () => {
    const div = document.createElement("div");
    div.innerHTML = "<span>Hello</span> <span>World</span>";
    expect(visibleTextContent(div).replace(/\s+/g, " ").trim()).toBe("Hello World");
  });

  it("叶子元素走快路径返回 textContent", () => {
    const b = document.createElement("button");
    b.textContent = "Click me";
    expect(visibleTextContent(b)).toBe("Click me");
  });

  it("visibility:visible 元素文本保留(ellipsis 场景:元素可见仅被裁剪)", () => {
    // text-overflow:ellipsis 不改 computed visibility(仍 visible)→ 文本保留,
    // 这是当初用 textContent 而非 innerText 的初衷,本函数不回退该行为。
    const cell = document.createElement("div");
    cell.setAttribute(
      "style",
      "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;width:10px;visibility:visible",
    );
    cell.textContent = "A very long cell value that gets clipped";
    expect(visibleTextContent(cell)).toBe("A very long cell value that gets clipped");
  });
});

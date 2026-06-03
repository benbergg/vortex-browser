import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * 回归锁:act 原语白盒审计批次 2 —— 族 A(silent false-success)。统一处方:赋值/驱动
 * 类原语必须回读校验副作用真发生,不能 dispatch 即返回 success。page-side inline func
 * 跑在 executeScript 内不可 import,用 source-grep 守护;真实行为由 live 验证(报告 §25)。
 * 2026-06-03 act 原语白盒审计。
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const DOM_SRC = readFileSync(join(__dirname, "../src/handlers/dom.ts"), "utf8");
const KEYBOARD_SRC = readFileSync(
  join(__dirname, "../src/handlers/keyboard.ts"),
  "utf8",
);
const SELECT_DRIVER_SRC = readFileSync(
  join(__dirname, "../src/page-side/commit-drivers/select.ts"),
  "utf8",
);

describe("族 A #18/#19 — SCROLL 回读位置 + instant behavior", () => {
  it("SCROLL 用 behavior:auto(instant)而非 smooth", () => {
    // 不再有 behavior:"smooth"(异步未完成即返回);doScroll 强制 auto。
    expect(DOM_SRC).not.toMatch(/scrollIntoView\(\{ behavior: "smooth"/);
    expect(DOM_SRC).toMatch(/behavior: "auto"/);
  });

  it("SCROLL 回读 scrollTop/Left 前后差,返回 moved", () => {
    expect(DOM_SRC).toMatch(/const readPos = /);
    expect(DOM_SRC).toMatch(/moved:[\s\S]{0,120}Math\.abs\(after\.top - before\.top\)/);
  });

  it("scrollIntoView 路径回读元素 rect 判断 moved + inView", () => {
    expect(DOM_SRC).toMatch(/const beforeTop = el\.getBoundingClientRect\(\)\.top/);
    expect(DOM_SRC).toMatch(/moved: Math\.abs\(afterRect\.top - beforeTop\) > 1/);
  });
});

describe("族 A #7 — FILL number/date 非法值回读报 NO_EFFECT", () => {
  it("fill 写值后回读 el.value,非空输入→空结果报 NO_EFFECT", () => {
    expect(DOM_SRC).toMatch(
      /String\(val\) !== "" && \(el as HTMLInputElement\)\.value === ""/,
    );
    const idx = DOM_SRC.indexOf('String(val) !== "" && (el as HTMLInputElement).value === ""');
    const block = DOM_SRC.slice(idx, idx + 300);
    expect(block).toMatch(/errorCode:\s*"NO_EFFECT"/);
  });

  it("回读在 dispatch input/change 之后(确保框架已处理)", () => {
    const dispatchIdx = DOM_SRC.indexOf('el.dispatchEvent(new Event("change", { bubbles: true }));\n            // 回读');
    expect(dispatchIdx).toBeGreaterThan(-1);
  });
});

describe("族 A #20 — el-select COMMIT verify 最终态", () => {
  it("回读触发器显示文本校验每个 label 已反映", () => {
    expect(SELECT_DRIVER_SRC).toMatch(/wrapper\.innerText/);
    expect(SELECT_DRIVER_SRC).toMatch(/notReflected = labels\.filter/);
  });

  it("优先读独立已选项元素(tag/selected-item)做精确匹配避免子串误判(评审 M2)", () => {
    expect(SELECT_DRIVER_SRC).toMatch(/\.el-tag, \.el-select__selected-item/);
    expect(SELECT_DRIVER_SRC).toMatch(/itemEls\.length > 0/);
  });

  it("未反映报 COMMIT_FAILED 而非假成功(对照 checkbox-group 范式)", () => {
    const idx = SELECT_DRIVER_SRC.indexOf("if (notReflected.length > 0)");
    expect(idx).toBeGreaterThan(-1);
    const block = SELECT_DRIVER_SRC.slice(idx, idx + 500);
    expect(block).toMatch(/errorCode:\s*"COMMIT_FAILED"/);
    expect(block).toMatch(/stage:\s*"verify"/);
  });
});

describe("族 A #15 — PRESS 回传聚焦元素上下文", () => {
  it("定义 probeFocus 读 document.activeElement", () => {
    expect(KEYBOARD_SRC).toMatch(/async function probeFocus/);
    expect(KEYBOARD_SRC).toMatch(/document\.activeElement/);
  });

  it("body 无聚焦时给出「key may have no effect」提示", () => {
    expect(KEYBOARD_SRC).toMatch(/no element focused — key may have no effect/);
  });

  it("PRESS 两个返回点都带 focusedElement", () => {
    const matches = KEYBOARD_SRC.match(/return \{ success: true, key: expr, focusedElement \}/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(2);
  });
});

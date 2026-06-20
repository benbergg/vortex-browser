import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// SELECT handler 的 option 匹配逻辑跑在 page-side executeScript func 内,不可 import 单测,
// 故用 source-grep 守护回退链与「选不中报错而非假成功」不被回退(2026-06-01 native-select dogfood)。
const __dirname = dirname(fileURLToPath(import.meta.url));
const DOM_SRC = readFileSync(join(__dirname, "../src/handlers/dom.ts"), "utf8");

describe("SELECT handler native <select> option 匹配", () => {
  // 2026-06-03 多选支持把单值匹配抽成 matchOption(one) helper:val→one、target→t,
  // 回退链(value → 可见文本 → label 属性)逻辑不变。
  it("按 value 属性匹配 option", () => {
    expect(DOM_SRC).toMatch(/opts\.find\(\(o\)\s*=>\s*o\.value === one\)/);
  });

  it("回退按可见文本(label)匹配 option", () => {
    expect(DOM_SRC).toMatch(/norm\(o\.text\)\s*===\s*t\b/);
  });

  it("回退按 label 属性匹配 option", () => {
    expect(DOM_SRC).toMatch(/o\.label != null && norm\(o\.label\)\s*===\s*t\b/);
  });

  it("全不中报 NO_MATCHING_OPTION 而非假成功", () => {
    expect(DOM_SRC).toMatch(/errorCode:\s*"NO_MATCHING_OPTION"/);
    // 报错分支带 available 选项清单供 agent 重选
    expect(DOM_SRC).toMatch(/available:\s*opts\.map/);
  });

  it("只在匹配到 option 后才 dispatch change 并返回 success", () => {
    // el.value = opt.value 必须出现在 NO_MATCHING_OPTION 早返回之后
    const idxErr = DOM_SRC.indexOf('errorCode: "NO_MATCHING_OPTION"');
    const idxAssign = DOM_SRC.indexOf("el.value = opt.value");
    expect(idxErr).toBeGreaterThan(-1);
    expect(idxAssign).toBeGreaterThan(idxErr);
  });

  // silent-false-success 护栏回归锁(白盒实机复现,2026-06-20)。
  //
  // 现象:受控/约束 <select> 在 change 监听中把选择 snap-back 还原(如 React 受控
  //   组件拒收、业务约束回弹)。单值路径 `el.value=opt.value` → dispatch change →
  //   读回被还原的 el.value 后无条件 return {success:true},不与意图 opt.value 比对,
  //   对「选了 B 实则回到 A」报假成功。多选路径有 selectedNow 回读(1221),单值漏。
  //
  // 修复:单值 dispatch change 后比对 el.value !== opt.value → NO_EFFECT。option value
  //   是精确值无规范化(不同于 FILL 的自由文本),严格比对无假阳风险。
  it("单值选择 dispatch change 后回读校验,被还原 → NO_EFFECT(非假成功)", () => {
    // change 之后必须有 el.value !== opt.value 的回读守卫,且接 NO_EFFECT。
    const guard = DOM_SRC.match(
      /el\.value = opt\.value[\s\S]*?el\.value\s*!==\s*opt\.value[\s\S]*?errorCode:\s*"NO_EFFECT"/,
    );
    expect(guard).not.toBeNull();
  });
});

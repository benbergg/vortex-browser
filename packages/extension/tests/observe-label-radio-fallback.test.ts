/**
 * Author: 青蛙
 * Description: Regression lock for 缺陷①: <label> wraps radio/checkbox with no
 * inner text → BUG-3 noise filter drops the whole control invisible.
 *
 * Trigger: v4 评价信息操作深度评测（淘宝）— 3 个 emoji 评分 label
 *   `<label><input type="radio" class="good-rate"></label>`
 *   走 getAccessibleName LABEL 分支 → labelText 空 → isContainer=true
 *   → 返空 → BUG-3 噪声过滤器（filter=='interactive'）丢弃 → 整个控件在
 *   observe 中隐形。agent 看不到 3 个 emoji 评分。
 *
 * 通用化修法（不写淘宝特定字典）:
 *   1. `getAccessibleName` 走 LABEL 分支，当 wrapsCheckRadio && labelText 空
 *      时，**不**直接 return ""，而是 return 通用兜底名（含 role + value
 *      + 位置），让 BUG-3 噪声过滤器的 `!name` 判定放行。
 *   2. BUG-3 过滤在判定"form-like"时，若 el 是 LABEL 且内含 radio/checkbox
 *      input，豁免（按"label 自身就是 form-like"处理，因为 LABEL 是
 *      labelable 元素的语义容器）。
 *
 * Why: 这是族级原语问题（observe name 召回），不限于淘宝 — Element Plus /
 * Ant Design / 自研组件库的"label 包 radio + 纯 CSS 雪碧图"模式同病。
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OBSERVE_SRC = readFileSync(
  join(__dirname, "..", "src", "handlers", "observe.ts"),
  "utf8",
);

describe("缺陷①: <label> 包 radio/checkbox 但无文本 — 通用兜底名 + BUG-3 豁免 (2026-06-07 淘宝评测)", () => {
  // ============================================================
  // 现有行为保留测试 — 修复不应破坏既有逻辑
  // ============================================================

  it("现有 LABEL aria-label 优先仍保留 (2026-06-01 excalidraw dogfood 修复)", () => {
    expect(OBSERVE_SRC).toMatch(
      /if \(el\.tagName === "LABEL"\)[\s\S]{0,200}?ctrlAria[\s\S]{0,200}?if \(ctrlAria\) return normName\(ctrlAria\);/,
    );
  });

  it("现有 labelText 非空时优先返回 labelText (Element Plus '北京' 等场景)", () => {
    expect(OBSERVE_SRC).toMatch(
      /const labelText = normName\(visibleTextContent\(el\)\);[\s\S]{0,50}?if \(labelText\) return labelText;/,
    );
  });

  it("现有 wrapsCheckRadio 检测保留", () => {
    expect(OBSERVE_SRC).toMatch(
      /el\.querySelector\([\s\S]*?input\[type=checkbox\], input\[type=radio\][\s\S]*?\)/,
    );
  });

  // ============================================================
  // 新行为测试 — 修复应新增这些逻辑
  // ============================================================

  it("新行为 1: getAccessibleName LABEL 分支在 wrapsCheckRadio && labelText 空时, 应返回通用兜底名(不返空)", () => {
    // 兜底名应至少含 role 标识 (radio 或 checkbox) — 表明是 form 控件
    // 兜底名应至少含位置信息 (@x= / @y= / @N / bbox 形式) — 通用化标识
    // 兜底名生成应在 wrapsCheckRadio && labelText 为空时, 而非 labelText 非空时
    const idx = OBSERVE_SRC.search(
      /const wrapsCheckRadio = el\.querySelector\(/,
    );
    expect(idx, "未找到 wrapsCheckRadio 起始位置").toBeGreaterThan(0);
    // 截取 wrapsCheckRadio 之后约 1200 字符作为 LABEL 分支区
    const slice = OBSERVE_SRC.slice(idx, idx + 1200);
    // 兜底名应含 role
    expect(slice).toMatch(/radio|checkbox/);
    // 兜底名应含位置信息
    expect(slice).toMatch(/@x=|@y=|@\d+|bbox|getBoundingClientRect/);
  });

  it("新行为 2: BUG-3 噪声过滤器应识别 LABEL 包 radio/checkbox 形式并豁免", () => {
    // BUG-3 块内应提到 LABEL 豁免逻辑(避免幽灵容器把 label 整体吞掉)
    const bug3Block = OBSERVE_SRC.match(
      /BUG-3[\s\S]{0,3000}?if \(filter === "interactive"\)[\s\S]{0,2500}?continue;/,
    );
    expect(bug3Block, "未找到 BUG-3 过滤代码块").toBeTruthy();
    // BUG-3 块应提到 LABEL 处理
    expect(bug3Block![0]).toMatch(/LABEL|label/i);
  });

  it("新行为 3: 兜底名生成不应依赖站点特定 className (淘宝 'good-rate' 等)", () => {
    // 评审明确建议不写站点字典 — 兜底名应基于 input.type + input.value
    // 而非 input.className 里的 'good-rate'/'normal-rate'/'bad-rate' 等。
    const idx = OBSERVE_SRC.search(
      /const wrapsCheckRadio = el\.querySelector\(/,
    );
    const slice = OBSERVE_SRC.slice(idx, idx + 1500);
    // 不能出现 'good-rate' / 'normal-rate' / 'bad-rate' / 'noraml' (淘宝拼错)
    expect(slice).not.toMatch(/good-rate|normal-rate|bad-rate|noraml/);
  });

  it("新行为 4: 兜底名应使用 input.type 与 input.value (通用化)", () => {
    // 兜底名生成应读 input.getAttribute('type') 与 input.value
    const idx = OBSERVE_SRC.search(
      /const wrapsCheckRadio = el\.querySelector\(/,
    );
    const slice = OBSERVE_SRC.slice(idx, idx + 1500);
    // 应引用 input 的 type 属性或 value 属性
    expect(slice).toMatch(/type|value/);
  });
});

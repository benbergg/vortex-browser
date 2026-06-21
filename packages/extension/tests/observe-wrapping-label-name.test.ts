import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Regression lock：<label> 包裹的「非 radio/checkbox」labelable 控件的可访问名。
 *
 * 现象(2026-06-22 跨域/iframe dogfood,httpbin /forms/post):
 *   `<label>Customer name: <input name="custname"></label>` 这类手写表单——
 *   控件无 id、无 label[for]、type 为 text/email/tel/time——在 **iframe 子框**内
 *   被 observe 报成无名 `textbox`,而同一表单在顶层文档却正确显示 "Customer name:"。
 *
 * 根因:AX 语义覆盖层(captureAXNodeMap + applyOverlay)**仅施加于主 frame 0**
 *   (observe.ts「AX 语义覆盖层(v1 仅主 frame frameId 0)」)。子框(同源/跨域皆然)
 *   只靠 page-side getAccessibleName 启发式,而该启发式的「包裹 label」分支此前
 *   只覆盖 radio/checkbox;text/email/tel/textarea 落到末尾 placeholder||title||""
 *   → 空名。于是所有 iframe 内手写表单字段对 agent 不可辨。
 *
 * 修复:getAccessibleName 增加通用「包裹 label」兜底——克隆 label、剥除嵌套表单
 *   控件(避免 textarea 当前文本 / select 的 option 文本污染),取其余文本为名。
 *   radio/checkbox 仍由上方专支提前返回;submit/button/image 仍由 value 提前返回。
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const OBSERVE_SRC = readFileSync(
  join(__dirname, "..", "src", "handlers", "observe.ts"),
  "utf8",
);

describe("observe accessible-name — 包裹 <label> 的非 radio/checkbox 控件(iframe 子框无 AX 覆盖)", () => {
  it("getAccessibleName 有通用包裹-label 兜底(克隆 label 后剥除嵌套表单控件)", () => {
    expect(OBSERVE_SRC).toMatch(
      /const wrapLabel = el\.closest\("label"\);[\s\S]{0,260}cloneNode\(true\)[\s\S]{0,160}querySelectorAll\("input, textarea, select"\)/,
    );
  });

  it("剥除嵌套控件后用其 textContent 作名(规避 textarea 值 / select option 噪声)", () => {
    expect(OBSERVE_SRC).toMatch(
      /for \(const ctrl of clone\.querySelectorAll\("input, textarea, select"\)\)[\s\S]{0,60}ctrl\.remove\(\);[\s\S]{0,160}normName\(clone\.textContent\)/,
    );
  });

  it("通用包裹-label 兜底位于 INPUT 分支末尾 placeholder 兜底之前(label 优先于 placeholder)", () => {
    const wrapCloneIdx = OBSERVE_SRC.search(/const clone = wrapLabel\.cloneNode\(true\)/);
    const placeholderIdx = OBSERVE_SRC.search(
      /el\.getAttribute\("placeholder"\) \|\| el\.getAttribute\("title"\) \|\| ""/,
    );
    expect(wrapCloneIdx).toBeGreaterThan(0);
    expect(placeholderIdx).toBeGreaterThan(0);
    expect(wrapCloneIdx).toBeLessThan(placeholderIdx);
  });
});

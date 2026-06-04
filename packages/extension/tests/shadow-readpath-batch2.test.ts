import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * 白盒审计批次 2(族 K — 读路径 shadow 穿透)source-contract 回归锁。
 *
 * page-side inline func 经 chrome.scripting.executeScript 在 MAIN world 序列化执行,
 * 闭包不可单测;canonical 逻辑(queryDeep/queryAllDeep/deepElementFromPoint)已由
 * shadow-walk.test.ts 行为覆盖。此处锁住三处 inline 已正确接入 shadow 穿透,
 * 真实行为由 live确诊(shadow fixture)兜底。
 *
 *  - OBS-3: content.getText walkControls 下钻须进 open shadowRoot(原仅走 el.children,
 *    shadow 内表单控件全缺失 → silent-false-success)
 *  - OBS-1: observe 遮挡判定须用穿 shadow 的 deepElementFromPoint(原 document.elementFromPoint
 *    对 shadow 内元素返回 host → 误判 visible:false)
 *  - capture.element follow-up: 须经 dom-resolve 的 queryDeep 解析(原 document.querySelector
 *    不穿 shadow → shadow 内元素 @ref 截图 ELEMENT_NOT_FOUND)
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(__dirname, "..", "src", rel), "utf8");
const CONTENT_SRC = read("handlers/content.ts");
const OBSERVE_SRC = read("handlers/observe.ts");
const CAPTURE_SRC = read("handlers/capture.ts");

describe("OBS-3: content walkControls 穿 open shadow", () => {
  it("walkControls 下钻时读取 el.shadowRoot 的子节点", () => {
    // 提取 walkControls 函数体
    const m = CONTENT_SRC.match(/const walkControls =[\s\S]*?\n {12}\};/);
    expect(m).not.toBeNull();
    const body = m![0];
    expect(body).toMatch(/shadowRoot/);
  });

  it("walkControls 把 shadowRoot 子节点压栈继续遍历", () => {
    const m = CONTENT_SRC.match(/const walkControls =[\s\S]*?\n {12}\};/);
    const body = m![0];
    // shadowRoot 存在时枚举其 children 入栈(与 light children 同等深度推进)
    expect(body).toMatch(/sr\.children|shadowRoot\)?\.children|Array\.from\(sr\.children\)/);
  });
});

describe("OBS-1: observe 遮挡判定穿 open shadow", () => {
  it("scan 内定义 deepElementFromPoint 助手(下钻 open shadow root 的 elementFromPoint)", () => {
    expect(OBSERVE_SRC).toMatch(/function deepElementFromPoint/);
    expect(OBSERVE_SRC).toMatch(/shadowRoot\b[\s\S]{0,80}?\.elementFromPoint/);
  });

  it("遮挡 hit-test 用 deepElementFromPoint(cx, cy) 而非裸 document.elementFromPoint", () => {
    expect(OBSERVE_SRC).toMatch(/const topEl = deepElementFromPoint\(cx, cy\)/);
  });
});

describe("capture.element follow-up: 经 dom-resolve 穿 open shadow", () => {
  it("ELEMENT handler 先加载 dom-resolve 模块", () => {
    expect(CAPTURE_SRC).toMatch(/loadPageSideModule\(/);
    expect(CAPTURE_SRC).toMatch(/"dom-resolve"/);
  });

  it("rect 查询用 __vortexDomResolve.queryDeep 而非 document.querySelector", () => {
    expect(CAPTURE_SRC).toMatch(/__vortexDomResolve\.queryDeep\(/);
  });
});

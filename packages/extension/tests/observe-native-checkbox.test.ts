import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * AB(2026-06-02 dogfood):原生 checkbox/radio + 兄弟式 <label for> 隐形 bug。
 *
 * 旧 INTERACTIVE_SELECTORS 为规避 Element Plus 等组件库的 visually-hidden
 * 真 input 双现,把整类 input[type=radio]/[type=checkbox] 排除,只靠
 * label:has(input[...]) 收包裹式 label。结果最常见的两种原生表单模式
 * (兄弟式 <input id><label for> / 裸 <input aria-label>)完全扫不到。
 *
 * 修复:放开排除直接收原生 input,在扫描循环里用「有包裹 <label> 祖先 OR
 * opacity:0」精准挡掉组件库 surrogate,只放行裸露真 input。
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const OBSERVE_SRC = readFileSync(
  join(__dirname, "..", "src", "handlers", "observe.ts"),
  "utf8",
);

describe("observe native checkbox/radio visibility (AB,2026-06-02 dogfood)", () => {
  it("INTERACTIVE_SELECTORS 不再整类排除 radio/checkbox", () => {
    // 旧的过度排除已移除
    expect(OBSERVE_SRC).not.toMatch(
      /input:not\(\[type=hidden\]\):not\(\[type=radio\]\):not\(\[type=checkbox\]\)/,
    );
    // 现在收所有非 hidden 的 input
    expect(OBSERVE_SRC).toMatch(/"input:not\(\[type=hidden\]\)"/);
  });

  it("扫描循环对原生 checkbox/radio 有 surrogate 去重门(closest label + opacity)", () => {
    expect(OBSERVE_SRC).toMatch(
      /inputType === "checkbox" \|\| inputType === "radio"/,
    );
    expect(OBSERVE_SRC).toMatch(/htmlEl\.closest\("label"\)/);
    // opacity:0 的自绘 surrogate(Ant Design inset:0 opacity:0 非 0 rect)
    expect(OBSERVE_SRC).toMatch(/parseFloat\(computedStyle\.opacity\) === 0/);
  });

  it("包裹 label 仅在自身非零尺寸时才跳 input,零尺寸(display:contents)保留 input(评审 Finding 1)", () => {
    // 跳过 input 前先确认包裹 label 自身可被收(非零 rect),否则 input 和 label
    // 双双消失、整控件隐形。
    expect(OBSERVE_SRC).toMatch(
      /wrapLabel[\s\S]{0,80}getBoundingClientRect\(\)[\s\S]{0,120}lr\.width > 0 && lr\.height > 0[\s\S]{0,20}continue/,
    );
  });

  it("getUiState 从 IDL .checked 取勾选态:裸 input 读自身、包裹 label 读内嵌 input", () => {
    // 裸露 input
    expect(OBSERVE_SRC).toMatch(/el\.tagName === "INPUT"[\s\S]{0,80}probe = el as HTMLInputElement/);
    // 包裹式 <label> 读其内嵌 checkbox/radio
    expect(OBSERVE_SRC).toMatch(
      /el\.tagName === "LABEL"[\s\S]{0,160}querySelector\([\s\S]{0,80}input\[type=checkbox\]/,
    );
    expect(OBSERVE_SRC).toMatch(
      /probe\.type === "checkbox" \|\| probe\.type === "radio"[\s\S]{0,40}probe\.checked === true/,
    );
  });

  it("getAccessibleName 仍解析兄弟式 label[for](裸 input 命名所依赖)", () => {
    // AB 修复后裸 input 可见,其名靠 label[for] 解析——确保该路径仍在
    expect(OBSERVE_SRC).toMatch(/label\[for="\$\{id\}"\]/);
  });

  // 2026-06-03 bench 回归:e506fb9 把 radio/checkbox input(tabindex=0)纳入交互池
  // 后,包裹式 <label class="el-radio"> 因含 input[tabindex] 后代被 AJ isContainer
  // 判为噪声容器返空名 → 被 BUG-3 丢弃,而 input 自身又被 surrogate 门(opacity:0)
  // 跳过 → 整个 radio/checkbox 控件隐形(spa-route-residue/el-radio-group 漏选项、
  // el-transfer 漏 checkbox)。修复:LABEL 分支在 isContainer 前,对包裹 checkbox/
  // radio 的 label 用其自身 textContent(name-from-content)兜住。
  it("包裹式 <label> 含 checkbox/radio 时用 textContent 兜名(先于 isContainer 噪声容器返空)", () => {
    // LABEL 分支内、aria-label 兜底之后,新增 wrapsCheckRadio name-from-content
    expect(OBSERVE_SRC).toMatch(
      /wrapsCheckRadio\s*=\s*el\.querySelector\(\s*["']input\[type=checkbox\], input\[type=radio\]["']/,
    );
    expect(OBSERVE_SRC).toMatch(
      /if \(wrapsCheckRadio\)[\s\S]{0,160}normName\(visibleTextContent\(el\)\)[\s\S]{0,60}return labelText/,
    );
  });

  it("name-from-content 兜底必须在 isContainer 返空之前(否则被噪声容器逻辑抢先丢弃)", () => {
    const wrapIdx = OBSERVE_SRC.indexOf("const wrapsCheckRadio");
    const containerEmptyIdx = OBSERVE_SRC.indexOf('if (isContainer) return "";');
    expect(wrapIdx).toBeGreaterThan(0);
    expect(containerEmptyIdx).toBeGreaterThan(0);
    expect(wrapIdx).toBeLessThan(containerEmptyIdx);
  });
});

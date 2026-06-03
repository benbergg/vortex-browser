import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Regression lock:focus 管理用的 `<div tabindex=0>` 容器噪声(github.com dogfood
 * 2026-06-02 AJ)。
 *
 * 现象:GitHub 文件浏览区的 `<div tabindex="0" class="SharedPageLayout…content">`
 * 无 role/aria-label,经 [tabindex] 被 INTERACTIVE_SELECTORS 捕获;getAccessibleName
 * 旧逻辑落到 textContent 兜底 → 取整个子树文本拼接「anthropics/anthropic-sdk-python
 * main36 Branches193 Tags…」(噪声)。这个噪声名又击败了下游 BUG-3 噪声过滤器的
 * `!name` 判定(`!formLike && !hasExplicitRole && !name → continue`),使幽灵容器漏网
 * ——与 className-emotion-token 那例同源:名字质量缺陷顺带制造精度泄漏。
 *
 * 修复:有交互后代的元素是**容器**,textContent 是子控件拼接(噪声),不作名源;
 * 容器无 label/title 时返空(且**不**走 className icon 兜底——容器常含头像/图标 img
 * 会误触发 iconNameFromClass 取 hash 噪声名,反而又续命)。名留空后 BUG-3 丢弃容器。
 * cursor:pointer 自定义按钮 div 是 leaf(无交互后代),不受影响。
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const OBSERVE_SRC = readFileSync(
  join(__dirname, "..", "src", "handlers", "observe.ts"),
  "utf8",
);

describe("observe focus-container 命名噪声抑制 (github dogfood 2026-06-02 AJ)", () => {
  it("getAccessibleName 用「有交互后代」判别容器(querySelector 交互后代选择器)", () => {
    expect(OBSERVE_SRC).toMatch(/const isContainer\s*=/);
    expect(OBSERVE_SRC).toMatch(
      /querySelector\(\s*["']a\[href\],button,input,select,textarea,\[tabindex\],\[contenteditable=true\]["']/,
    );
  });

  it("textContent 仅在非容器(leaf)时作名源,容器不取子树拼接", () => {
    expect(OBSERVE_SRC).toMatch(/if \(text && !isContainer\) return text;/);
  });

  it("容器无 label/title 返空,且不走 className icon 兜底(避免头像 img 误触发续命)", () => {
    // title 仍优先(合法区域名);其后容器直接返空,绕过 iconNameFromClass。
    expect(OBSERVE_SRC).toMatch(/if \(isContainer\) return "";/);
    // 顺序保证:isContainer 的空名返回必须在 iconNameFromClass 兜底之前。
    const containerReturnIdx = OBSERVE_SRC.indexOf('if (isContainer) return "";');
    const iconFallbackIdx = OBSERVE_SRC.indexOf("return iconNameFromClass(el);");
    expect(containerReturnIdx).toBeGreaterThan(0);
    expect(iconFallbackIdx).toBeGreaterThan(0);
    expect(containerReturnIdx).toBeLessThan(iconFallbackIdx);
  });

  it("下游 BUG-3 噪声过滤器仍按 `!name` 丢弃无名 wrapper(空名 → 丢弃链路完整)", () => {
    expect(OBSERVE_SRC).toMatch(/!formLike && !hasExplicitRole && !name\) continue;/);
  });
});

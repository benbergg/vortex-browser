import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * 回归锁:CLICK handler 的 useRealMouse/trustedMode 早返回分支(走 cdpClickElement)
 * 必须经 attachDialogHandled 把 raw dialogs 转成对外 dialogHandled。否则 trusted
 * 模式环境(Chrome 带 flag,click 默认走 CDP)下返回 raw dialogs 无 dialogHandled,
 * dialog-handling bench case 红。a05536b 加 dialog 应答时只覆盖了合成 + deferToCdp
 * 路径,漏了这条早返回分支。(2026-06-13 antd Pro dogfood bench 副产)
 * 源码级:dom.ts CLICK handler 单测需重度 mock chrome.scripting/debugger,源码级
 * 断言更直接锁住"两条 CDP 返回点都包 attachDialogHandled"。
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const DOM_SRC = readFileSync(
  join(__dirname, "../src/handlers/dom.ts"),
  "utf8",
);

describe("CLICK CDP 路径 dialogHandled 转换 (trusted/realMouse 早返回分支)", () => {
  it("useRealMouse || trustedMode 分支用 attachDialogHandled 包裹 cdpClickElement", () => {
    expect(DOM_SRC).toMatch(
      /useRealMouse \|\| trustedMode[\s\S]{0,500}?return attachDialogHandled\(\s*await cdpClickElement/,
    );
  });

  it("attachDialogHandled 定义在 useRealMouse/trustedMode 分支之前(避免 TDZ)", () => {
    const defIdx = DOM_SRC.indexOf("const attachDialogHandled =");
    const branchIdx = DOM_SRC.indexOf("if (useRealMouse || trustedMode)");
    expect(defIdx).toBeGreaterThan(-1);
    expect(branchIdx).toBeGreaterThan(-1);
    expect(defIdx).toBeLessThan(branchIdx);
  });
});

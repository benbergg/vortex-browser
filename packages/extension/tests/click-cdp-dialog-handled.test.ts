import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * 回归锁:CLICK handler 的 useRealMouse/trustedMode 分支 → cdpClickPath() → 经
 * attachDialogHandled 把 raw dialogs 转成对外 dialogHandled,这条链一环都不能断。
 * 否则 trusted 模式环境(Chrome 带 flag,click 默认走 CDP)下返回 raw dialogs 无
 * dialogHandled,dialog-handling bench case 红。a05536b 加 dialog 应答时只覆盖了
 * 合成 + deferToCdp 路径,漏了这条 CDP 分支。(2026-06-13 antd Pro dogfood bench 副产)
 * CDP 分支体后来被抽成局部 cdpClickPath(),故分支与包裹点分成两条断言各锁半截。
 * 源码级:dom.ts CLICK handler 单测需重度 mock chrome.scripting/debugger,源码级
 * 断言更直接锁住"两条 CDP 返回点都包 attachDialogHandled"。
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const DOM_SRC = readFileSync(
  join(__dirname, "../src/handlers/dom.ts"),
  "utf8",
);

describe("CLICK CDP 路径 dialogHandled 转换 (trusted/realMouse 早返回分支)", () => {
  it("cdpClickPath 用 attachDialogHandled 包裹 cdpClickElement", () => {
    // 自愈接入后，cdpResult 先存变量再返回（保留 attachDialogHandled 包裹语义）。
    // 匹配模式：函数内 return 或赋值（=）紧跟 attachDialogHandled(await cdpClickElement(...)）。
    // 窗口限制 500 字符防止跨分支误判；(?:return|=)\s* 约束调用必须出现在 return 或赋值语境中。
    expect(DOM_SRC).toMatch(
      /const cdpClickPath[\s\S]{0,500}?(?:return|=)\s*attachDialogHandled\(\s*await cdpClickElement/,
    );
  });

  it("useRealMouse || trustedMode 分支确实走 cdpClickPath()", () => {
    // 上一条只锁住 cdpClickPath 内部；不锁这一环，分支绕开它也没人发现。
    const branchIdx = DOM_SRC.indexOf("if (useRealMouse || trustedMode)");
    expect(branchIdx).toBeGreaterThan(-1);
    expect(DOM_SRC.slice(branchIdx, branchIdx + 200)).toContain("cdpClickPath()");
  });

  it("attachDialogHandled 定义在 useRealMouse/trustedMode 分支之前(避免 TDZ)", () => {
    const defIdx = DOM_SRC.indexOf("const attachDialogHandled =");
    const branchIdx = DOM_SRC.indexOf("if (useRealMouse || trustedMode)");
    expect(defIdx).toBeGreaterThan(-1);
    expect(branchIdx).toBeGreaterThan(-1);
    expect(defIdx).toBeLessThan(branchIdx);
  });
});

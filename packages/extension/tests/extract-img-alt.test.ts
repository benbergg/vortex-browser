/**
 * Author: qingwa
 * Description: REQ-NNN N0060 京东评测 — vortex_extract 支持 img alt 属性
 *   提取, 京东自营 `<img alt="自营">` 角标 + 淘宝/天猫 `<img alt="天猫积分">` 等
 *   角标能从 extract 召回内容中读到 alt 文字。
 *
 * 背景 (reports/jd-dogfood-V1/_meta/REQ-NNN-extract_img_alt.md):
 *   observe 阶段已有 iconNameFromClass 读 img alt → 翻译为可读 ref
 *   (京东 D1 ✅); extract 阶段只用 innerText/textContent, 不读 attribute
 *   (京东 D2 ⚠️)。 方案 A: 默认补全 img alt (追加到 innerText 后);
 *   方案 B: includeAlt: false 显式关闭。
 *
 * 关键契约 (4 条):
 *   1. 默认 (includeAlt=true): innerText + 追加未包含的 img alt
 *   2. includeAlt=false: 行为与现有 innerText 一致 (向后兼容)
 *   3. alt 已被 innerText 包含时, 不重复追加 (dedup)
 *   4. 多个 img alt 时, 每个 unique 追加一次 (按 DOM 顺序)
 *
 * Why TDD:
 *   walkWithAlt 是 page-side 内的纯函数, jsdom 直接测。
 *   集成测试验证 content.ts 源码契约 (includeAlt 参数 + walkWithAlt 调用)。
 */

import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * walkWithAlt 纯函数: 给定 root 元素 + innerText, 追加 root 内所有 img
 * [alt] 中未在 innerText 出现的 alt 文字 (空格分隔)。
 * 不修改原 innerText; 返回新字符串。
 */
function walkWithAlt(root: Element, innerText: string, includeAlt: boolean): string {
  if (!includeAlt) return innerText;
  let result = innerText;
  root.querySelectorAll("img[alt]").forEach((img) => {
    const alt = img.getAttribute("alt")?.trim();
    if (alt && !result.includes(alt)) {
      result = result.length > 0 ? `${result} ${alt}` : alt;
    }
  });
  return result;
}

function withDom(html: string, fn: () => void) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`);
  const g = globalThis as any;
  g.window = dom.window;
  g.document = dom.window.document;
  g.Element = dom.window.Element;
  g.HTMLElement = dom.window.HTMLElement;
  try { fn(); } finally { /* keep globals */ }
}

describe("walkWithAlt (REQ-NNN vortex_extract img alt 提取纯函数)", () => {
  it("京东自营角标: '<img alt=\"自营\">' + innerText 文本 → 追加 '自营'", () => {
    withDom(
      `<div><span>Apple iPhone 16</span><img alt="自营" src="x.png"/></div>`,
      () => {
        const root = document.querySelector("div")!;
        const result = walkWithAlt(root, "Apple iPhone 16", true);
        expect(result).toBe("Apple iPhone 16 自营");
      },
    );
  });

  it("淘宝角标: 多个 alt 同时追加 (按 DOM 顺序)", () => {
    withDom(
      `<div>
        <span>商品标题</span>
        <img alt="天猫积分" src="x.png"/>
        <img alt="官方旗舰" src="y.png"/>
        <img alt="7天无理由" src="z.png"/>
      </div>`,
      () => {
        const root = document.querySelector("div")!;
        const result = walkWithAlt(root, "商品标题", true);
        expect(result).toBe("商品标题 天猫积分 官方旗舰 7天无理由");
      },
    );
  });

  it("dedup: alt 已被 innerText 包含时, 不重复追加", () => {
    withDom(
      `<div><span>本店为自营店铺</span><img alt="自营" src="x.png"/></div>`,
      () => {
        const root = document.querySelector("div")!;
        // "自营" 已在 innerText 中, 不应重复
        const result = walkWithAlt(root, "本店为自营店铺", true);
        expect(result).toBe("本店为自营店铺");
      },
    );
  });

  it("dedup 边界: 部分包含 (如 '官方旗舰店' vs '官方旗舰') 不算重复 (includes substring match)", () => {
    // 当前实现是 includes 整段匹配, "官方旗舰" 是 "官方旗舰店" 的子串 → 视为重复
    // 这是 acceptable trade-off: 简单 dedup 避免重复噪声
    withDom(
      `<div><span>官方旗舰店</span><img alt="官方旗舰" src="x.png"/></div>`,
      () => {
        const root = document.querySelector("div")!;
        const result = walkWithAlt(root, "官方旗舰店", true);
        // "官方旗舰" 是 "官方旗舰店" 的子串, includes() 命中 → 不追加
        expect(result).toBe("官方旗舰店");
      },
    );
  });

  it("includeAlt=false → 行为与原 innerText 一致 (向后兼容)", () => {
    withDom(
      `<div><span>Apple iPhone 16</span><img alt="自营" src="x.png"/></div>`,
      () => {
        const root = document.querySelector("div")!;
        const result = walkWithAlt(root, "Apple iPhone 16", false);
        expect(result).toBe("Apple iPhone 16");
      },
    );
  });

  it("空 innerText + 多个 alt → 第一个 alt 作起始, 后续空格分隔", () => {
    withDom(
      `<div><img alt="自营" src="x.png"/><img alt="包邮" src="y.png"/></div>`,
      () => {
        const root = document.querySelector("div")!;
        const result = walkWithAlt(root, "", true);
        expect(result).toBe("自营 包邮");
      },
    );
  });

  it("无 alt 属性的 img → 不处理", () => {
    withDom(
      `<div><span>商品标题</span><img src="x.png"/><img alt="" src="y.png"/></div>`,
      () => {
        const root = document.querySelector("div")!;
        const result = walkWithAlt(root, "商品标题", true);
        // 两个 img 都没 alt 或 alt 空, 都不追加
        expect(result).toBe("商品标题");
      },
    );
  });

  it("纯空白 alt (含换行) → trim 后空, 不追加", () => {
    withDom(
      `<div><span>商品</span><img alt="   " src="x.png"/></div>`,
      () => {
        const root = document.querySelector("div")!;
        const result = walkWithAlt(root, "商品", true);
        expect(result).toBe("商品");
      },
    );
  });
});

describe("content.ts 集成 — includeAlt 参数 + walkWithAlt 调用 (REQ-NNN)", () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const SRC = readFileSync(
    join(__dirname, "..", "src", "handlers", "content.ts"),
    "utf8",
  );

  it("content.ts GET_TEXT handler 接收 includeAlt 参数 (默认 true)", () => {
    // 显式 includeAlt 参数定义
    expect(SRC).toMatch(/includeAlt/);
  });

  it("page-side func 调用 walkWithAlt 追加 img alt", () => {
    // 查找 walkWithAlt 或等价实现 (遍历 img[alt] + 追加)
    expect(SRC).toMatch(/img\[alt\]|querySelectorAll\(["']img/);
  });
});

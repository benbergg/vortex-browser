/**
 * Author: qingwa
 * Description: target 传 Playwright 语法或裸自然语言时，MCP 层必须当场拒绝并给出
 *   正确语法，不能把它当 CSS 丢给 extension。
 *
 * 背景 (2026-07-29 iPaaS 实战):
 *   - `text=搜索` / `a >> b` → querySelector 抛 SyntaxError，被 probe 吞成 NOT_ATTACHED
 *     (可重试) → 空转满 timeout → 抛 "Element detached from DOM"，方向完全相反。
 *   - `保存配置` → 是**合法**的 CSS 类型选择器(Unicode 标签名)，不抛 SyntaxError，
 *     但 HTML 自定义元素名必须以 ASCII 字母开头，含 CJK 的裸标签选择器永远匹配不到
 *     任何元素。extension 层无从分辨，只能报 NOT_ATTACHED；只有 MCP 层能在入口拦下。
 *
 *   本文件锁定 MCP 层拦截，兼守边界：任何结构化 CSS(含带中文的属性选择器)必须放行。
 */

import { describe, it, expect } from "vitest";
import { VtxErrorCode } from "@vortex-browser/shared";
import { parseRef } from "../src/lib/ref-parser.js";

describe("MCP 层拒绝不受支持的 target 语法", () => {
  const PLAYWRIGHT_SYNTAX = [
    "text=搜索",
    'tr:has-text("VOC-聚水潭") >> text=定时拉取',
    "button >> nth=0",
    "role=button[name='保存']",
  ];

  for (const bad of PLAYWRIGHT_SYNTAX) {
    it(`拒绝 Playwright 语法 ${JSON.stringify(bad)}`, () => {
      expect(() => parseRef(bad)).toThrowError(
        expect.objectContaining({ code: VtxErrorCode.INVALID_SELECTOR }),
      );
    });
  }

  it("拒绝裸自然语言（含 CJK 的类型选择器永远匹配不到元素）", () => {
    expect(() => parseRef("保存配置")).toThrowError(
      expect.objectContaining({ code: VtxErrorCode.INVALID_SELECTOR }),
    );
  });

  it("错误信息给出可执行的替代路径（CSS 或 observe 的 @ref）", () => {
    const err = (() => {
      try {
        parseRef("text=搜索");
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/CSS/i);
    expect(err!.message).toMatch(/vortex_observe/);
  });
});

describe("边界：合法 CSS 一律放行", () => {
  const VALID = [
    "button",
    "div",
    "my-element",
    "button.save-config-btn",
    "#app > .content",
    "tbody tr:nth-child(1) td:nth-child(2)",
    // 中文出现在属性值里是完全正常的，绝不能误伤（iPaaS 全程在用）
    "input[placeholder='请输入名称']",
    "input[placeholder='请选择跑批环境']",
    ".el-dialog .el-form-item:has(input)",
    // 审计发现的真实误伤形态：属性值里的 >> 字面量。中文后台的分页/面包屑
    // 文案（"下一页 >>"、"更多 >> 全部"）很常见，这些都是合法 CSS。
    '[title="下一页 >>"]',
    '[aria-label="Next >>"]',
    '[value=">>"]',
    'a[href="/p?q=a>>b"]',
    "a[title='更多 >> 全部']",
    '[data-x=":text(1)"]',
    // 自定义元素名只要求**首字符**是 ASCII 小写字母，后续 PCENChar 允许非 ASCII
    // （HTML Standard PotentialCustomElementName）。实测 customElements.define("x-中文")
    // 被接受且 querySelector 能命中，故不能整串一刀切。
    "x-中文",
    "my-组件",
    "x-über",
  ];

  for (const good of VALID) {
    it(`放行 ${JSON.stringify(good)}`, () => {
      expect(parseRef(good)).toEqual({ kind: "selector", selector: good });
    });
  }

  it("@ref 形式不受影响", () => {
    expect(parseRef("@3f5f:e121")).toMatchObject({ kind: "ref", index: 121 });
  });
});

/**
 * 校验规则本身不能成为拒绝服务面。MCP server 是单线程 Node，一次卡死 =
 * 期间所有工具调用全挂，且表现为"vortex 没反应"而非报错。
 *
 * 原实现 /^A*B A*$/（A ⊇ B 完全重叠）是二次回溯：实测 20k 字符 5.5s、
 * 80k 字符 87s。触发形态恰恰是本规则声称要拦的输入——LLM 把整段中文界面
 * 文案当 target 传（中文正文不含空格，整段落进字符类 A，末尾一个 ASCII
 * 标点即让匹配失败并全量回溯）。
 */
describe("校验规则自身的复杂度（ReDoS）", () => {
  const budgetMs = 200;

  for (const n of [5_000, 20_000, 40_000]) {
    it(`${n} 字符的中文串在 ${budgetMs}ms 内返回`, () => {
      const payload = "中".repeat(n) + ".";
      const t0 = process.hrtime.bigint();
      try {
        parseRef(payload);
      } catch {
        /* 拒绝与否都可以，这里只约束耗时 */
      }
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      expect(ms).toBeLessThan(budgetMs);
    });
  }

  it("真实误传形态（长中文文案 + 末尾空格）不产生二次回溯", () => {
    const payload = "请在下方表单中填写完整的集成配置信息并保存".repeat(1000) + " ";
    const t0 = process.hrtime.bigint();
    try {
      parseRef(payload);
    } catch {
      /* ignore */
    }
    expect(Number(process.hrtime.bigint() - t0) / 1e6).toBeLessThan(budgetMs);
  });
});

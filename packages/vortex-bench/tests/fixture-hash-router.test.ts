/**
 * Author: qingwa
 * Description: fixture 的 hash 路由页**行为**契约（最终整体评审 Important 8 / A12）。
 *
 * 这条断言的是**行为**，不是字面量：把 fixture 真实吐出来的页面脚本拿进一个最小
 * DOM 桩里跑一遍，看它到底把「命中」还是「未命中」渲染出来。
 *
 * - 正确大小写（#/app/settings）→ 命中标识；
 * - 错误大小写（#/App/Settings）→ 未命中标识。
 *
 * 关键性质：**两次导航的 HTTP 都是 200**（导航成功 ≠ 应用路由存在）。
 * 路由表由 packages/vortex-bench/src/fixture.ts 的常量注入，页面脚本只做精确匹配。
 */
import { describe, it, expect, afterEach } from "vitest";
import { createContext, runInContext } from "node:vm";
import {
  startFixture,
  HASH_ROUTE_CORRECT,
  HASH_ROUTE_WRONG_CASE,
  HASH_ROUTE_OK_MARKER,
  HASH_ROUTE_MISS_MARKER,
  HASH_ROUTE_OUT_ID,
  type Fixture,
} from "../src/fixture.js";

let fixture: Fixture | null = null;

afterEach(async () => {
  if (fixture) {
    await fixture.close();
    fixture = null;
  }
});

/** 页面脚本跑完后的渲染结果。 */
interface Rendered {
  text: string | null;
  route: string | null;
}

/**
 * 在最小 DOM 桩里跑 fixture 页面里的脚本，按给定的 hash 看它渲染出什么。
 *
 * 刻意不 stub `location.hash` 之外的任何路由判定逻辑：脚本自己判定，
 * 桩只提供 DOM 与事件注册。
 */
function renderWithHash(html: string, hash: string): Rendered {
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!script) throw new Error("hash router 页里没有 <script>");

  const attrs = new Map<string, string>();
  const elements = new Map<string, { textContent: string | null }>();
  elements.set(HASH_ROUTE_OUT_ID, { textContent: "PENDING" });
  const listeners: Array<() => void> = [];

  const sandbox = {
    window: {
      location: { hash },
      addEventListener: (type: string, cb: () => void) => {
        if (type === "hashchange") listeners.push(cb);
      },
    },
    document: {
      getElementById: (id: string) => {
        const el = elements.get(id);
        if (!el) return null;
        return {
          get textContent() {
            return el.textContent;
          },
          set textContent(value: string) {
            el.textContent = value;
          },
          setAttribute: (name: string, value: string) => {
            attrs.set(name, value);
          },
          getAttribute: (name: string) => attrs.get(name) ?? null,
        };
      },
    },
  };
  sandbox.window.location.hash = hash;

  const context = createContext(sandbox);
  runInContext(script, context);

  const el = elements.get(HASH_ROUTE_OUT_ID)!;
  return { text: el.textContent, route: attrs.get("data-route") ?? null };
}

describe("fixture 的 hash 路由页（大小写敏感）", () => {
  it("正确大小写命中，错误大小写不命中；两次导航都是 200", async () => {
    fixture = await startFixture();
    const port = new URL(fixture.url).port;

    const res = await fetch(`http://127.0.0.1:${port}/hash-router`);
    expect(res.status).toBe(200);
    const html = await res.text();

    const hit = renderWithHash(html, HASH_ROUTE_CORRECT);
    expect(hit.route).toBe("matched");
    expect(hit.text).toBe(HASH_ROUTE_OK_MARKER);

    const miss = renderWithHash(html, HASH_ROUTE_WRONG_CASE);
    expect(miss.route).toBe("missing");
    expect(miss.text).toBe(HASH_ROUTE_MISS_MARKER);
    expect(miss.text).not.toBe(hit.text);
  });

  it("路由表只认精确 hash（前缀相同也不行）", async () => {
    fixture = await startFixture();
    const port = new URL(fixture.url).port;
    const html = await (await fetch(`http://127.0.0.1:${port}/hash-router`)).text();

    for (const hash of ["#/app/settings/extra", "#/app", "#", "#/app/settings "]) {
      const rendered = renderWithHash(html, hash);
      expect(rendered.route, `hash=${hash} 不该命中`).toBe("missing");
    }
  });
});

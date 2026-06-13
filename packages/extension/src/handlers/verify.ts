// packages/extension/src/handlers/verify.ts
//
// vortex_verify 的 extension 侧 handler。
// 断言走 observe AX 树比对（内部调用 observe.snapshot），绝不旁路 evaluate 做 DOM 查询。
//
// 设计原则：
// 1. 通过 router.dispatch 调用已注册的 observe.snapshot，复用完整 AX 管线。
// 2. 成功：返回 {ok:true}；断言失败：返回 {ok:false, expected, actual}（非抛错），
//    让 LLM 可读 diff。
// 3. 入参错误（未知 mode）：throw VtxError → router 捕获后放入 res.error。
// 4. 四种 mode 均只从 elements 字段中查找，不新建任何 DOM 查询。

import { VerifyActions, ObserveActions, VtxErrorCode, vtxError } from "@vortex-browser/shared";
import type { ActionRouter } from "../lib/router.js";

// observe.snapshot 返回的元素结构（最小子集，供 verify 比对用）
interface AxElement {
  index: number;
  role: string;
  name: string;
  visible: boolean;
  valueNow?: string;
  attrs?: Record<string, string>;
}

// observe.snapshot 返回的最小结构（verify 只需要 elements）
interface ObserveResult {
  elements: AxElement[];
}

/**
 * 内部通过 router 发起 observe.snapshot，取回 AX 元素列表。
 * 使用 filter=all 以便 text/visible/value 类断言能找到非交互元素。
 */
async function fetchElements(
  router: ActionRouter,
  args: Record<string, unknown>,
): Promise<AxElement[]> {
  const snapArgs: Record<string, unknown> = {
    filter: "all",
  };
  if (args.tabId != null) snapArgs.tabId = args.tabId;
  if (args.frameId != null) snapArgs.frameId = args.frameId;

  const resp = await router.dispatch({
    type: "tool_request",
    tool: ObserveActions.SNAPSHOT,
    args: snapArgs,
    requestId: "verify-internal",
  });

  if (resp.error) {
    // 把 observe 报错上抛，保留 code + message
    throw vtxError(
      (resp.error.code as Parameters<typeof vtxError>[0]) ?? VtxErrorCode.JS_EXECUTION_ERROR,
      resp.error.message ?? "observe.snapshot failed",
    );
  }

  const result = resp.result as ObserveResult | undefined;
  return result?.elements ?? [];
}

/**
 * 按 role(可选) + name(可选，大小写不敏感子串) 在元素列表中查找第一个匹配项。
 */
function findElement(
  elements: AxElement[],
  role: string | undefined,
  name: string | undefined,
): AxElement | undefined {
  return elements.find((el) => {
    if (role && el.role.toLowerCase() !== role.toLowerCase()) return false;
    if (name && !el.name.toLowerCase().includes(name.toLowerCase())) return false;
    return true;
  });
}

/**
 * 取元素的「值」：valueNow 优先（slider/spinbutton 等），其次 attrs.value（input 类）。
 */
function elementValue(el: AxElement): string | undefined {
  if (el.valueNow !== undefined) return el.valueNow;
  return el.attrs?.value;
}

export function registerVerifyHandlers(router: ActionRouter): void {
  router.register(VerifyActions.ASSERT, async (args) => {
    const mode = args.mode as string | undefined;

    // ── visible mode：断言匹配 role+name 的元素存在且可见 ──────────────────
    if (mode === "visible") {
      const role = args.role as string | undefined;
      const name = args.name as string | undefined;
      const elements = await fetchElements(router, args);
      const el = findElement(elements, role, name);

      if (!el) {
        return {
          ok: false,
          expected: { role, name, visible: true },
          actual: { found: false },
        };
      }
      if (!el.visible) {
        return {
          ok: false,
          expected: { role, name, visible: true },
          actual: { role: el.role, name: el.name, visible: false },
        };
      }
      return { ok: true };
    }

    // ── value mode：断言 target 元素的值 == value ──────────────────────────
    if (mode === "value") {
      const role = args.role as string | undefined;
      const name = args.name as string | undefined;
      const expected = args.value as string | undefined;
      const elements = await fetchElements(router, args);
      const el = findElement(elements, role, name);

      if (!el) {
        return {
          ok: false,
          expected,
          actual: null,
        };
      }
      const actual = elementValue(el);
      if (actual !== expected) {
        return {
          ok: false,
          expected,
          actual,
        };
      }
      return { ok: true };
    }

    // ── text mode：断言页面含 text（在任意元素 name 中子串匹配）────────────
    if (mode === "text") {
      const text = args.text as string | undefined;
      if (!text) {
        return {
          ok: false,
          expected: text,
          actual: null,
        };
      }
      const elements = await fetchElements(router, args);
      // 大小写不敏感子串搜索各 element name
      const found = elements.some((el) =>
        el.name.toLowerCase().includes(text.toLowerCase()),
      );
      if (!found) {
        return {
          ok: false,
          expected: text,
          actual: { scannedNames: elements.map((e) => e.name).slice(0, 20) },
        };
      }
      return { ok: true };
    }

    // ── list mode：断言一组 items 都存在（name 子串匹配，role 可选）────────
    if (mode === "list") {
      const items = (args.items as Array<{ role?: string; name: string }> | undefined) ?? [];
      const elements = await fetchElements(router, args);
      const missing: string[] = [];
      for (const item of items) {
        const el = findElement(elements, item.role, item.name);
        if (!el) missing.push(item.name);
      }
      if (missing.length > 0) {
        return {
          ok: false,
          expected: items.map((i) => i.name),
          actual: { missing },
        };
      }
      return { ok: true };
    }

    // ── 未知 mode → 抛 INVALID_PARAMS，由 router 放入 res.error ─────────
    throw vtxError(
      VtxErrorCode.INVALID_PARAMS,
      `vortex_verify: 未知 mode "${mode}"。支持 visible|value|text|list。`,
    );
  });
}

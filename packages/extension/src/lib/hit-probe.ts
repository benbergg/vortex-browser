// packages/extension/src/lib/hit-probe.ts
//
// 坐标点击的命中自证。CDP Input.dispatchMouseEvent 走浏览器真实命中测试:事件落在
// 该点最上层的元素上,而不是调用方心里想的那个。dispatchMouseEvent 本身只要没抛错
// 就算成功,于是「点在浮层上」和「点中目标」返回完全一样的 success:true。
//
// 2026-08-14 日志实证:某会话 35 次 mouse_click 里同一坐标被反复重点(714,755 三次),
// 页面自己的探测显示插入面板压住卡片区 302px、48 个按钮里 32 个被挡。调用方拿不到
// 任何反馈,只能靠改坐标猜。这里在派发前照一次 elementFromPoint,把「实际会命中谁」
// 随结果给出 —— 不设门(坐标点击的用途就是绕过门),只做诚实表征。

export type HitProbe =
  | { ok: true; el: string; text?: string; framePath?: string[] }
  | { ok: false; reason: "OUT_OF_VIEWPORT"; viewport: { w: number; h: number } }
  | { ok: false; reason: "NO_ELEMENT" };

/**
 * page-side 注入体：返回 (x, y) 处真正会收到鼠标事件的元素。
 *
 * 必须自包含 —— executeScript 只搬运函数源码，任何模块作用域引用在页面里都是
 * `X is not defined`（见 memory vortex_page_side_func_inline_gotcha）。
 */
export function hitProbePageSide(x: number, y: number): HitProbe {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (!(x >= 0 && y >= 0 && x < vw && y < vh)) {
    return { ok: false, reason: "OUT_OF_VIEWPORT", viewport: { w: vw, h: vh } };
  }

  const describe = (el: Element): string => {
    let s = el.tagName;
    const id = el.getAttribute("id");
    if (id) s += "#" + id;
    const cls = String(el.getAttribute("class") || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2);
    if (cls.length) s += "." + cls.join(".");
    return s;
  };

  const framePath: string[] = [];
  let doc: Document = document;
  let cx = x;
  let cy = y;
  let el: Element | null = null;

  for (let hop = 0; hop < 5; hop++) {
    let cur = doc.elementFromPoint(cx, cy);
    // elementFromPoint 把 shadow-internal 的命中重定向到 host,逐级下钻取真实叶子
    let depth = 0;
    while (cur && (cur as HTMLElement).shadowRoot && depth < 10) {
      const inner = (cur as HTMLElement).shadowRoot!.elementFromPoint(cx, cy);
      if (!inner || inner === cur) break;
      cur = inner;
      depth++;
    }
    el = cur;
    if (!cur || cur.tagName !== "IFRAME") break;
    let sub: Document | null = null;
    // 跨源 iframe 读 contentDocument 抛错:停在 IFRAME 这层照实报,不假装看得更深
    try {
      sub = (cur as HTMLIFrameElement).contentDocument;
    } catch {
      sub = null;
    }
    if (!sub) break;
    const r = cur.getBoundingClientRect();
    framePath.push(describe(cur));
    doc = sub;
    cx = cx - r.left - cur.clientLeft;
    cy = cy - r.top - cur.clientTop;
  }

  if (!el) return { ok: false, reason: "NO_ELEMENT" };

  const raw = (el as HTMLElement).innerText ?? el.textContent ?? "";
  const text = String(raw).replace(/\s+/g, " ").trim().slice(0, 40);
  const out: { ok: true; el: string; text?: string; framePath?: string[] } = {
    ok: true,
    el: describe(el),
  };
  if (text) out.text = text;
  if (framePath.length) out.framePath = framePath;
  return out;
}

/** 探测结果可能来自任意 executeScript 返回值，形状不合就当没探到。 */
export function isHitProbe(v: unknown): v is HitProbe {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (o.ok === true) return typeof o.el === "string";
  if (o.ok === false) return o.reason === "OUT_OF_VIEWPORT" || o.reason === "NO_ELEMENT";
  return false;
}

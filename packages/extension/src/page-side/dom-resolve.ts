// Page-side module：把穿 open shadow 的查询暴露给 dom.ts / content.ts 的 inline func。
// inline func 经 nativePageQuery 在 MAIN world 执行，闭包不能序列化，故经 window 全局共享。
// 由 loadPageSideModule(tid, frameId, "dom-resolve") 预注入（同 MAIN world，可见）。
// 命名空间 + version 守卫，与 fill-reject / actionability 等 page-side module 约定一致。
import {
  queryDeep,
  queryAllDeep,
  deepElementFromPoint,
  isEnabledElement,
} from "./shadow-walk.js";

(function () {
  if ((window as any).__vortexDomResolve?.version === 1) return;
  (window as any).__vortexDomResolve = {
    version: 1,
    queryDeep: (selector: string): Element | null => {
      try {
        return queryDeep(selector, document);
      } catch {
        // 无效 CSS（SyntaxError）→ 当作未命中，与 actionability probe 的 swallow 一致。
        return null;
      }
    },
    queryAllDeep: (selector: string): Element[] => {
      try {
        // light-DOM 优先：light DOM 有命中就用它（与 pre-Tier-2 querySelectorAll 行为一致），
        // 避免裸 CSS selector 在无关 open shadow 树里巧合命中而误报 SELECTOR_AMBIGUOUS。
        // 仅当 light DOM 零命中（典型：observe 戳的 [data-vortex-rid] 在 shadow 内）才穿 shadow。
        const light = Array.from(document.querySelectorAll(selector));
        if (light.length > 0) return light;
        return queryAllDeep(selector, document);
      } catch {
        return [];
      }
    },
    // document.elementFromPoint 对 shadow-internal 元素返回 shadow host（composed 树顶），
    // 此函数逐级下钻 open shadow root 的 elementFromPoint 得到真实命中元素，
    // 使 dom.ts CLICK 遮挡检查对 shadow 内元素成立。
    deepElementFromPoint: (cx: number, cy: number): Element | null => {
      try {
        return deepElementFromPoint(cx, cy);
      } catch {
        return null;
      }
    },
    // 单一 disabled 判定,与门 actionability.isEnabled 共用 shadow-walk.isEnabledElement
    // (aria-disabled + 原生 disabled + fieldset[disabled])。CLICK/TYPE/FILL inline 探测与
    // cdp.ts useRealMouse 探测旧版只判 .disabled 漏 aria-disabled,与门不一致(探测放行→门拦,
    // 或 div[role=textbox] aria-disabled 探测漏判)。收敛到单一真源保证探测==门(#26/#29)。
    isEnabled: (el: Element): boolean => isEnabledElement(el),
  };
})();
export {};

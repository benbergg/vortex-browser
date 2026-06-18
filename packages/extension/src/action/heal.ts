// packages/extension/src/action/heal.ts
//
// descriptor 透明自愈的 host 侧编排。选择器在 actionability gate 以 NOT_ATTACHED 自旋到
// TIMEOUT 时，本模块按 descriptor 在页面侧重匹配并打瞬态属性 data-vtx-heal，返回新选择器
// 供 handler 续走（gate + 动作链路不变）。打标范式同 T3 listener-discovery 的 data-vtx-listener。

import { VtxErrorCode, vtxError } from "@vortex-browser/shared";
import { buildExecuteTarget } from "../lib/tab-utils.js";
import { loadPageSideModule } from "../adapter/page-side-loader.js";

// 模块级单调计数器：保证进程内 heal token 绝不碰撞。
// performance.now() 被浏览器 Spectre clamp 到毫秒级，同一毫秒两次 heal 若仅靠时间戳会产生
// 相同 token，导致残留的 data-vtx-heal 与新 token 撞名，下游 [data-vtx-heal="<tok>"] 命中多元素。
let healSeq = 0;

/** gate 失败是否因选择器零命中（可自愈）。NOT_ATTACHED 自旋到 TIMEOUT，lastReason 保留原因。
 * 真实路径：VtxError.extra.context.extras.lastReason（vtxError 工厂把 context 存到 extra.context）。
 * 旧路径 err.extras?.lastReason 在顶层永远 undefined → 自愈永不触发。*/
export function isStaleNotAttached(err: unknown): boolean {
  const e = err as { code?: string; extra?: { context?: { extras?: { lastReason?: string } } } } | undefined;
  if (!e) return false;
  const last = e.extra?.context?.extras?.lastReason;
  return (
    (e.code === VtxErrorCode.TIMEOUT || e.code === VtxErrorCode.NOT_ATTACHED) &&
    last === "NOT_ATTACHED"
  );
}

// 内联匹配体（自包含，无模块引用）。与 page-side/heal-resolve.matchByDescriptor 同语义；
// heal-inline-alignment.test.ts 校验对齐。导出字符串供注入与单测共用同一真源。
// 名来源顺序对齐 observe getAccessibleName：
//   1. aria-label  2. aria-labelledby(IDREF 列表,在 root 内解析)
//   3. label[for]  4. 包裹 label（input/select/textarea 专用）
//   5. textContent（select 跳过，避免 option 噪声）
export const __healInlineBody = `
function __norm(s){ return (s == null ? "" : String(s)).replace(/\\s+/g, " ").trim(); }
function __names(el){
  var out=[];
  // 1. aria-label
  var a=__norm(el.getAttribute("aria-label")); if(a) out.push(a);
  // 2. aria-labelledby：空格分隔 IDREF，在元素所在 root 内逐个解析
  var lb=el.getAttribute("aria-labelledby");
  if(lb){
    var root=el.getRootNode();
    var parts=[];
    var ids=lb.split(/\\s+/);
    for(var i=0;i<ids.length;i++){
      var id=ids[i]; if(!id) continue;
      var ref=typeof root.getElementById==="function"?root.getElementById(id):document.getElementById(id);
      if(ref) parts.push(ref.textContent||"");
    }
    var lbn=__norm(parts.join(" ")); if(lbn) out.push(lbn);
  }
  // 3 & 4. label[for] / 包裹 label（仅 input/select/textarea）
  var tag=el.tagName.toUpperCase();
  if(tag==="INPUT"||tag==="SELECT"||tag==="TEXTAREA"){
    var eid=el.id;
    if(eid){
      var lbl=document.querySelector("label[for=\\""+eid+"\\"]");
      if(lbl){ var ln=__norm(lbl.textContent); if(ln) out.push(ln); }
    }
    // 注：observe 仅对 radio/checkbox 用 closest，匹配器扩展到全 INPUT/SELECT/TEXTAREA（超集安全，name 精确匹配仍需通过，不引入误配）
    var wl=el.closest("label");
    if(wl){ var wln=__norm(wl.textContent); if(wln) out.push(wln); }
  }
  // 5. textContent（select 跳过，避免 option 噪声）
  if(tag!=="SELECT"){ var t=__norm(el.textContent); if(t) out.push(t); }
  return out;
}
function __roleMatches(el, role){
  var tag=el.tagName.toLowerCase();
  var map={button:"button",a:"link",input:"textbox",select:"combobox",textarea:"textbox"};
  var intrinsic=map[tag]; if(!intrinsic) return true; return intrinsic===role; }
function __inlineMatch(candidates, desc){
  var target=__norm(desc.name); if(!target) return {kind:"none"};
  var hits=candidates.filter(function(el){ return __names(el).indexOf(target)>=0; });
  if(hits.length===0) return {kind:"none"};
  if(hits.length>1 && desc.role){
    var narrowed=hits.filter(function(el){ return __roleMatches(el, desc.role); });
    if(narrowed.length>=1) hits=narrowed; }
  if(hits.length===1) return {kind:"unique", el:hits[0]};
  return {kind:"ambiguous"};
}`;

// best-effort：token 进程内单调唯一（Date.now 前缀 + healSeq 后缀），残留的 data-vtx-heal
// 属性不会与后续 heal 碰撞，故清理为可选。
const HEAL_ATTR = "data-vtx-heal";

/**
 * 按 descriptor 在 tab/frame 页面侧重匹配失效选择器。
 * 唯一命中 → 打瞬态属性 → 返回 `[data-vtx-heal="<token>"]`。
 * 歧义 → AMBIGUOUS_DESCRIPTOR；无命中 → STALE_REF。
 */
export async function tryHealSelector(
  tabId: number,
  frameId: number | undefined,
  descriptor: { role?: string; name: string },
): Promise<string> {
  await loadPageSideModule(tabId, frameId, "dom-resolve");
  const token = `h${Date.now().toString(36)}_${healSeq++}`;
  const results = await chrome.scripting.executeScript({
    target: buildExecuteTarget(tabId, frameId),
    world: "MAIN",
    func: (desc: { role?: string; name: string }, attr: string, tok: string, inlineBody: string) => {
      // 收集候选：scan 全文档可交互元素（穿 open shadow 复用 dom-resolve）。
      const qad = (window as any).__vortexDomResolve?.queryAllDeep;
      if (!qad) return { kind: "none" };
      const candidates = qad("a,button,input,select,textarea,[role],[onclick],[tabindex]") as Element[];
      // 注入内联匹配体（与真源对齐）。
      // eslint-disable-next-line no-new-func
      const match = new Function("candidates", "desc", `${inlineBody}; return __inlineMatch(candidates, desc);`);
      const r = match(candidates, desc) as { kind: string; el?: Element };
      if (r.kind === "unique" && r.el) {
        (r.el as HTMLElement).setAttribute(attr, tok);
        return { kind: "unique", selector: `[${attr}="${tok}"]` };
      }
      return { kind: r.kind };
    },
    args: [descriptor, HEAL_ATTR, token, __healInlineBody],
  });
  // executeScript 抛错（如 CSP 阻注入）时 results 为 undefined，有意走 STALE_REF 优雅降级而非重抛。
  const out = results?.[0]?.result as { kind: string; selector?: string } | undefined;
  if (out?.kind === "unique" && out.selector) return out.selector;
  if (out?.kind === "ambiguous") {
    throw vtxError(
      VtxErrorCode.AMBIGUOUS_DESCRIPTOR,
      `descriptor {role:${descriptor.role},name:"${descriptor.name}"} 多元素命中，拒绝自愈以免错选`,
      { extras: { descriptor } },
    );
  }
  throw vtxError(
    VtxErrorCode.STALE_REF,
    `选择器失效且 descriptor {name:"${descriptor.name}"} 无命中，元素可能已移除；请重新 vortex_observe`,
    { extras: { descriptor } },
  );
}

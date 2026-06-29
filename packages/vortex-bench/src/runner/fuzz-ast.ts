// packages/vortex-bench/src/runner/fuzz-ast.ts
// AST → html 渲染 + manifest 派生。生成器与收缩器共用(收缩后重 render 出干净产物)。
// 渲染纯静态(无 JS),shadow 用声明式 <template shadowrootmode=open>,srcdoc 用 <iframe srcdoc>。

import type { AstNode, FuzzPage, NoiseNode, PrimitiveNode } from "../fuzz-types.js";
import type { ManifestEntry, SynthManifest } from "../scan-types.js";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 单个原语 → html 片段(含 data-vtx-oracle) */
function renderPrimitive(p: PrimitiveNode): string {
  const o = `data-vtx-oracle="${p.id}"`;
  const n = esc(p.name);
  switch (p.kind) {
    case "native-button":
      return `<button ${o}>${n}</button>`;
    case "anchor":
      return `<a href="#" ${o}>${n}</a>`;
    case "role-button-div":
      return `<div role="button" tabindex="0" ${o}>${n}</div>`;
    case "cursor-pointer-div":
      return `<div ${o} style="cursor:pointer" onclick="void 0">${n}</div>`;
    case "icon-svg-title":
      return `<span role="button" tabindex="0" style="cursor:pointer" ${o}>` +
        `<svg width="16" height="16"><title>${n}</title><rect width="16" height="16"/></svg></span>`;
    case "icon-img-alt":
      return `<span role="button" tabindex="0" style="cursor:pointer" ${o}>` +
        `<img src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" alt="${n}"></span>`;
    case "icon-aria-label":
      return `<span role="button" tabindex="0" style="cursor:pointer" aria-label="${n}" ${o}>` +
        `<svg width="16" height="16"><rect width="16" height="16"/></svg></span>`;
    case "shadow-button":
      // 声明式 open shadow:host div 带 oracle,shadow 内放真 button
      return `<div ${o}><template shadowrootmode="open"><button>${n}</button></template></div>`;
    case "srcdoc-button": {
      const inner = `<button data-vtx-oracle="${p.id}">${n}</button>`;
      return `<iframe ${o} srcdoc="${esc(inner)}" style="width:200px;height:60px;border:0"></iframe>`;
    }
    case "aria-container":
      // 显式 role ∈ RECALL_ROLES 的容器(随机 tablist/toolbar/listbox/...)。
      // 严禁带 cursor:pointer/onclick/tabindex:这些会触发启发式入口「正当」召回,
      // 绕开召回门,导致 oracle 无法判定召回门是否独立有效(plan line 659 教训)。
      // role 字段缺失时回退 tablist(源码锁 fuzz-aria-roles.test.ts 兜底断言该 role 在集)。
      return `<div role="${esc(p.role ?? "tablist")}" aria-label="${n}" ${o}></div>`;
    case "decorative-role":
      // 显式装饰角色(presentation/none/generic)。name 不可达(aria-hidden 隐式),
      // 但放进 div 内文本内容仅为让 oracle 能几何 join(joinBy:"geometry")。
      // 严禁带 cursor:pointer/onclick/tabindex:plan line 659 — 启发式会正当召回
      // 该装饰节点,导致 oracle 期望 Recall=false 但实际 Recall=true → 假阳。
      return `<div role="${esc(p.role ?? "presentation")}" ${o}>${n}</div>`;
  }
}

function renderNode(node: AstNode): string {
  if (node.type === "primitive") return renderPrimitive(node);
  return renderNoise(node);
}

function renderNoise(n: NoiseNode): string {
  const cls = ` class="${n.className}"`;
  let attr = "";
  if (n.hidden === "display-none") attr = ` style="display:none"`;
  else if (n.hidden === "visibility-hidden") attr = ` style="visibility:hidden"`;
  else if (n.hidden === "aria-hidden") attr = ` aria-hidden="true"`;
  const kids = n.children.map(renderNode).join("");
  return `<${n.tag}${cls}${attr}>${kids}</${n.tag}>`;
}

export function renderHtml(page: FuzzPage): string {
  const body = renderNoise(page.root);
  return (
    `<!doctype html>\n<html lang="zh"><head><meta charset="utf-8">` +
    `<title>fuzz seed ${page.seed}</title></head><body>\n${body}\n</body></html>\n`
  );
}

/** 深度遍历收集所有原语节点 */
export function collectPrimitives(node: AstNode, out: PrimitiveNode[] = []): PrimitiveNode[] {
  if (node.type === "primitive") out.push(node);
  else for (const c of node.children) collectPrimitives(c, out);
  return out;
}

/** 该原语是否处在某个隐藏祖先下(隐藏=不该被 observe 识别) */
function isUnderHidden(root: NoiseNode, targetId: string, hiddenAbove = false): boolean | null {
  for (const c of root.children) {
    if (c.type === "primitive") {
      if (c.id === targetId) return hiddenAbove;
    } else {
      // aria-hidden 仅从无障碍树隐藏,元素仍可渲染/点击,不算真正非交互
      const next = hiddenAbove || c.hidden === "display-none" || c.hidden === "visibility-hidden";
      const r = isUnderHidden(c, targetId, next);
      if (r !== null) return r;
    }
  }
  return null;
}

export function deriveManifest(page: FuzzPage, fixture: string, path: string): SynthManifest {
  const prims = collectPrimitives(page.root);
  const hasSrcdoc = prims.some((p) => p.kind === "srcdoc-button");
  const entries: ManifestEntry[] = prims.map((p) => {
    const hidden = isUnderHidden(page.root, p.id) === true;
    const joinBy: "geometry" | "name" = p.kind === "srcdoc-button" ? "name" : "geometry";
    // Task 7:容器/装饰角色走双断言 oracle。
    // - aria-container:期望 observe 召回(Recall=true),无视 hidden(真召)。
    //   但若容器在 hidden 祖先下,实际不可达,应改判 interactive:false 避免假阳。
    // - decorative-role:永远不召回(Recall=false),无论是否 hidden。
    //   EXPLICIT_DENY 角色是「不该出现的元素」,即使可达也不召回。
    let interactive: boolean;
    if (p.kind === "decorative-role") {
      interactive = false; // 装饰:永远不召
    } else if (p.kind === "aria-container") {
      interactive = !hidden; // 容器:hidden 祖先下 → 不可达 → 不该召
    } else {
      // 其他原语:隐藏祖先下 → interactive:false;否则 true。
      // 生成器保证 srcdoc-button 永远不出现在隐藏包装里,故不存在
      // "name-join 无法测精度"的矛盾。
      interactive = !hidden;
    }
    return {
      id: p.id,
      interactive,
      expectedName: p.kind === "decorative-role" ? null : p.name,
      expectedRole: p.kind === "aria-container" || p.kind === "decorative-role" ? (p.role ?? null) : null,
      pattern: `fuzz-${p.kind}`,
      joinBy,
    };
  });
  return {
    fixture,
    path,
    frames: hasSrcdoc ? "all-same-origin" : "main",
    entries,
  };
}

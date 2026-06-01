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
    return {
      id: p.id,
      // 隐藏子树下的原语:observe 不该识别 → interactive:false(测 precision/误报)
      interactive: !hidden,
      expectedName: p.name,
      expectedRole: null,
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

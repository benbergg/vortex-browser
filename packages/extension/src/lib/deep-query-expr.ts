/**
 * Description: 穿 open shadow 的选择器求值表达式,供 CDP Runtime.evaluate 用。
 * 与 styleProbeFunc 内联的 queryAllDeep 必须返回同一集合——两侧错一个元素,
 * 后续按下标对齐的字体数据就会挂到别的元素上。deep-query-expr.test.ts 行为对拍。
 */

/** 与 styleProbeFunc 里的 SHADOW_WALK_MAX_DEPTH 同值。 */
export const SHADOW_WALK_MAX_DEPTH = 8;

/** 路径最多收这么多段。到顶意味着身份可能不唯一,碰撞检测据此区分原因。 */
export const PATH_MAX_SEGMENTS = 64;

/**
 * 元素身份 = 它在树中的路径。tag+id+文本长度会碰撞(两个 <button> 文本都 4 字就同指纹),
 * 碰撞时数量校验和逐项比对都通过,字体照样静默挂到别的元素上。
 * 路径对同一棵树唯一,且重排后必变。必须与 styleProbeFunc 内联的那份一致。
 */
export function elementFingerprint(el: Element): string {
  const parts: string[] = [];
  let n: Node | null = el;
  while (n && n.nodeType === 1 && parts.length < PATH_MAX_SEGMENTS) {
    const p: Node | null = n.parentNode;
    let i = 0;
    if (p) {
      const c = (p as Element).children;
      if (c) for (let k = 0; k < c.length; k++) if (c[k] === n) { i = k; break; }
    }
    parts.push(n.nodeName + ":" + i);
    n = p && (p as ShadowRoot).host ? (p as ShadowRoot).host : p;
  }
  return parts.reverse().join(">");
}

/** 在一个元素数组上求身份数组,供 Runtime.callFunctionOn 用(与取 objectId 同源)。 */
export const FINGERPRINT_ON_ARRAY_FN = `function(){
  return Array.prototype.map.call(this, function(el){
    var parts = [], n = el;
    while (n && n.nodeType === 1 && parts.length < ${PATH_MAX_SEGMENTS}) {
      var p = n.parentNode, i = 0;
      if (p) { var c = p.children; if (c) for (var k = 0; k < c.length; k++) if (c[k] === n) { i = k; break; } }
      parts.push(n.nodeName + ":" + i);
      n = p && p.host ? p.host : p;
    }
    return parts.reverse().join(">");
  });
}`;

/**
 * 生成一段自包含表达式,求值得到匹配元素数组。
 * @param limit 只取前 N 个,对应探针的 maxResults
 */
export function deepQuerySelectorAllExpr(selector: string, limit?: number): string {
  const sel = JSON.stringify(selector);
  const tail = limit == null ? "r" : `r.slice(0, ${Math.max(0, Math.floor(limit))})`;
  return `(function(){
  var MAX = ${SHADOW_WALK_MAX_DEPTH};
  function q(sel, root, depth) {
    var acc = Array.prototype.slice.call(root.querySelectorAll(sel));
    if (depth >= MAX) return acc;
    var hosts = root.querySelectorAll("*");
    for (var i = 0; i < hosts.length; i++) {
      var sr = hosts[i].shadowRoot;
      if (sr) acc = acc.concat(q(sel, sr, depth + 1));
    }
    return acc;
  }
  var r = q(${sel}, document, 0);
  return ${tail};
})()`;
}

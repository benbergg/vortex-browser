/**
 * Description: 穿 open shadow 的选择器求值表达式,供 CDP Runtime.evaluate 用。
 * 与 styleProbeFunc 内联的 queryAllDeep 必须返回同一集合——两侧错一个元素,
 * 后续按下标对齐的字体数据就会挂到别的元素上。deep-query-expr.test.ts 行为对拍。
 */

/** 与 styleProbeFunc 里的 SHADOW_WALK_MAX_DEPTH 同值。 */
export const SHADOW_WALK_MAX_DEPTH = 8;

/**
 * 元素指纹:两侧数量相同但顺序不同时,只校验 count 会把字体静默挂到别的元素上。
 * 必须与 styleProbeFunc 内联的那份一致,deep-query-expr.test.ts 行为对拍。
 */
export function elementFingerprint(el: Element): string {
  return el.tagName + "|" + (el.id || "") + "|" + (el.textContent || "").length;
}

/** 在一个元素数组上求指纹数组,供 Runtime.callFunctionOn 用(与取 objectId 同源)。 */
export const FINGERPRINT_ON_ARRAY_FN = `function(){
  return Array.prototype.map.call(this, function(el){
    return el.tagName + "|" + (el.id || "") + "|" + (el.textContent || "").length;
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

/**
 * evaluate 返回值序列化的**唯一真源**。
 *
 * 为什么是源码字符串而不是函数:序列化必须在页面内、跨边界之前完成。
 * CDP 的 returnByValue 会先把 host object 压成 `{}`,事后归一化无法恢复
 * (真站实测:github.com 上 Date/Map/Set 全部丢失);而 executeScript 注入时
 * 丢模块作用域,函数引用会 is not defined。一份文本被三条路径共同消费,
 * 测试也从同一文本还原,才不会出现"两份实现同错则全绿"。
 */

export const SERIALIZER_FN_NAME = "__vtxSerialize";

export const SERIALIZER_SOURCE = `function ${SERIALIZER_FN_NAME}(v, d, seen) {
  d = d || 0;
  seen = seen || [];
  if (d > 5) return null;
  if (v === null || v === undefined) return v;
  var t = typeof v;
  if (t === "string" || t === "number" || t === "boolean") return v;
  if (t === "bigint") return { __vortexUnserializable: "BigInt", value: String(v) };
  if (t === "function" || t === "symbol") return undefined;
  if (t !== "object") return v;
  if (seen.indexOf(v) !== -1) return null;
  seen = seen.concat([v]);
  if (Array.isArray(v)) {
    return v.map(function (x) { return ${SERIALIZER_FN_NAME}(x, d + 1, seen); });
  }
  var tag = Object.prototype.toString.call(v).slice(8, -1);
  if (tag === "Date") {
    try { return v.toJSON(); } catch (e) { return { __vortexUnserializable: "Date" }; }
  }
  if (tag === "Error" || (v.name && String(v.name).slice(-5) === "Error")) {
    var eo = { name: v.name, message: v.message };
    if (v.stack) eo.stack = v.stack;
    return eo;
  }
  if (tag === "Map" || tag === "Set" || tag === "NodeList") {
    return Array.from(v).map(function (x) { return ${SERIALIZER_FN_NAME}(x, d + 1, seen); });
  }
  if (/^(Ui|I)nt(8|16|32)(Clamped)?Array$|^Float(32|64)Array$|^Big(Ui|I)nt64Array$/.test(tag)) {
    return Array.from(v).map(function (x) { return ${SERIALIZER_FN_NAME}(x, d + 1, seen); });
  }
  // 品牌命中还须无可枚举自有字段才认:防页面用 Symbol.toStringTag 伪造导致丢字段
  var bare = Object.keys(v).length === 0;
  if (bare) {
    if (tag === "Promise") {
      return { __vortexUnserializable: "Promise", hint: "await it in your code, e.g. return await expr" };
    }
    if (tag === "WeakMap" || tag === "WeakSet" || tag === "WeakRef" ||
        tag === "FinalizationRegistry" || tag === "SharedArrayBuffer") {
      return { __vortexUnserializable: tag };
    }
    if (tag === "ArrayBuffer" || tag === "DataView") {
      var m = { __vortexUnserializable: tag };
      // detached buffer 上读 byteLength 抛 TypeError,生成 marker 本身不许抛
      try { m.byteLength = v.byteLength; } catch (e) {}
      return m;
    }
    if (tag === "RegExp") {
      return { __vortexUnserializable: "RegExp", source: v.source, flags: v.flags };
    }
  }
  var o = {};
  for (var k in v) {
    if (Object.prototype.hasOwnProperty.call(Object.prototype, k)) continue;
    try {
      var vv = v[k];
      if (typeof vv === "function" || typeof vv === "symbol") continue;
      o[k] = ${SERIALIZER_FN_NAME}(vv, d + 1, seen);
    } catch (e) { /* 取不到的字段跳过 */ }
  }
  return o;
}`;

/** 从真源文本还原出可调用的函数。测试与非注入场景用,注入路径直接消费文本。 */
export function loadSerializer(): (v: unknown, d?: number) => unknown {
  return new Function(`${SERIALIZER_SOURCE}; return ${SERIALIZER_FN_NAME};`)() as (
    v: unknown,
    d?: number,
  ) => unknown;
}

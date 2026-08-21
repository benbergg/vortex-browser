import { describe, it, expect } from "vitest";
import { SERIALIZER_SOURCE, SERIALIZER_FN_NAME, loadSerializer } from "../src/lib/evaluate-serializer.js";

// 真源是一份源码字符串:测试用 new Function 还原它,注入与 CDP 也消费同一份文本。
// 三处同源,因此不存在"两份实现同错则全绿"。
const S = loadSerializer();

describe("SERIALIZER_SOURCE 自包含性", () => {
  it("源码里定义了约定的函数名", () => {
    expect(SERIALIZER_SOURCE).toContain(`function ${SERIALIZER_FN_NAME}`);
  });

  it("不引用任何模块作用域标识符(注入后会 is not defined)", () => {
    const src = SERIALIZER_SOURCE.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(src).not.toMatch(/\bimport\b|\brequire\(|\bexports\b/);
  });
});

describe("直通值", () => {
  const cases: Array<[string, unknown, unknown]> = [
    ["字符串", "x", "x"],
    ["数字", 42, 42],
    ["布尔", true, true],
    ["null", null, null],
    ["undefined", undefined, undefined],
    ["普通对象", { a: 1 }, { a: 1 }],
    ["数组", [1, 2], [1, 2]],
    ["嵌套普通对象", { a: { b: { c: 1 } } }, { a: { b: { c: 1 } } }],
    ["空对象仍是空对象", {}, {}],
    ["嵌套空对象仍是空对象", { a: {} }, { a: {} }],
  ];
  for (const [label, input, expected] of cases) {
    it(label, () => expect(S(input)).toEqual(expected));
  }
});

describe("已支持品牌", () => {
  it("Date → ISO 字符串", () => expect(S(new Date(0))).toBe("1970-01-01T00:00:00.000Z"));
  it("Map → 键值对数组", () => expect(S(new Map([[1, "a"]]))).toEqual([[1, "a"]]));
  it("Set → 数组", () => expect(S(new Set([1, 2]))).toEqual([1, 2]));
  it("Uint8Array → 数组", () => expect(S(new Uint8Array([1, 2]))).toEqual([1, 2]));
  it("Error → 平铺对象", () => {
    const e = Object.assign(new TypeError("boom"), { stack: "st" });
    expect(S(e)).toEqual({ name: "TypeError", message: "boom", stack: "st" });
  });
});

describe("不可序列化品牌 → 自陈 marker", () => {
  it("Promise", () => {
    expect(S(Promise.resolve(1))).toEqual({
      __vortexUnserializable: "Promise",
      hint: "await it in your code, e.g. return await expr",
    });
  });
  it("嵌套 Promise 只影响该字段", () => {
    expect(S({ name: "x", data: Promise.resolve(1) })).toEqual({
      name: "x",
      data: { __vortexUnserializable: "Promise", hint: "await it in your code, e.g. return await expr" },
    });
  });
  it("WeakMap / WeakSet", () => {
    expect(S(new WeakMap())).toEqual({ __vortexUnserializable: "WeakMap" });
    expect(S(new WeakSet())).toEqual({ __vortexUnserializable: "WeakSet" });
  });
  it("WeakRef / FinalizationRegistry", () => {
    expect(S(new WeakRef({}))).toEqual({ __vortexUnserializable: "WeakRef" });
    expect(S(new FinalizationRegistry(() => {}))).toEqual({ __vortexUnserializable: "FinalizationRegistry" });
  });
  it("ArrayBuffer 带 byteLength", () => {
    expect(S(new ArrayBuffer(8))).toEqual({ __vortexUnserializable: "ArrayBuffer", byteLength: 8 });
  });
  it("DataView 带 byteLength", () => {
    expect(S(new DataView(new ArrayBuffer(4)))).toEqual({ __vortexUnserializable: "DataView", byteLength: 4 });
  });
  it("RegExp 保留 source 与 flags,不退化成字符串", () => {
    expect(S(/ab+c/gi)).toEqual({ __vortexUnserializable: "RegExp", source: "ab+c", flags: "gi" });
  });
  it("BigInt 转十进制字符串", () => {
    expect(S(BigInt("9007199254740993"))).toEqual({
      __vortexUnserializable: "BigInt",
      value: "9007199254740993",
    });
  });
});

describe("边界", () => {
  // detached buffer 上读 byteLength 会抛 TypeError;marker 生成过程本身不许抛
  it("detached DataView 不抛错,省略 byteLength", () => {
    const ab = new ArrayBuffer(8);
    const dv = new DataView(ab);
    structuredClone(ab, { transfer: [ab] });
    expect(() => S(dv)).not.toThrow();
    expect(S(dv)).toEqual({ __vortexUnserializable: "DataView" });
  });

  it("嵌套 detached DataView 不吞掉该字段", () => {
    const ab = new ArrayBuffer(8);
    const dv = new DataView(ab);
    structuredClone(ab, { transfer: [ab] });
    expect(S({ v: dv })).toEqual({ v: { __vortexUnserializable: "DataView" } });
  });

  // Symbol.toStringTag 可被页面伪造;带数据字段的伪造对象必须保住字段
  it("伪造 toStringTag 的普通对象不丢字段", () => {
    const fake = { foo: 1, [Symbol.toStringTag]: "Promise" };
    expect(S(fake)).toEqual({ foo: 1 });
  });

  it("伪造 toStringTag 且无自有字段时按 marker(本来就是空对象)", () => {
    const fake = Object.defineProperty({}, Symbol.toStringTag, { value: "WeakMap" });
    expect(S(fake)).toEqual({ __vortexUnserializable: "WeakMap" });
  });

  it("循环引用不栈溢出,自引用位置置 null", () => {
    const a: Record<string, unknown> = { n: 1 };
    a.self = a;
    expect(() => S(a)).not.toThrow();
    expect(S(a)).toEqual({ n: 1, self: null });
  });

  it("超过深度上限的层级置 null", () => {
    expect(S({ a: { b: { c: { d: { e: { f: { g: 1 } } } } } } }))
      .toEqual({ a: { b: { c: { d: { e: { f: null } } } } } });
  });

  it("函数与 symbol 值被丢弃", () => {
    expect(S({ f: () => 1, s: Symbol("x"), keep: 1 })).toEqual({ keep: 1 });
  });

  it("构造器被页面重命名仍按品牌路由", () => {
    class Renamed extends Map {}
    Object.defineProperty(Renamed, "name", { value: "e" });
    expect(S(new Renamed([[1, "a"]]))).toEqual([[1, "a"]]);
  });
});

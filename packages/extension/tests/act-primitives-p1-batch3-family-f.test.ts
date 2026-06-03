import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * 回归锁:act 原语白盒审计批次 3 —— 族 F(TYPE 逐字累加坏受控 + 不清空 + 非 text 垃圾值)。
 * TYPE 的 input/textarea page-side 路径原用 `el.value += char` 直接赋值:
 *  #8 被 React/Vue 受控 value tracker 吞;#9 不清空旧值得到拼接;#10 number/date 逐字
 *  无效中间态被拒。修:原生 value setter 累加(受控同步)+ clear-before + 非 text 类型
 *  整体写入 + 回读 NO_EFFECT。保留合成 key 事件(keydown/keyup)不丢(bench 依赖)。
 *  page-side inline func 不可 import,source-grep 守护;真实行为 live 验证(报告 §26)。
 *  2026-06-03 act 原语白盒审计。
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const DOM_SRC = readFileSync(join(__dirname, "../src/handlers/dom.ts"), "utf8");

// TYPE 的 input/textarea 分支区间(在 page-side-dispatch 路径内)
const typeIdx = DOM_SRC.indexOf("input / textarea path");
const TYPE_BLOCK = DOM_SRC.slice(typeIdx, typeIdx + 4200);

describe("族 F #8 — TYPE 受控组件用原生 value setter 累加不被吞", () => {
  it("不再裸用 el.value += char,改原生 setter", () => {
    expect(TYPE_BLOCK).not.toMatch(/el\.value \+= char/);
    expect(TYPE_BLOCK).toMatch(/const nativeSet = proto/);
    expect(TYPE_BLOCK).toMatch(/nativeSet\.call\(el, v\)/);
  });

  it("按元素类型选 prototype(textarea/input)", () => {
    expect(TYPE_BLOCK).toMatch(/el instanceof HTMLTextAreaElement[\s\S]{0,120}HTMLTextAreaElement\.prototype/);
  });

  it("仍保留合成 key 事件(bench 依赖,不丢 keydown/keyup)", () => {
    expect(TYPE_BLOCK).toMatch(/new KeyboardEvent\("keydown"/);
    expect(TYPE_BLOCK).toMatch(/new KeyboardEvent\("keyup"/);
  });
});

describe("族 F #9 — TYPE clear-before(type 替换而非拼接)", () => {
  it("输入前先 setValue('') 清空", () => {
    expect(TYPE_BLOCK).toMatch(/clear-before/);
    expect(TYPE_BLOCK).toMatch(/setValue\(""\);/);
  });

  it("clear 在逐字循环之前", () => {
    const clearIdx = TYPE_BLOCK.indexOf('setValue("");');
    const loopIdx = TYPE_BLOCK.indexOf("for (const char of txt)");
    expect(clearIdx).toBeGreaterThan(-1);
    expect(loopIdx).toBeGreaterThan(-1);
    expect(clearIdx).toBeLessThan(loopIdx);
  });
});

describe("族 F #10 — TYPE 非 text 类型整体写入不逐字", () => {
  it("number/date 等非 charByChar 类型整体 setValue(txt) 一次", () => {
    expect(TYPE_BLOCK).toMatch(/const charByChar =/);
    expect(TYPE_BLOCK).toMatch(/\["text", "search", "tel", "url", "email", "password", ""\]\.includes\(inputType\)/);
    expect(TYPE_BLOCK).toMatch(/if \(!charByChar\)[\s\S]{0,120}setValue\(txt\)/);
  });
});

describe("族 A 一致 — TYPE 回读校验非空→空报 NO_EFFECT", () => {
  it("type 后回读 el.value,非空 text 读回空报 NO_EFFECT", () => {
    expect(TYPE_BLOCK).toMatch(
      /String\(txt\) !== "" && \(el as HTMLInputElement\)\.value === ""/,
    );
    const idx = TYPE_BLOCK.indexOf('String(txt) !== "" && (el as HTMLInputElement).value === ""');
    expect(TYPE_BLOCK.slice(idx, idx + 200)).toMatch(/errorCode:\s*"NO_EFFECT"/);
  });
});

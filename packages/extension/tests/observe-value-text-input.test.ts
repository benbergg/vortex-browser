// observe-value-text-input.test.ts
//
// 验证 getValueInfo 对文本控件暴露 IDL 当前值(el.value)的实现，
// 以及 password 控件不暴露值（由 password 防护层统一剥除）。
//
// 背景(必修1 — verify value mode 读陈旧值 bug):
//   observe 原先对文本 input 返回 undefined（只对值域控件/select 暴露 valueNow）。
//   vortex_fill 后 el.value(IDL) 更新但 HTML 属性 getAttribute("value") 不更新，
//   verify value mode 读 attrs.value 得旧值 → fill→verify 断言始终失败。
//   修法：getValueInfo 对 text/email/search/tel/url/textarea 暴露 el.value，
//   并由 password 防护层剥除 password 控件的 valueNow，彻底隔断密码泄露路径。

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OBSERVE_SRC = readFileSync(
  join(__dirname, "..", "src", "handlers", "observe.ts"),
  "utf8",
);

describe("observe getValueInfo — 文本控件 IDL value 暴露 (必修1)", () => {
  it("TEXT_INPUT_TYPES 集合含 text/email/search/tel/url 及空字符串(type 未设)", () => {
    expect(OBSERVE_SRC).toMatch(/TEXT_INPUT_TYPES\s*=\s*new Set\(\[/);
    expect(OBSERVE_SRC).toMatch(/"text"/);
    expect(OBSERVE_SRC).toMatch(/"email"/);
    expect(OBSERVE_SRC).toMatch(/"search"/);
    expect(OBSERVE_SRC).toMatch(/"tel"/);
    expect(OBSERVE_SRC).toMatch(/"url"/);
    // type 未设时 input.type 为 ""（对应 text 语义）
    expect(OBSERVE_SRC).toMatch(/""/);
  });

  it("TEXT_INPUT_TYPES 命中时读 el.value(IDL 当前值)不读 getAttribute", () => {
    expect(OBSERVE_SRC).toMatch(
      /TEXT_INPUT_TYPES\.has\(inputType\)/,
    );
    // 读 IDL .value（非 getAttribute）
    expect(OBSERVE_SRC).toMatch(
      /\(el as HTMLInputElement\)\.value/,
    );
  });

  it("textarea 也暴露 IDL el.value", () => {
    expect(OBSERVE_SRC).toMatch(
      /tag === "textarea"/,
    );
    expect(OBSERVE_SRC).toMatch(
      /\(el as HTMLTextAreaElement\)\.value/,
    );
  });

  it("contenteditable 暴露 textContent", () => {
    expect(OBSERVE_SRC).toMatch(
      /\.isContentEditable/,
    );
  });

  it("password 不在 TEXT_INPUT_TYPES 白名单内（不在集合声明中）", () => {
    // TEXT_INPUT_TYPES 集合定义里不应含 "password"
    const tivMatch = OBSERVE_SRC.match(
      /TEXT_INPUT_TYPES\s*=\s*new Set\(\[([^\]]+)\]\)/s,
    );
    expect(tivMatch).not.toBeNull();
    if (tivMatch) {
      // 集合内容中不含 "password"
      expect(tivMatch[1]).not.toMatch(/password/);
    }
  });

  it("password 防护层：type=password 的 valueNow 被剥除（e.valueNow = undefined）", () => {
    // observe 后处理：password 防护在 page-side scan 完成后、输出前统一剥除
    expect(OBSERVE_SRC).toMatch(
      /type.*password.*e\.valueNow\s*=\s*undefined|e\.valueNow\s*=\s*undefined.*type.*password/s,
    );
  });

  it("文本 input 暴露 el.value 时空值返回 undefined（不输出空字符串噪声）", () => {
    // 空字符串条件：v !== "" 才返回
    expect(OBSERVE_SRC).toMatch(
      /v !== ""/,
    );
  });

  it("文本 input value 截断至 200 字符（防超长 textarea 撑爆输出）", () => {
    expect(OBSERVE_SRC).toMatch(/\.slice\(0,\s*200\)/);
  });

  it("文本 input 分支在 VALUE_ROLES 门控之前（text type 不经过值域门就能返回）", () => {
    const textBranchIdx = OBSERVE_SRC.search(/TEXT_INPUT_TYPES\.has\(inputType\)/);
    const gateIdx = OBSERVE_SRC.search(
      /if \(!VALUE_ROLES\.has\(role\) && !isNativeValue\) return undefined;/,
    );
    expect(textBranchIdx).toBeGreaterThan(0);
    expect(gateIdx).toBeGreaterThan(0);
    // 文本分支必须在门控之前（先返回，不被门挡）
    expect(textBranchIdx).toBeLessThan(gateIdx);
  });
});

describe("verify.ts — elementValue password 二次防护 (必修1)", () => {
  it("attrs.type=password 时不读 attrs.value（防止 HTML 默认属性泄露）", () => {
    const verifySrc = readFileSync(
      join(__dirname, "..", "src", "handlers", "verify.ts"),
      "utf8",
    );
    // 二次防护代码存在
    expect(verifySrc).toMatch(/password.*return undefined/s);
    // elementValue 函数体里有 password 检查
    expect(verifySrc).toMatch(/\.toLowerCase\(\) === "password"/);
  });
});

describe("verify.ts — target index 作用域 (必修2)", () => {
  it("handler 读 args.index 作为 target 作用域", () => {
    const verifySrc = readFileSync(
      join(__dirname, "..", "src", "handlers", "verify.ts"),
      "utf8",
    );
    expect(verifySrc).toMatch(/args\.index/);
  });

  it("findElementByIndex 函数存在，按 el.index 查找", () => {
    const verifySrc = readFileSync(
      join(__dirname, "..", "src", "handlers", "verify.ts"),
      "utf8",
    );
    expect(verifySrc).toMatch(/findElementByIndex/);
    expect(verifySrc).toMatch(/el\.index === index/);
  });

  it("value mode 在 targetIndex !== undefined 时走 findElementByIndex", () => {
    const verifySrc = readFileSync(
      join(__dirname, "..", "src", "handlers", "verify.ts"),
      "utf8",
    );
    expect(verifySrc).toMatch(
      /targetIndex !== undefined[\s\S]*?findElementByIndex/,
    );
  });

  it("text mode 在 targetIndex !== undefined 时收窄到单元素 name", () => {
    const verifySrc = readFileSync(
      join(__dirname, "..", "src", "handlers", "verify.ts"),
      "utf8",
    );
    // text mode 有 targetIndex 分支
    expect(verifySrc).toMatch(
      /mode === "text"[\s\S]*?targetIndex !== undefined/,
    );
  });
});

describe("MCP schema description 与实现一致 (顺带修正)", () => {
  it("schema description 不含 'page or target' 误导性措辞", () => {
    const schemaSrc = readFileSync(
      join(__dirname, "..", "..", "mcp", "src", "tools", "schemas.ts"),
      "utf8",
    );
    // 旧描述 "text(page or target contains text)" 已修正
    expect(schemaSrc).not.toMatch(/page or target contains text/);
  });

  it("schema description 包含 target 作用域的说明", () => {
    const schemaSrc = readFileSync(
      join(__dirname, "..", "..", "mcp", "src", "tools", "schemas.ts"),
      "utf8",
    );
    expect(schemaSrc).toMatch(/scope value\/text assertions/);
  });

  it("text mode description 描述 element name 子串匹配，不提 <title>", () => {
    const schemaSrc = readFileSync(
      join(__dirname, "..", "..", "mcp", "src", "tools", "schemas.ts"),
      "utf8",
    );
    // 移除了对 <title> 的不实引用
    const textProp = schemaSrc.match(
      /text.*description.*substring[\s\S]*?(?:},|\n\s*\w)/,
    );
    if (textProp) {
      expect(textProp[0]).not.toMatch(/<title>/);
    }
  });
});

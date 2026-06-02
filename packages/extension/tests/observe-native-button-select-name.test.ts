import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * 真实站(saucedemo)端到端 dogfood(2026-06-02 round 9)发现的两类原生表单控件
 * 命名/取值盲区,均在 getAccessibleName / getValueInfo:
 *
 * AH:<input type=submit|button|reset|image> 的可访问名是 value 属性(HTML-AAM)。
 *   saucedemo 登录/结账按钮都是 <input type=submit value="Login/Continue">,旧逻辑
 *   只读 label/placeholder → 全显示为无名 [button],agent 不知是 Login/Submit/Search。
 *
 * AI:<select> 旧逻辑落到 textContent 兜底,而 select 的 textContent 是全部 <option>
 *   文本拼接("Name (A to Z)Name (Z to A)Price..."噪声)。名应来自 label/aria;当前
 *   选中值改由 getValueInfo 以 value= 暴露(选项是有界标签,安全)。
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const OBSERVE_SRC = readFileSync(
  join(__dirname, "..", "src", "handlers", "observe.ts"),
  "utf8",
);

describe("observe 原生 button/select 命名与取值(2026-06-02 saucedemo dogfood AH/AI)", () => {
  it("AH:input submit/button/reset/image 用 value 作可访问名,缺省回退类型默认名", () => {
    expect(OBSERVE_SRC).toMatch(
      /t === "submit" \|\| t === "button" \|\| t === "reset" \|\| t === "image"/,
    );
    // value 作名(normName 包装)。
    expect(OBSERVE_SRC).toMatch(/const v = \(el as HTMLInputElement\)\.value;\s*\n\s*if \(v\) return normName\(v\);/);
    // 缺省回退:submit→Submit、reset→Reset、image→Submit Query。
    expect(OBSERVE_SRC).toMatch(/if \(t === "submit"\) return "Submit";/);
    expect(OBSERVE_SRC).toMatch(/if \(t === "reset"\) return "Reset";/);
    expect(OBSERVE_SRC).toMatch(/if \(t === "image"\) return "Submit Query";/);
  });

  it("AH:image 类型优先取 alt(HTML-AAM:alt > value > 默认名)", () => {
    expect(OBSERVE_SRC).toMatch(
      /if \(t === "image"\) \{\s*\n\s*const alt = el\.getAttribute\("alt"\);\s*\n\s*if \(alt\) return normName\(alt\);/,
    );
  });

  it("AH:value 名只用于 submit/button/reset/image,绝不暴露 text/password 的 value", () => {
    // 防回归:value 取名必须被 type 白名单包住,不能裸读任意 input.value。
    const submitIdx = OBSERVE_SRC.search(
      /t === "submit" \|\| t === "button" \|\| t === "reset" \|\| t === "image"/,
    );
    const valueIdx = OBSERVE_SRC.search(/const v = \(el as HTMLInputElement\)\.value;\s*\n\s*if \(v\) return normName\(v\);/);
    expect(submitIdx).toBeGreaterThan(0);
    expect(valueIdx).toBeGreaterThan(submitIdx); // value 读取在白名单判断之内/之后
  });

  it("AI:SELECT 纳入 INPUT/TEXTAREA 命名分支,不落到 textContent(避免 options 拼接噪声)", () => {
    expect(OBSERVE_SRC).toMatch(
      /el\.tagName === "INPUT" \|\|\s*\n\s*el\.tagName === "TEXTAREA" \|\|\s*\n\s*el\.tagName === "SELECT"/,
    );
  });

  it("AI:getValueInfo 暴露原生 select 当前选中项文本(selectedOptions,有界标签安全)", () => {
    expect(OBSERVE_SRC).toMatch(/if \(tag === "select"\)/);
    expect(OBSERVE_SRC).toMatch(/\(el as HTMLSelectElement\)\.selectedOptions/);
    // multiple 多选项逗号连接;空选 undefined。
    expect(OBSERVE_SRC).toMatch(/\.map\(\(o\) => o\.text\)\.join\(", "\)/);
    expect(OBSERVE_SRC).toMatch(/if \(opts\.length === 0\) return undefined;/);
  });

  it("AH 连带:getRole 把 input reset/image 也映射 button(旧逻辑只映 submit/button)", () => {
    // reset/image 同属 button(HTML-AAM),旧逻辑漏映 → 错报 textbox。
    expect(OBSERVE_SRC).toMatch(
      /t === "submit" \|\| t === "button" \|\| t === "reset" \|\| t === "image"\) return "button";/,
    );
  });

  it("AI:select 取值分支在 VALUE_ROLES 门控之前(combobox/listbox role 不会被门挡掉)", () => {
    const selIdx = OBSERVE_SRC.search(/if \(tag === "select"\)/);
    const gateIdx = OBSERVE_SRC.search(/if \(!VALUE_ROLES\.has\(role\) && !isNativeValue\) return undefined;/);
    expect(selIdx).toBeGreaterThan(0);
    expect(gateIdx).toBeGreaterThan(0);
    expect(selIdx).toBeLessThan(gateIdx);
  });
});

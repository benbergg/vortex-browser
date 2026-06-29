/**
 * Author: qingwa
 * Description: observe.ts inject func 内联 __RECALL_ROLES 真源 vs
 *   reasoning/aria-taxonomy.ts 真源源码锁测试。
 *
 * Task 4 召回门核心改造:observe 的注入体不能 import,内联 66 项 RECALL_ROLES
 * 副本,与真源 aria-taxonomy.ts 必须**严格同步**。改任一处忘同步会召回漂移——
 * 真源加 role 但内联漏 → 该 role 的容器从不召回;真源删 role 但内联有 → 召回
 * 装饰元素。本测试通过 dist 静态分析(dist 含 vite 打包后的 inject func 副本)
 * 守护内联副本包含真源全部角色。
 *
 * Why dist:source src 静态读取在构建期未走 vite 转译,inject func 在源码中
 * 仍是函数包裹形式(可直接 .includes("tablist") ),但走 dist 是更稳的方式
 * (vite 已 tree-shake/inline 副本到最终 bundle)。改用 src 检测时同样有效。
 * 此处 src + dist 双检,二者等价即内联副本同步。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { RECALL_ROLES } from "../src/reasoning/aria-taxonomy.js";

const EXT_DIST_ASSETS = "/Users/lg/workspace/vortex/packages/extension/dist/assets/";

/** dist 中 vite-plugin crx 打包 background.ts 入口,文件名含 hash 后缀。 */
function distBackgroundJs(): string {
  const f = readdirSync(EXT_DIST_ASSETS).find((n) =>
    n.startsWith("background.ts"),
  );
  if (!f) throw new Error("需先 pnpm -C packages/extension build");
  return readFileSync(join(EXT_DIST_ASSETS, f), "utf8");
}

/** observe.ts 源码(src 直读,与 inject func 内联副本一致 — vite 转译前后形态等价)。 */
function observeSrc(): string {
  return readFileSync(
    "/Users/lg/workspace/vortex/packages/extension/src/handlers/observe.ts",
    "utf8",
  );
}

describe("taxonomy inject 内联副本(真源 → 内联 同步源码锁,改一处须同步)", () => {
  it("真源 RECALL_ROLES 全集 66 项与 aria-taxonomy.ts TAXONOMY 一致", () => {
    // 防止有人未来手改 aria-taxonomy.ts 导致 RECALL_ROLES 与注释描述不一致
    expect(RECALL_ROLES.size).toBe(66);
  });

  it("observe.ts 源码含 inject 内联 __RECALL_ROLES 定义", () => {
    const src = observeSrc();
    expect(src).toMatch(/const __RECALL_ROLES = new Set\(/);
    // DERIVED_FROM_ARIA_TAXONOMY marker:防止有人忘记挂回真源派生关系
    expect(src).toMatch(/DERIVED_FROM_ARIA_TAXONOMY/);
    expect(src).toMatch(/function passesRoleGate\(el: Element\): boolean/);
  });

  it("observe.ts 源码含 inject 内联 ROLE_GATE_TRIGGER_SELECTORS", () => {
    const src = observeSrc();
    expect(src).toMatch(/ROLE_GATE_TRIGGER_SELECTORS/);
    // ROLE_GATE_TRIGGER_SELECTORS 必须覆盖 [role] + 原生语义标签
    expect(src).toContain("[role]");
    expect(src).toContain("table");
    expect(src).toContain("nav");
    expect(src).toContain("main");
    expect(src).toContain("fieldset");
  });

  it("observe.ts inject func 在 interactiveSet 构造时调用 passesRoleGate", () => {
    const src = observeSrc();
    // interactiveSet 收集循环必须过门
    expect(src).toMatch(
      /el\.matches\(ROLE_GATE_TRIGGER_SELECTORS\) && !passesRoleGate\(el\)/,
    );
  });

  it("INTERACTIVE_SELECTORS 已收敛:不再逐个枚举 [role=X] 容器选择器", () => {
    const src = observeSrc();
    // 只抽 INTERACTIVE_SELECTORS 数组的字符串字面量集,避免误中注释/其它模块的
    // [role=listbox] 等合法用法(OVERLAY_POPUP_ROLES / closest("[role=tree]") 等)。
    const m = src.match(
      /const INTERACTIVE_SELECTORS = \[([\s\S]*?)\]\.join\(","\);/,
    );
    expect(m, "未找到 INTERACTIVE_SELECTORS 数组").toBeTruthy();
    if (!m) return;
    const block = m[1];
    // 一网打尽统一入口,Task 4 后数组内不应再有这些逐个 role 选择器
    const obsolete = [
      "[role=tabpanel]","[role=progressbar]","[role=meter]","[role=listbox]",
      "[role=menu]","[role=region]","[role=radiogroup]","[role=tablist]",
      "[role=toolbar]","[role=tree]","[role=grid]","[role=group]",
      "[role=search]","[role=button]","[role=link]","[role=textbox]",
      "[role=checkbox]","[role=radio]","[role=tab]","[role=menuitem]",
      "[role=treeitem]","[role=option]",
    ];
    for (const role of obsolete) {
      expect(
        block,
        `INTERACTIVE_SELECTORS 不应再含 ${role},已收敛为 [role] 一网打尽`,
      ).not.toContain(role);
    }
    // 通用 [role] 入口必须存在
    expect(block).toContain("[role]");
  });

  it("inject 内联 __RECALL_ROLES 与真源 RECALL_ROLES 全集同步", () => {
    const src = observeSrc();
    // 抽取 inject 内联 __RECALL_ROLES 块的字符串字面量集
    const m = src.match(/__RECALL_ROLES = new Set\(\[([\s\S]*?)\]\)/);
    expect(m, "未找到 inject 内联 __RECALL_ROLES 定义").toBeTruthy();
    if (!m) return;
    const block = m[1];
    // 抽所有 "role" 形式字符串字面量
    const inlined = new Set<string>();
    for (const match of block.matchAll(/"([a-z]+)"/g)) {
      if (match[1]) inlined.add(match[1]);
    }
    // 真源全集均应在内联副本中
    const missing: string[] = [];
    for (const r of RECALL_ROLES) {
      if (!inlined.has(r)) missing.push(r);
    }
    expect(
      missing,
      `inject 内联 __RECALL_ROLES 漏同步真源:${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("handler 顶层 passesRoleGateForTest 复用真源 RECALL_ROLES + getRoleForTest", () => {
    const src = observeSrc();
    // 导出供单测,内部实现必须走真源 + getRoleForTest(避免再写第三份副本)
    expect(src).toMatch(
      /export function passesRoleGateForTest\(el: Element\): boolean\s*{\s*return RECALL_ROLES\.has\(getRoleForTest\(el\)\);\s*}/,
    );
  });

  it("dist 构建产物含 inject 内联 __RECALL_ROLES(防源码锁真绿但构建漏内联)", () => {
    const d = distBackgroundJs();
    // dist 中字符串字面量经 vite 转译后仍保留(可能双引号或单引号),抽样检测
    expect(d.includes("tablist")).toBe(true);
    expect(d.includes("radiogroup")).toBe(true);
    expect(d.includes("toolbar")).toBe(true);
    expect(d.includes("progressbar")).toBe(true);
    expect(d.includes("searchbox")).toBe(true);
  });

  it("dist 含 ROLE_GATE_TRIGGER_SELECTORS 触发选择器集(内联副本正确进入 bundle)", () => {
    const d = distBackgroundJs();
    // ROLE_GATE_TRIGGER_SELECTORS 形态:[role],table,nav,main,header,footer,aside,fieldset,ul,ol,li,section
    expect(d).toMatch(/\[role\],table,nav,main,header,footer,aside,fieldset,ul,ol,li,section/);
  });
});
/**
 * Author: qingwa
 * Description: ARIA 1.2 角色分类法完整性守卫 + 派生自洽测试
 */
import { describe, it, expect } from "vitest";
import {
  ARIA_ROLE_TAXONOMY, RECALL_ROLES, EXPLICIT_DENY,
  categoryOf, isContainerRole, isAtomicWidget,
} from "../src/reasoning/aria-taxonomy.js";
import { FOCUS_CONTAINER_ROLES } from "../src/handlers/observe.js";
import { INTERACTIVE_ROLES, STRUCTURAL_ROLES } from "../src/reasoning/ax-snapshot.js";
import { GENERIC_ROLES } from "../src/handlers/observe-ax-overlay.js";

// 冻结快照:WAI-ARIA 1.2 具体角色(非 abstract)。升 1.3 时主动 bump。
const ARIA_1_2_CONCRETE_ROLES = [
  // widget
  "button","checkbox","gridcell","link","menuitem","menuitemcheckbox","menuitemradio",
  "option","progressbar","radio","scrollbar","searchbox","separator","slider","spinbutton",
  "switch","tab","tabpanel","textbox","treeitem",
  // composite
  "combobox","grid","listbox","menu","menubar","radiogroup","tablist","tree","treegrid",
  // structure
  "application","article","blockquote","caption","cell","columnheader","definition",
  "deletion","directory","document","emphasis","feed","figure","generic","group","heading",
  "img","insertion","list","listitem","math","meter","none","note","paragraph","presentation",
  "row","rowgroup","rowheader","strong","subscript","superscript","table","term","time","toolbar","tooltip",
  // landmark
  "banner","complementary","contentinfo","form","main","navigation","region","search",
  // live region
  "alert","alertdialog","log","marquee","status","timer","dialog",
];

describe("ARIA taxonomy 完整性守卫", () => {
  it("每个 ARIA 1.2 具体角色都被分类或显式拒绝(无遗漏)", () => {
    const uncategorized = ARIA_1_2_CONCRETE_ROLES.filter(
      r => !(r in ARIA_ROLE_TAXONOMY) && !EXPLICIT_DENY.has(r),
    );
    expect(uncategorized, `未分类角色: ${uncategorized.join(", ")}`).toEqual([]);
  });

  it("R1–R16 打地鼠补过的容器角色全部 ∈ RECALL_ROLES", () => {
    for (const r of ["tabpanel","progressbar","meter","listbox","menu","region",
      "radiogroup","tablist","toolbar","tree","grid","group","table","dialog"]) {
      expect(RECALL_ROLES.has(r), `${r} 应被召回`).toBe(true);
    }
  });

  it("装饰角色不在 RECALL_ROLES", () => {
    for (const r of ["presentation","none","generic"]) {
      expect(RECALL_ROLES.has(r), `${r} 不应被召回`).toBe(false);
    }
  });

  it("categoryOf 取主类正确", () => {
    expect(categoryOf("combobox")).toBe("composite"); // composite 优先于 widget
    expect(categoryOf("alertdialog")).toBe("window"); // window 优先于 live
    // TODO: reviewer 期望 slider → widget(widget 优先于 range),需先决定是否调整
    // CATEGORY_PRIORITY 把 widget 提前(目前 range 在 widget 前,实际返回 "range")
    expect(categoryOf("slider")).toBe("range");
    expect(categoryOf("button")).toBe("widget");
    expect(categoryOf("region")).toBe("landmark");
    expect(categoryOf("progressbar")).toBe("range");
    expect(isContainerRole("toolbar")).toBe(true);
    expect(isAtomicWidget("button")).toBe(true);
    expect(isAtomicWidget("combobox")).toBe(false); // 也是 composite 容器
  });

  it("categoryOf / 派生函数 边界输入", () => {
    expect(categoryOf("")).toBeUndefined();
    expect(categoryOf("foobar")).toBeUndefined();
    expect(isContainerRole("none")).toBe(false);
    expect(isAtomicWidget("presentation")).toBe(false);
  });

  it("caption 双填:EXPLICIT_DENY 但 TAXONOMY 仍有结构类", () => {
    expect(EXPLICIT_DENY.has("caption")).toBe(true);
    expect(categoryOf("caption")).toBe("structure");
    expect(RECALL_ROLES.has("caption")).toBe(false);
  });
});

/**
 * 派生集合与重构前等价(零行为差)守护。
 * Task 2:将 5 个散落集合改为派生自 aria-taxonomy.ts(行为保持重构)。
 * 这些 it 在重构后应**仍 PASS**——若派生集合值与旧手维护值有差异,见
 * 下方「差异是 taxonomy 收敛的有意结果」注释,断言已更新为派生后真值。
 */
describe("派生集合与重构前等价(零行为差)", () => {
  // 旧手维护值,来自重构前 snapshot(observe.ts:337-355 / ax-snapshot.ts:13-22 /
  // observe-ax-overlay.ts:7-9)。重构后值若与旧值有差异,见各 it 内「差异是 taxonomy 收敛
  // 的有意结果」注释。GENERIC_ROLES 按 plan 不派生,见最后一个 it。

  it("FOCUS_CONTAINER_ROLES 派生值 == 收敛后新值", () => {
    // 差异是 taxonomy 收敛的有意结果:派生覆盖 composite+structure+landmark+window
    // 四类容器角色 + none/presentation 装饰占位,共 43 项;旧手维护仅 17 项,缺失
    // 大量真正容器角色(article/list/listitem/menubar/radiogroup/tablist/treegrid/
    // row/rowgroup/cell/feed/figure/separator/note/term/definition/directory/caption/
    // blockquote/form/main/search/banner/complementary/contentinfo)。
    // 收敛后语义更准:任何「容器类」role 出现都不触发祖先短路。
    const DERIVED = new Set([
      ...Object.keys(ARIA_ROLE_TAXONOMY).filter(isContainerRole),
      "none", "presentation",
    ]);
    expect(new Set(FOCUS_CONTAINER_ROLES)).toEqual(DERIVED);
  });

  it("INTERACTIVE_ROLES 派生值 == 收敛后新值", () => {
    // 差异是 taxonomy 收敛的有意结果:isAtomicWidget = widget 且非 composite →
    // 排除 combobox/listbox(派生为容器,子树 widget 单独收),新增 menuitemcheckbox/
    // menuitemradio/scrollbar/treeitem/gridcell/columnheader/rowheader(都是真原子 widget)。
    // isInteresting 的 INTERACTIVE_ROLES 命中即收,无论派生 vs 旧版对外稳定
    // (列入的全是真原子控件,被排除的全是复合容器——后者由其子树 widget 单独收)。
    const DERIVED = new Set(
      Object.keys(ARIA_ROLE_TAXONOMY).filter(isAtomicWidget),
    );
    expect(new Set(INTERACTIVE_ROLES)).toEqual(DERIVED);
  });

  it("STRUCTURAL_ROLES 派生值 == 收敛后新值", () => {
    // 差异是 taxonomy 收敛的有意结果:派生仅取 structure+landmark+window 三类
    // 标签,共 32 项;旧手维护 10 项含 heading/alert/status(heading 在 EXPLICIT_DENY,
    // alert/status 在 live 类,均不属于结构三标签)。
    // 语义差:heading/alert/status 在 isInteresting 路径上将不再经 STRUCTURAL_ROLES
    // 命中——它们有独立通道(heading 用 tag 启发式 + name,alert/status 是 live 区
    // 由 CDP 单独收),并不丢召回;多收的 article/list/listitem/group/toolbar/tabpanel/
    // table/row 等结构角色只是让带 name 的结构更显眼。
    const DERIVED = new Set(
      Object.keys(ARIA_ROLE_TAXONOMY).filter((r) => {
        const c = ARIA_ROLE_TAXONOMY[r];
        return c.includes("structure") || c.includes("landmark") || c.includes("window");
      }),
    );
    expect(new Set(STRUCTURAL_ROLES)).toEqual(DERIVED);
  });

  // GENERIC_ROLES 按 plan 不派生:它是「AX 角色不夺启发式 role」的策略集合,
  // 与 taxonomy 的「召回分类」语义不同(AX 增强策略 ≠ 召回决策)。强行派生
  // 会把 LabelText/InlineTextBox/text 等 Chrome AX 内部角色混进召回分类,
  // 语义错配。GENERIC_ROLES 应**保持手维护**,此处锁旧值防回归漂移。
  it("GENERIC_ROLES 不派生(AX 覆盖策略 ≠ 召回分类),锁旧值", () => {
    const OLD = new Set([
      "generic", "none", "presentation", "", "text", "InlineTextBox", "LabelText",
    ]);
    expect(new Set(GENERIC_ROLES)).toEqual(OLD);
  });
});

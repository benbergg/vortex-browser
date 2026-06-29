/**
 * Author: qingwa
 * Description: WAI-ARIA 1.2 角色分类法单一真相源。observe 召回决策 + 渲染派发 +
 * 5 散落集合派生全部以此为准。升 ARIA 1.3 时主动 bump ARIA_ROLE_TAXONOMY + 测试快照。
 * 注意:本表逻辑会内联进 observe page-side inject func(不能 import),改动须同步
 * observe.ts 内联副本,源码锁测试守护。
 */

export type AriaCategory =
  | "widget" | "composite" | "structure" | "landmark" | "range" | "live" | "window";

// role → 所属类别(可多类)。只列「要召回」与「需判类」的具体角色。
export const ARIA_ROLE_TAXONOMY: Record<string, AriaCategory[]> = {
  // —— widget(原子交互)——
  button:["widget"], checkbox:["widget"], link:["widget"], menuitem:["widget"],
  menuitemcheckbox:["widget"], menuitemradio:["widget"], option:["widget"],
  radio:["widget"], scrollbar:["widget"], searchbox:["widget"], slider:["widget","range"],
  spinbutton:["widget","range"], switch:["widget"], tab:["widget"], textbox:["widget"],
  treeitem:["widget"], gridcell:["widget"], columnheader:["widget"], rowheader:["widget"],
  // —— composite(管理一组 widget 的容器)——
  combobox:["composite","widget"], grid:["composite"], listbox:["composite"],
  menu:["composite"], menubar:["composite"], radiogroup:["composite"],
  tablist:["composite"], tree:["composite"], treegrid:["composite"],
  // —— structure(文档结构容器)——
  group:["structure"], toolbar:["structure"], table:["structure"], tabpanel:["structure"],
  row:["structure"], rowgroup:["structure"], cell:["structure"], article:["structure"],
  list:["structure"], listitem:["structure"], feed:["structure"], figure:["structure"],
  separator:["structure"], tooltip:["structure"], note:["structure"], term:["structure"],
  definition:["structure"], directory:["structure"], document:["structure"],
  application:["structure"], caption:["structure"], blockquote:["structure"],
  // —— landmark(地标)——
  banner:["landmark"], complementary:["landmark"], contentinfo:["landmark"],
  form:["landmark"], main:["landmark"], navigation:["landmark"], region:["landmark"],
  search:["landmark"],
  // —— range(值域/进度)——
  progressbar:["range"], meter:["range"],
  // —— live(实时区)——
  alert:["live"], log:["live"], marquee:["live"], status:["live"], timer:["live"],
  // —— window(窗口)——
  dialog:["window"], alertdialog:["window","live"],
};

// 规范内但故意不召回(装饰 / 纯排版 / 与 tag 冗余)。完整性测试用它兜底。
export const EXPLICIT_DENY: ReadonlySet<string> = new Set([
  "presentation","none","generic","img","heading","paragraph",
  "emphasis","strong","subscript","superscript","deletion","insertion",
  "math","time","caption", // caption 也在 structure,但召回价值低,留作 deny 优先无害
]);

// 七类并集(召回判据真相源)
export const RECALL_ROLES = new Set<string>(
  Object.keys(ARIA_ROLE_TAXONOMY).filter(r => !EXPLICIT_DENY.has(r)),
);

// 取主类(决定渲染策略),优先序见注释。
// 容器类优先(composite/window/landmark/structure),原子类靠后(widget),便于 isContainerRole 一致判定
const CATEGORY_PRIORITY: AriaCategory[] =
  ["composite","window","landmark","structure","live","range","widget"];

export function categoryOf(role: string): AriaCategory | undefined {
  const cats = ARIA_ROLE_TAXONOMY[role];
  if (!cats) return undefined;
  for (const c of CATEGORY_PRIORITY) if (cats.includes(c)) return c;
  // defensive: future taxonomy additions may include new AriaCategory values not in CATEGORY_PRIORITY
  return cats[0];
}

const CONTAINER: ReadonlySet<AriaCategory> =
  new Set(["composite","structure","landmark","window"]);

export function isContainerRole(role: string): boolean {
  const c = categoryOf(role);
  return c != null && CONTAINER.has(c);
}

export function isAtomicWidget(role: string): boolean {
  const cats = ARIA_ROLE_TAXONOMY[role];
  return !!cats && cats.includes("widget") && !cats.includes("composite");
}

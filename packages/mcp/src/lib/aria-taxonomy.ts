/**
 * Author: qingwa
 * Description: WAI-ARIA 1.2 角色分类法 MCP 侧镜像(与
 *   packages/extension/src/reasoning/aria-taxonomy.ts 真源镜像同步)。
 *
 *   真源在 extension 包,mcp 包不依赖 extension(单向依赖图:mcp → shared,无 ext),
 *   故在 mcp 侧重建真源,源码锁测试(aria-taxonomy-mirror.test.ts)守护两份大小一致,
 *   任何扩展需同步改动。categoryOf/categoryOf 给 observe-render 的 compound 派发
 *   用,isContainerRole/isAtomicWidget 留作后续调用点备用。
 */

export type AriaCategory =
  | "widget" | "composite" | "structure" | "landmark" | "range" | "live" | "window";

// role → 所属类别(可多类)。只列「要召回」与「需判类」的具体角色。
// 与 extension 真源严格同步,源码锁测试守护大小一致。
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
  "math","time","caption",
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
// packages/vortex-bench/src/runner/fuzz-aria-roles.ts
// vortex-bench 不能 import @vortex-browser/extension,这里硬编码 ARIA 角色分类
// 镜像(与 extension reasoning/aria-taxonomy.ts 真源同步)。
// 源码锁:fuzz-aria-roles.test.ts 读真源 .ts 文件,断言真源每条 role 都进入对应集合。
//
// 与真源的差异:本模块只装 fuzz 关心的两集合子集。
//   - FUZZ_RECALL_CONTAINERS:RECALL_ROLES 中是「容器」的子集
//     (composite / structure / landmark / window,过滤掉 live/range/widget 原子)
//   - FUZZ_DECORATIVE_ROLES:EXPLICIT_DENY 中是「装饰占位」presentation/none/generic
//     三者(其他 deny 角色如 img/heading/paragraph 是 tag 隐式映射,无须 fuzz 种入)
//
// 决策依据:容器类盲点是 Task 4 召回门根因(plan line 633 Task 7),
// 装饰占位是 EXPLICIT_DENY 三件套(observe-role-gate.test.ts:80-83 锁定),
// 两类盲点对 fuzz oracle 价值最高。

// 容器类(挑 fuzz 想覆盖的子集:composite / structure / landmark / window 抽样)
// 真源 RECALL_ROLES 全集 66 项,这里只挑容器类 + 高价值结构容器,便于 oracle 断言。
// 真源有 11 类 composite + 21 structure + 8 landmark + 2 window = 42 项容器类;
// 本镜像覆盖其中有代表性的 18 项,够 fuzz 跑出盲点。
export const FUZZ_RECALL_CONTAINERS: ReadonlySet<string> = new Set([
  // composite
  "tablist", "toolbar", "listbox", "menu", "radiogroup", "tree", "grid",
  "combobox", "menubar", "treegrid",
  // structure(容器类;非 listitem/row/cell 等原子项)
  "tabpanel", "group", "table",
  // landmark
  "navigation", "main", "search", "banner", "contentinfo", "complementary", "form", "region",
]);

// 装饰占位(EXPLICIT_DENY 中是「不描述子树」的真装饰角色)
export const FUZZ_DECORATIVE_ROLES: ReadonlySet<string> = new Set([
  "presentation", "none", "generic",
]);

/** 真源文件路径(测试源码锁用,生产代码不依赖) */
export const ARIA_TAXONOMY_SRC_PATH =
  "/Users/lg/workspace/vortex/packages/extension/src/reasoning/aria-taxonomy.ts";
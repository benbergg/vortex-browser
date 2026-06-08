# REQ-NNN: `vortex_extract` 支持 `img alt` 属性提取(京东自营 + 淘宝/天猫角标通用)

**Author:** qingwa
**Date:** 2026-06-08
**Status:** ✅ 已修复 (方案 A + B 均已实施)
**严重度:** 🟡 P2
**相关 Phase:** Phase 2.x + Phase 5.x 列表/详情角标
**评测来源:** `reports/jd-dogfood-V1/京东独有/JD-UNI-06-京东自营.md` (D2 ⚠️ extract 不提 alt)
**参考:** BUG-009 全闭环模板见 `_meta/P1-1京东根因诊断.md` 6 节 300 行

---

## 1. 现象

**关键观察:**

- 京东自营:12 个 `<img alt="自营">` 匿名 img(空 className,SPA hash 化)
- 9 个 class-based selector(`[class*="self"]` / `[class*="ziying"]` / `[class*="flag"]`)全部 0 命中
- `vortex_observe` **智能把 img alt="自营" 翻译为 [div] "自营" ref** (e96 / e132 / e146) —— vortex 隐藏能力
- **`vortex_extract` 不提取 img alt 属性** → LLM 看不到 alt 文本
- 淘宝 / 天猫角标同问题(角标经常用 `<img alt="天猫积分">` / `<img alt="官方旗舰">`)

**数据引用:**
- `京东独有/JD-UNI-06-京东自营.md` D2 ⚠️:extract target=`[class*="_card_"]` 只召回第一个商品卡,**未提取到任何"自营"文字**
- `京东独有/JD-UNI-06-京东自营.md` D1 ✅:observe 把 img alt 翻译为 [div] "自营" ref,AI 可读

---

## 2. 复现 fixture

**真站复现 URL:** `https://search.jd.com/Search?keyword=iPhone+16`

**复现命令:**
```
vortex_navigate("https://search.jd.com/Search?keyword=iPhone+16")
vortex_wait_for(time=1)
vortex_observe(scope="viewport")  # D1 ✅: 看到 [div] "自营" ref (e96/e132/e146)
vortex_extract(selector="[class*=\"_card_\"]", maxLength=2000)
# → 只召回第一个商品卡的 textContent(准新机 + 慧创手机买手店)
# → 看不到 "自营" 角标文字(img alt 不在 extract 范围)
```

**对比 observe vs extract:**
- `vortex_observe`:`<img alt="自营">` 智能翻译为 `[div] "自营" ref` ✅
- `vortex_extract`:`el.innerText` 读 textContent,不读 alt → ❌

---

## 3. 代码定位

### 3.1 observe 已实现 img alt → ref 翻译

`packages/extension/src/handlers/observe.ts:340-369` —— `iconNameFromClass` 函数
```ts
function iconNameFromClass(el: Element): string {
  const inner = el.querySelector("svg, img") as Element | null;
  if (!inner) return "";
  if (inner.tagName === "svg") {
    const t = inner.querySelector("title")?.textContent?.trim();
    if (t) return t.slice(0, 80);
  } else if (inner.tagName === "IMG") {
    const alt = (inner as HTMLImageElement).alt?.trim();  // ← 读 img alt
    if (alt) return alt.slice(0, 80);
  }
  // ...
}
```

### 3.2 extract 只读 innerText,不读 alt

`packages/extension/src/handlers/content.ts:207`:
```ts
const text = hidden ? "" : (root as HTMLElement).innerText ?? "";
```

`innerText` 是 textContent 的可视化版本,**不包含** `<img alt="...">` 的 alt 属性(alt 是 attribute 不是 text node)。

`packages/extension/src/handlers/content.ts:399`:
```ts
return { result: el.textContent };
```
`textContent` 同样不读 img alt。

### 3.3 已有 V4 修复 observe 不漏抓 sticky bar

`packages/extension/src/handlers/observe.ts:340+` —— V4 BUG-008 修复(commit `bba1190`)在 observe 阶段补抓淘宝详情页 sticky bar div CTA;**本 REQ-NNN 是 extract 阶段的对偶问题**。

### 3.4 淘宝/天猫角标同款问题

淘宝/天猫详情页经常用 `<img alt="天猫积分">` / `<img alt="官方旗舰">` / `<img alt="7天无理由">` 等角标,extract 同款漏抓。

---

## 4. 根因

**逻辑链:**

1. extract 实现:`root.innerText` / `root.textContent` → 这两个 API 都**不读 attribute**(只读 text node + 不渲染元素的 text)
2. `<img alt="自营">` 的 "自营" 在 alt attribute 中,**不是 text node**
3. observe 阶段专门写了 `iconNameFromClass` 读 img alt → 翻译为可读 ref,**绕过了 attribute/text 鸿沟**
4. extract 阶段**没有对偶实现** → 漏抓
5. **不是 vortex 找不到,而是 extract 读不到 attribute**

**为什么 observe 能而 extract 不能:** observe 是"输出 ref 列表"语义,ref name 是字符串,可以任意翻译(iconNameFromClass 就是翻译);extract 是"输出 raw DOM 文本"语义,innerText/textContent 是底层 API,无法直接拿 alt。

---

## 5. Patch 草稿

### 方案 A(推荐):vortex_extract 文本提取增加 img alt 属性(优先级:alt > title > textContent)

`packages/extension/src/handlers/content.ts:207` 修改:
```ts
// 扩展 innerText 提取,优先读取 img alt 属性
const walkWithAlt = (el: Element): string => {
  let s = (el as HTMLElement).innerText ?? "";
  // 补充:对 el 内每个 img 节点,如果有 alt 但 innerText 未包含,追加 alt
  el.querySelectorAll("img[alt]").forEach((img) => {
    const alt = img.getAttribute("alt")?.trim();
    if (alt && !s.includes(alt)) {
      s += ` ${alt}`;  // 追加 alt 到末尾(用户可读)
    }
  });
  return s;
};
const text = hidden ? "" : walkWithAlt(root);
```

**优点:** 简单追加,行为可预期;**缺点:** 可能重复(如果 alt 文字已被 innerText 包含)。

### 方案 B:vortex_extract 新增 `includeAlt: true` 选项(默认开)

`packages/extension/src/handlers/content.ts:10`:
```ts
const includeAlt = args.includeAlt !== false;  // 默认 true
// walkControls 阶段对 img 节点输出 alt 作为 attribute
if (includeAlt && root.tagName === "IMG") {
  const alt = root.getAttribute("alt")?.trim();
  if (alt) parts.push(`[alt: ${alt}]`);
}
```

**优点:** 显式可控,符合 MCP 选项风格;**缺点:** 用户需理解新参数。

### 方案 C:文档化 img alt 已由 observe 处理(extract 不需重复)

`_meta/REQ-NNN-extract_img_alt.md` 末尾加 "评测最佳实践:对 img 角标,优先用 observe 抓 ref(已智能翻译 alt),不用 extract"。**0 代码变更**,P1-1 修复路径沿用 N0059-V4 文档化模式。

**问题:** observe scope=viewport 只抓视口内 ref;评测需要全量数据时仍需 extract。**方案 C 不能完全解决**。

### 5.x 风险点

- 方案 A 简单追加,可能重复(低风险,可加 dedup)
- 方案 B 显式可控,但默认开
- 方案 C 0 风险,但评测全量数据场景需绕路

### 5.y 推荐组合

**方案 A + 方案 B** 同步:方案 A 默认行为补全 img alt(向后兼容);方案 B 加 `includeAlt: false` 选项(显式关闭)。最小代码变更 + 用户显式可控。

---

## 6. 优先级与工作量

- **优先级:** 🟡 P2(评测降级为 observe scope=full,只看不提取,不阻断)
- **工作量:** 0.3d(方案 A:content.ts 加 walkWithAlt 函数 + 5 行代码;方案 B:加 includeAlt 参数 + 1 行)
- **验收:**
  1. 京东自营:`vortex_extract target="[class*=\"_card_\"]"` 召回内容含"自营"字串(12 个 img alt 全部)
  2. 淘宝详情页角标:`vortex_extract target=".tm-detail-meta"` 召回内容含"天猫积分"/"官方旗舰"等 alt 文字
  3. `includeAlt: false` 显式关闭时,行为与当前一致
  4. 跑 `pnpm test` 793 全量无回归

**对应 N0060-V4 行动项:** Phase 7 P2

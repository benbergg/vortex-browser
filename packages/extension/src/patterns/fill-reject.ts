/**
 * 拒绝用 dom_fill / dom_type 原生写值的受控组件清单。
 *
 * 命中任一 closestSelector（el 自身或任一祖先匹配该选择器）时，handler 会抛
 * VtxErrorCode.UNSUPPORTED_TARGET 并提示调用方改走 vortex_fill 的 widget 参数。
 *
 * 为什么用 "closestSelector" 而非复杂 match 函数：
 * - 模式定义需要序列化后跨 frame 注入到页面 context，closest 选择器是可序列化的
 * - 实现简单、覆盖面够；复杂判定放到 commit driver 里做
 *
 * 维护原则：
 * - 只添加"100% 会使 dom_fill 产生 false-positive（DOM 值改了、组件状态没改）"的组件
 * - 非关键分支（如某些 select）可以先不拦，避免过度保护
 */
export interface FillRejectPattern {
  id: string;
  /** CSS 选择器：el.closest(closestSelector) 命中即判定为该 pattern */
  closestSelector: string;
  /** 给代理的提示，说明为什么拒绝 + 应该改用什么工具 */
  reason: string;
  /** 推荐给调用方使用的替代工具（展示在 hint 里） */
  suggestedTool: string;
  /** 可直接照搬的调用示例（给 LLM 看），作为错误消息的处方部分 */
  fixExample: string;
}

export const FILL_REJECT_PATTERNS: FillRejectPattern[] = [
  {
    id: "element-plus-datetime-range",
    closestSelector: ".el-date-editor.el-range-editor",
    reason:
      "Element Plus datetime/date range picker uses internal v-model; setting input.value directly does not update component state.",
    suggestedTool: 'vortex_fill with widget="datetimerange" (or "daterange" for date-only)',
    fixExample:
      'vortex_fill({target:"@eN", widget:"datetimerange", value:{start:"2026-03-01 00:00:00", end:"2026-03-31 23:59:59"}})',
  },
  {
    id: "element-plus-cascader",
    closestSelector: ".el-cascader",
    reason:
      "Element Plus cascader reads from internal v-model; typing into the display input does not trigger the dropdown selection pipeline.",
    suggestedTool: 'vortex_fill with widget="cascader"',
    fixExample:
      'vortex_fill({target:"@eN", widget:"cascader", value:["level1","level2"]})',
  },
  {
    id: "ant-design-range-picker",
    closestSelector: ".ant-picker-range",
    reason:
      "Ant Design RangePicker manages value through React state; dom_fill will not update the picker.",
    suggestedTool: 'vortex_fill with widget="daterange" (or "datetimerange" if it includes time)',
    fixExample:
      'vortex_fill({target:"@eN", widget:"daterange", value:{start:"2026-03-01", end:"2026-03-31"}})',
  },
];

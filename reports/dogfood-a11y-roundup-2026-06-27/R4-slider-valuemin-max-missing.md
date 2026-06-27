# R4 报告 — Slider aria-valuemin/max 暴露缺失 (B006 新缺陷)

**日期**: 2026-06-27
**范围**: Element Plus slider 组件 + 复杂 widget ARIA 计算后态
**状态**: 发现新缺陷 B006,记 backlog,**R4 不修**(设计决策,后续可单独 PR)

## 1. 测试目标

跑 EP slider 组件页,验证 vortex observe 对值域控件 (slider/spinbutton/progressbar/meter) 的 ARIA 计算后态暴露完整度。

## 2. EP slider DOM 真值 (mcp vortex_evaluate)

```
div.el-slider__button-wrapper (role=slider):
  aria-valuenow:    "0"
  aria-valuemin:    "0"
  aria-valuemax:    "100"
  aria-valuetext:   "0"
  aria-label:       "slider between 0 and 100"
```

## 3. vortex_observe 输出 (mcp stdio + filter=interactive)

```
- slider "slider between 0 and 100" [ref=@8d93:e4] [cursor=pointer] [listener] value=0
- slider "slider between 0 and 100" [ref=@8d93:e5] [cursor=pointer] [listener] value=0
- slider "slider between 0 and 100" [ref=@8d93:e6] [cursor=pointer] [listener] value=0
- slider "slider between 0 and 100" [ref=@8d93:e7] [cursor=pointer] [listener] value=0
- slider "slider between 0 and 100" [ref=@8d93:e33] [disabled] [listener] value=0
```

## 4. 缺陷 B006 — aria-valuemin/max 计算后态没暴露

### 4.1 现象

observe 输出 `value=0`,**没有** `[valuemin=0]` / `[valuemax=100]` 标记。
agent 看到 slider 知道当前值=0,但**不知道** 范围是 0-100,无法判断"0 是最小值还是中点"。

### 4.2 根因 (codegraph 定位)

`observe.ts:1947-1966` `getValueInfo` 函数:
- 优先 aria-valuetext → 返回 "0"(line 1950)
- 没 valuetext → 返回 `${now}/${max}`(line 1966,如 "0/100")

**问题**: EP slider 的 aria-valuetext="0"(同 valuenow),走 line 1950 早返回,丢掉 valuemax 信息。
agent 永远看不到 min/max 范围。

### 4.3 桶归类

**vortex-defect**(B006): 值域控件 ARIA 计算后态暴露不完整。
- aria-valuenow → valueNow 字段(✓)
- aria-valuetext → valueNow 字段(✓,但仅在没 valuenow 时)
- **aria-valuemin/max → 无对应字段(❌)**

### 4.4 修复方向 (后续 PR)

**方案 A**: 加独立 `valueMin` / `valueMax` 字段,getValueInfo 同步返回 `{ now, min, max, text }` 结构,renderObserveTree 渲染 `[valuemin=N] [valuemax=N]` 标记。

**方案 B**: `getValueInfo` 始终返回 `${now}/${min}-${max}` 格式(更紧凑,牺牲精确),如 "0/0-100"。

**方案 C**: 仅在 valuetext 缺失或与 valuenow 不同时才省略 max,否则保留拼写。

**推荐方案 A**: 与 `[level=N]` 风格一致,独立字段,易扩展(可加 valuetext 字段)。

### 4.5 范围影响

- 值域控件 role: slider / spinbutton / progressbar / scrollbar / meter
- 原生 input: type=range / number
- 浏览器 ARIA tree 中 progressbar 有 implicit valuemin/max = 0/100,vortex 漏暴露

### 4.6 不在 R4 修的原因

- 涉及 observe-render.ts 渲染 + elements schema + getValueInfo 签名变更
- 是设计决策(独立字段 vs 拼接字符串),需要 brainstorm
- R4 目标是"找新缺陷",R5 留作下轮再处理或单独 PR

## 5. 其他观察 (顺带)

- `ariaValueText` 优先于 valuenow 的设计是对的(更人性化,如 "中" / "$50"),但要保证 min/max 仍能暴露
- `[disabled]` 状态正确(`[disabled] [listener] value=0`)
- `[cursor=pointer]` 标记正确(react onClick 触发器)
- `[listener]` 标记正确(addEventListener 探针)
- `[behind-modal]` / `[level=N]` 修复都生效

## 6. 后续

- **R5**: 跑 foldable/accordion 复杂 widget 找新 a11y 缺陷
- **backlog**: B006 (slider valuemin/max 暴露) 单独 PR 处理

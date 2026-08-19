# vortex 使用基线 — post-inner-budget

窗口 2026-08-18 → 2026-08-19（活跃 2 天，取最近 1 天），6 会话 / 3 项目 / 825 次调用

- 总错误率 5.0%（41/825）
- 成功但空返回 0.7%（6 次，isError 看不见这一类）
- 样本偏斜 Top1 会话 75.6% / Top5 99.2%
- 浏览器工具份额 vortex 825 vs playwright 2（vortex 99.8%）
- observe : evaluate = 0.232

## 各工具（调用数 ≥ 20）

| 工具 | 调用 | 错误 | 错误率 | 空返回 | 空返回率 |
|---|---:|---:|---:|---:|---:|
| evaluate | 340 | 9 | 2.6% | 6 | 1.8% |
| act | 156 | 18 | 11.5% | 0 | 0.0% |
| observe | 79 | 0 | 0.0% | 0 | 0.0% |
| screenshot | 61 | 1 | 1.6% | 0 | 0.0% |
| mouse_click | 58 | 5 | 8.6% | 0 | 0.0% |
| navigate | 27 | 0 | 0.0% | 0 | 0.0% |
| browser | 21 | 0 | 0.0% | 0 | 0.0% |

## Top 错误签名

| 次数 | 归一化签名 |
|---:|---|
| 3 | `evaluate \| Error [TIMEOUT]: js.evaluate timed out after Nms (page-side func may still be running; set shorter timeout, simplify code, or use vortex_navigate to clear the t` |
| 3 | `act \| Error [TIMEOUT]: Actionability timeout after Nms; last reason: NOT_VISIBLE Hint: Action timed out. Increase the timeout argument, or call vortex_wait_for with m` |
| 2 | `act \| Error [OBSCURED]: Element is covered by <div.el-dialog__wrapper.bn-dialog-wrapper> after Nms of retrying; hit-testing its center reaches that element, not the t` |
| 2 | `mouse_click \| Error [TIMEOUT]: Request mouse.click timed out Hint: The hub-to-extension request exceeded its deadline; the page itself may be fine. Retry with a larger timeou` |
| 2 | `wait_for \| Error [TIMEOUT]: Request page.waitForExpression timed out Hint: The hub-to-extension request exceeded its deadline; the page itself may be fine. Retry with a la` |
| 2 | `evaluate \| Error [JS_EXECUTION_ERROR]: Cannot set properties of undefined (setting 'id') Hint: Injected JavaScript threw an error. Inspect the error message in context.ext` |
| 1 | `screenshot \| Error [TIMEOUT]: Request capture.screenshot timed out Hint: The hub-to-extension request exceeded its deadline; the page itself may be fine. Retry with a larger` |
| 1 | `evaluate \| Error [TIMEOUT]: js.evaluateAsync timed out after Nms (page-side func may still be running; set shorter timeout, simplify code, or use vortex_navigate to clear ` |
| 1 | `mouse_click \| Error [CDP_NOT_ATTACHED]: Another debugger is already attached to the tab with id: N. Hint: Another debugger owns this tab — usually DevTools is open on it, or ` |
| 1 | `act \| Error [SELECTOR_AMBIGUOUS]: Selector "[data-block-index="N"]" matched N elements Hint: Selector matched multiple elements. Use a more specific selector, or call` |
| 1 | `act \| Error [CDP_NOT_ATTACHED]: Another debugger is already attached to the tab with id: N. Hint: Another debugger owns this tab — usually DevTools is open on it, or ` |
| 1 | `act \| Error [INVALID_SELECTOR]: target "button:has-text("主题"), [aria-label*="主题"]" uses Playwright locator syntax (text= / >> / :has-text()), which is not supported. ` |
| 1 | `act \| Error [INVALID_SELECTOR]: target "button:has-text("×"), [aria-label="Close"]" uses Playwright locator syntax (text= / >> / :has-text()), which is not supported.` |
| 1 | `debug_read \| Error [INVALID_PARAMS]: vortex_debug_read source=network: pattern is required (pass top-level 'pattern' or 'filter.pattern', e.g. '/api/'). Use a substring to a` |
| 1 | `wait_for \| Error [TIMEOUT]: Request page.wait timed out Hint: The hub-to-extension request exceeded its deadline; the page itself may be fine. Retry with a larger timeout ` |

原始数据同名 `.json`，跨期对比用 `--compare 旧.json 新.json`。

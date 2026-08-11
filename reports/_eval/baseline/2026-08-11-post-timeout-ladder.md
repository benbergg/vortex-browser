# vortex 使用基线 — post-timeout-ladder

窗口 2026-07-13 → 2026-08-11（活跃 24 天，取最近 30 天），44 会话 / 22 项目 / 3297 次调用

- 总错误率 6.6%（219/3297）
- 成功但空返回 2.1%（71 次，isError 看不见这一类）
- 样本偏斜 Top1 会话 17.5% / Top5 51.2%
- 浏览器工具份额 vortex 3297 vs playwright 1262（vortex 72.3%）
- observe : evaluate = 0.093

## 各工具（调用数 ≥ 20）

| 工具 | 调用 | 错误 | 错误率 | 空返回 | 空返回率 |
|---|---:|---:|---:|---:|---:|
| evaluate | 1569 | 76 | 4.8% | 33 | 2.1% |
| act | 343 | 73 | 21.3% | 0 | 0.0% |
| screenshot | 289 | 7 | 2.4% | 0 | 0.0% |
| navigate | 218 | 9 | 4.1% | 0 | 0.0% |
| extract | 152 | 14 | 9.2% | 1 | 0.7% |
| observe | 146 | 8 | 5.5% | 0 | 0.0% |
| tab_list | 113 | 3 | 2.6% | 0 | 0.0% |
| press | 90 | 2 | 2.2% | 0 | 0.0% |
| mouse_click | 85 | 0 | 0.0% | 0 | 0.0% |
| query | 72 | 3 | 4.2% | 21 | 29.2% |
| tab_create | 46 | 0 | 0.0% | 0 | 0.0% |
| wait_for | 43 | 13 | 30.2% | 0 | 0.0% |
| debug_read | 33 | 3 | 9.1% | 16 | 48.5% |
| tab_close | 27 | 1 | 3.7% | 0 | 0.0% |

## Top 错误签名

| 次数 | 归一化签名 |
|---:|---|
| 40 | `act \| Error [TIMEOUT]: Actionability timeout after Nms; last reason: NOT_ATTACHED Hint: Action timed out. Increase the timeout argument, or call vortex_wait_for with ` |
| 18 | `evaluate \| Error [TIMEOUT]: js.evaluateAsync timed out after Nms (page-side func may still be running; set shorter timeout, simplify code, or use vortex_navigate to clear ` |
| 7 | `evaluate \| Error [TIMEOUT]: js.evaluate timed out after Nms (page-side func may still be running; set shorter timeout, simplify code, or use vortex_navigate to clear the t` |
| 6 | `observe \| MCP error -N: Timeout: no response for observe.snapshot after Nms` |
| 5 | `evaluate \| Error [INVALID_PARAMS]: timeout must be an integer in [N, N]; got N Hint: Invalid parameters. Check the tool schema for required fields and value constraints, t` |
| 4 | `extract \| Error [JS_EXECUTION_ERROR]: page-side module "dom-resolve" injection timed out after Nms (target tab likely in a bad SW/navigation state); cache evicted, retrya` |
| 4 | `evaluate \| Error [IFRAME_NOT_READY]: Frame N is not attached to tab N (likely detached after navigation or reload) Hint: Call vortex_observe to refresh frame list; frameId` |
| 4 | `evaluate \| Error [TIMEOUT]: Request js.evaluateAsync timed out after Nms Hint: Action timed out. Increase the timeout argument, or call vortex_wait_for with mode='idle' to` |
| 4 | `wait_for \| Error [TIMEOUT]: Request page.waitForExpression timed out after Nms Hint: Action timed out. Increase the timeout argument, or call vortex_wait_for with mode='id` |
| 4 | `act \| Error [TIMEOUT]: Actionability timeout after Nms; last reason: OBSCURED Hint: Action timed out. Increase the timeout argument, or call vortex_wait_for with mode` |
| 4 | `screenshot \| Error [JS_EXECUTION_ERROR]: Another debugger is already attached to the tab with id: N. Hint: Injected JavaScript threw an error. Inspect the error message in c` |
| 3 | `evaluate \| Error [INVALID_PARAMS]: Missing required param: code Hint: Invalid parameters. Check the tool schema for required fields and value constraints, then retry with ` |
| 3 | `act \| Error [INVALID_PARAMS]: Missing required param: provide `selector` or `index` + `snapshotId` Hint: Invalid parameters. Check the tool schema for required fields` |
| 3 | `extract \| Error [ELEMENT_NOT_FOUND]: Element not found: #mainContent Hint: Element not found. Verify the selector or call vortex_observe to list interactive elements with` |
| 3 | `debug_read \| Error [INTERNAL_ERROR]: Request not found: rt:<url> Hint: The requestId was not found in the network log. Use vortex_debug_read(source=network) to list requests` |

原始数据同名 `.json`，跨期对比用 `--compare 旧.json 新.json`。

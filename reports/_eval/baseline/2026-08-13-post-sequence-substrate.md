# vortex 使用基线 — post-sequence-substrate

窗口 2026-07-16 → 2026-08-13（活跃 24 天，取最近 30 天），46 会话 / 22 项目 / 4187 次调用

- 总错误率 6.5%（272/4187）
- 成功但空返回 2.0%（82 次，isError 看不见这一类）
- 样本偏斜 Top1 会话 13.8% / Top5 46.8%
- 浏览器工具份额 vortex 4187 vs playwright 1366（vortex 75.4%）
- observe : evaluate = 0.091

## 各工具（调用数 ≥ 20）

| 工具 | 调用 | 错误 | 错误率 | 空返回 | 空返回率 |
|---|---:|---:|---:|---:|---:|
| evaluate | 2009 | 88 | 4.4% | 35 | 1.7% |
| act | 428 | 98 | 22.9% | 0 | 0.0% |
| screenshot | 368 | 10 | 2.7% | 0 | 0.0% |
| navigate | 296 | 11 | 3.7% | 0 | 0.0% |
| observe | 183 | 12 | 6.6% | 0 | 0.0% |
| extract | 151 | 15 | 9.9% | 1 | 0.7% |
| tab_list | 136 | 3 | 2.2% | 1 | 0.7% |
| mouse_click | 125 | 0 | 0.0% | 0 | 0.0% |
| press | 119 | 2 | 1.7% | 0 | 0.0% |
| query | 85 | 3 | 3.5% | 29 | 34.1% |
| tab_create | 55 | 0 | 0.0% | 0 | 0.0% |
| wait_for | 47 | 12 | 25.5% | 0 | 0.0% |
| debug_read | 40 | 5 | 12.5% | 16 | 40.0% |
| tab_close | 30 | 1 | 3.3% | 0 | 0.0% |
| dev_reload | 27 | 5 | 18.5% | 0 | 0.0% |

## Top 错误签名

| 次数 | 归一化签名 |
|---:|---|
| 40 | `act \| Error [TIMEOUT]: Actionability timeout after Nms; last reason: NOT_ATTACHED Hint: Action timed out. Increase the timeout argument, or call vortex_wait_for with ` |
| 22 | `evaluate \| Error [TIMEOUT]: js.evaluateAsync timed out after Nms (page-side func may still be running; set shorter timeout, simplify code, or use vortex_navigate to clear ` |
| 12 | `evaluate \| Error [TIMEOUT]: js.evaluate timed out after Nms (page-side func may still be running; set shorter timeout, simplify code, or use vortex_navigate to clear the t` |
| 7 | `act \| Error [TIMEOUT]: Actionability timeout after Nms; last reason: OBSCURED Hint: Action timed out. Increase the timeout argument, or call vortex_wait_for with mode` |
| 6 | `observe \| MCP error -N: Timeout: no response for observe.snapshot after Nms` |
| 5 | `evaluate \| Error [INVALID_PARAMS]: timeout must be an integer in [N, N]; got N Hint: Invalid parameters. Check the tool schema for required fields and value constraints, t` |
| 5 | `observe \| Error [IFRAME_NOT_READY]: No target frames resolved (tab may be uninitialized)` |
| 4 | `extract \| Error [JS_EXECUTION_ERROR]: page-side module "dom-resolve" injection timed out after Nms (target tab likely in a bad SW/navigation state); cache evicted, retrya` |
| 4 | `evaluate \| Error [IFRAME_NOT_READY]: Frame N is not attached to tab N (likely detached after navigation or reload) Hint: Call vortex_observe to refresh frame list; frameId` |
| 4 | `evaluate \| Error [TIMEOUT]: Request js.evaluateAsync timed out after Nms Hint: Action timed out. Increase the timeout argument, or call vortex_wait_for with mode='idle' to` |
| 4 | `wait_for \| Error [TIMEOUT]: Request page.waitForExpression timed out after Nms Hint: Action timed out. Increase the timeout argument, or call vortex_wait_for with mode='id` |
| 4 | `navigate \| Error [TAB_NOT_FOUND]: No tab with id: N. Hint: tabId argument does not exist. Call vortex_tab_create to open a new tab, or omit tabId to operate on the active ` |
| 4 | `screenshot \| Error [JS_EXECUTION_ERROR]: Another debugger is already attached to the tab with id: N. Hint: Injected JavaScript threw an error. Inspect the error message in c` |
| 3 | `evaluate \| Error [INVALID_PARAMS]: Missing required param: code Hint: Invalid parameters. Check the tool schema for required fields and value constraints, then retry with ` |
| 3 | `act \| Error [INVALID_PARAMS]: Missing required param: provide `selector` or `index` + `snapshotId` Hint: Invalid parameters. Check the tool schema for required fields` |

原始数据同名 `.json`，跨期对比用 `--compare 旧.json 新.json`。

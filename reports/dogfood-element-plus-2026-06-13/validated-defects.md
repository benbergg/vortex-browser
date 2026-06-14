# Element Plus 评估校验 (Opus 闸门)

日期: 2026-06-13 | 站点: element-plus.org | 校验者: Opus(白盒 + live 复现)
M3 观察报告: [eval-observations.md](./eval-observations.md)

## 结论

> ⚠️ **本结论经 R2 防漂移复跑校正** —— 见文末「## R2 复跑校正(关键更新)」。R1 初判「0 缺陷」被更新为 **1 个确认缺陷(A3 press 静默假成功)** + A1 证伪 + A2 非缺陷(正确降级)。

**R1 初判**:M3 的 2 条 anomaly 经清洁 live 复现(同 trusted/realMouse 模式)均未复现;本轮是对 2026-06-03 起批次 1-5「act 原语白盒审计」的强验证:13 个组件族(select / select-v2 / cascader / slider / date / time / input-number / dialog / drawer / popover / tree / upload / autocomplete / form)在真实 Element Plus 站全部正常。

## 逐条校验

### A1 — filterable select(证伪)

**M3 现象**(O-3):`vortex_act action=type` 抛 `JS_EXECUTION_ERROR: w is not iterable`;改 `vortex_fill` 返回 success/focused 但 `.el-select__input.value` 仍空;只有 `vortex_press` 单字符能驱动过滤。

**Opus live 复现**(select.html「筛选选项」demo,combobox 解析到 `input.el-select__input`):
- `vortex_act type "Option3"` → `{success:true, typed:7, path:"page-side-dispatch", value:"Option3"}`;evaluate 读 `inputVal="Option3"`,下拉可见项仅 `["Option3"]`。**type 正常**。
- `vortex_fill "Option5"` → `{success:true, focused:true}`;evaluate 读 `inputVal="Option5"`,下拉可见项仅 `["Option5"]`。**fill 正常写入**。

**白盒**:TYPE handler(`dom.ts:670-763`)用元素类型匹配的原生 value setter + clear-before + 逐字累加,`for (const char of txt)` 的 txt 是字符串(必可迭代),无产生 "w is not iterable" 的源。`w` 是构建后 minified 变量名。

**归因**:A1 三现象的指纹高度吻合 **page-side 模块缓存漂移**(已知类别,见 ship 教训「page-side loader 缓存跨导航须重载」/批次5):`type`/`fill` 都依赖 `__vortexDomResolve.queryAllDeep` 页面侧模块,模块陈旧→失败;`press` 是全局按键派发不依赖该模块→独独可用。M3 在 29min / 360 调用 / 28 次导航的马拉松会话中触发,清洁单次导航不复现。
- **Watch-item**(非本轮可修):若能在**可控的多导航序列**中稳定复现 `__vortexDomResolve` 陈旧致 type/fill 失败,则是真缺陷(缓存失效未跨导航重置)。需要的证据:固定导航次数 → 稳定复现的最小用例 + 当时 `typeof window.__vortexDomResolve` 与其 `queryAllDeep` 版本。本轮无此证据,不进迭代。

### A2 — select-v2 虚拟列表选远处选项(证伪)

**M3 现象**(O-5):滚到底后 `vortex_act click` j969/j979 抛 `Actionability TIMEOUT: OBSCURED`,`elementFromPoint(center)` 返回 select 触发器占位;`vortex_evaluate el.click()` 可绕过。

**Opus live 复现**(select-v2.html 基础 demo,1000 项虚拟列表):
- scrollTop=5000 处:observe 拿 j149(@a52a:e4)→ `vortex_act click` → `{success:true, element:{tag:"li", text:"j149"}}`;placeholder 变 "j149"。**成功**。
- scrollTop=33726(极端最底部)处:observe 拿最后一项 j999(@0b0b:e10)→ `vortex_act click` → `{success:true, element:{tag:"li", text:"j999"}}`;placeholder 变 "j999"。**成功**。

**归因**:A2 是已知 **#38 虚拟长列表**类(P2,已优雅降级)。虚拟列表回收 DOM 节点:M3 在 observe(拿 ref)与 act 之间因滚动/延迟致虚拟节点被回收或位移,resolveTarget 命中旧坐标 → elementFromPoint 命中触发器 → OBSCURED。清洁状态(observe 紧跟 act、节点未回收)不出现。即便 M3 撞上,也是**清晰 OBSCURED 报错 + evaluate 绕过**(优雅降级),非崩溃/静默假成功。

## (R1 此节已被 R2 校正)

> R1 初判「无 Phase 3/4」基于 0 缺陷。**R2 复跑后修订**:A3 确认为 P1 缺陷,进迭代;A1 证伪、A2 非缺陷。详见文末「R2 复跑校正」与「修订后迭代清单」。正向验证结论(批次 1-5 审计在真站站得住)仍成立——13 组件族除 press 文本插入外全部正常。

## 方法论印证

- M3「只观察」约束有效,但 anomaly 仍是线索非判定(本轮 0/2 真);**Opus 清洁 live 复现是闸门核心**——直接证伪两条。
- **长会话(马拉松)产物须警惕**:360 调用 / 28 导航会引入 page-side 缓存漂移 + 虚拟列表 ref 漂移,污染 anomaly。后续 M3 评估可考虑**分批/定期重置 tab** 降噪,或在报异常时附「当前是第几次导航」便于区分会话退化 vs 真缺陷。

---

## R2 复跑校正(关键更新)

用户提议:让 M3 **避免 page-side 缓存跨导航漂移**后重跑(每页新 tab,撞异常立刻新 tab 复测),以验证 R1 anomaly 归因。R2 报告 [eval-observations-r2.md](./eval-observations-r2.md):协议遵守完美(26 tab_create / 26 tab_close / **0 navigate**,对比 R1 的 28 navigate)。结果**确证 A1 归因 + 推翻我 R1 对 A2 的过快证伪 + 浮现 A3 真缺陷**。

### A1 — 确证为缓存漂移(证伪为缺陷)✅

R2 全新 tab 中三操作行为**与 R1 完全相反**:`act type "Option3"` 成功过滤、`fill "Option5"` 成功写入、`press` 单字符反而不过滤。R1 的 `w is not iterable` + fill 不写入**完全不复现**。→ A1 是 R1 单 tab 28 次连续 `navigate` 触发的 **page-side loader(`__vortexDomResolve`)缓存漂移**所致,非清洁态缺陷。
- **Watch-item**:若要追这条底层缓存 bug,复现 recipe = 单 tab 内连续 navigate ≥~28 次后对复合输入控件 act type/fill。本轮无稳定最小用例,不进迭代(属批次5「loader 缓存跨导航须重载」遗留边界)。

### A2 — 非缺陷,vortex 正确降级(R1 我的证伪不完整,在此校正)⚠️→✓

R2 全新 tab **仍复现** OBSCURED(非缓存漂移)。我 R1 点 j149/j999 成功、误判全证伪。R2 + Opus 白盒精确定因:
- el-select-v2 虚拟列表渲染**缓冲项**(上/下各若干),其 `getBoundingClientRect` 越出 popper 的 overflow 可视区(popper 429-703,而渲染项 341-783)。`j969`(375-409)落在 popper 上沿之外、被裁剪,且与触发器(378-410)重叠 → `elementFromPoint(476,392)` 命中触发器 `is-transparent` placeholder。
- actionability `receivesEvents`(`actionability.ts:140-169`)的同-widget 装饰层 carve-out 不放行(option 在下拉 popper、placeholder 在触发器,属不同 widget 容器)→ OBSCURED **正确**:被裁剪缓冲项真实不可点(真鼠标点此会落到触发器)。
- **对照确证**:可视带内中间项 `e974`(cy 在 429-703)`act click` **成功**(placeholder→e974);仅越界缓冲项(j969 上沿 / j979 下沿)失败。`evaluate el.click()` 能绕过仅因跳过可视性。
- 判定:**已知 #38 虚拟长列表(P2,已优雅降级)**——清晰 OBSCURED 报错 + 中间项可点 + workaround 存在。次级可选改进:observe 排除被祖先 overflow 裁剪的缓冲项(避免把不可点项当 interactive 报出),P2 风险项,本轮不做。

### A3 — 新确认缺陷:`vortex_press` 可打印字符静默假成功 🔴

R2 浮现、Opus live + 白盒确认:
- **Live**(input.html plain text input,聚焦清空):`vortex_press key="a"` 返回 `{success:true, key:"a", focusedElement:"input#... Please input"}`,但 `activeElement.value` 仍为 `""`,字符未插入。
- **白盒**:`keyboard.ts` `dispatchKey()`(166-192)发 CDP `Input.dispatchKeyEvent` keyDown+keyUp,**缺 `text` 字段**。按 CDP 规范,可打印字符要真正插入须 keyDown 带 `text`(+`unmodifiedText`);缺则 keydown/keyup 事件照发(JS 监听可见)但浏览器默认插字符动作不触发。
- **两重问题**:① **silent false success**——`success:true` 却无效果,正属 vortex 一直加固的「族 A 静默假成功」类;② **与真对标 Playwright divergence**——Playwright `keyboard.press('a')` 对可打印键带 text 会插入字符(见 [[vortex_eval_peer_calibration]] 工具面 1:1 对标)。
- **修法(well-scoped)**:`dispatchKey` 对单个可打印字符(无修饰键/仅 Shift)的 keyDown 加 `text`/`unmodifiedText`;非可打印键(Enter/Tab/Arrow/Escape)与组合键(Ctrl+A 等命令)不加。对齐 Playwright + 消除假成功。需配 bench 用例 + 不回归 Enter/Tab/Arrow/组合键既有行为。
- **判定:进迭代候选(P1)。**

## 修订后迭代清单

| ID | 判定 | 进迭代? | 处理 |
|----|------|---------|------|
| A1 | 缓存漂移产物(证伪) | 否 | watch-item:marathon 复现 recipe 记录,属批次5 遗留边界 |
| A2 | vortex 正确降级(#38) | 否(P2 可选 observe 改进) | 维持优雅降级 |
| A3 | **press 可打印字符静默假成功** | **是(P1)** | `dispatchKey` keyDown 补 `text`,对齐 Playwright + 消除假成功 |

## 方法论印证(R2 追加)

- **用户提的"消除变量重跑"是高价值实验**:R1 单变量(长会话)被 R2 切掉后,A1/A2/A3 三条各自归位——A1 证伪、A2 暴露真因(非缓存)、A3 浮现。**对照实验 > 单轮判定**。
- **我 R1 对 A2 的证伪过快**:只试了恰好落在可视带的 j149/j999 就下「全证伪」结论,漏了缓冲项。教训:虚拟列表类要覆盖边界项(首/末/缓冲),不能只测中间。
- M3 raw 错误字符串仍须 Opus 复现定真伪(A1 的 "w is not iterable" 反推是会话退化),但 M3 的对照协议(旧/新 tab)直接帮助分流 A1(仅旧)vs A2(新仍现)。

# 终审第二轮：Critical 我反驳了，其余已修

分支 `feat/query-pseudo-font`，7 个 commit。上轮报告 `luna-pseudo-font-final.md`。

## 反驳两条（都有实测）

**Critical「路径不穿 open shadow」——不成立。** 你的论据是「上溯到 ShadowRoot 后
`nodeType` 是 11，循环立即结束，host 不会被加入路径」。但循环条件检查的是**当前 `n`**，
而 `n = p.host ? p.host : p` 直接把 `n` 设成宿主元素——`ShadowRoot` 从未被赋给 `n`，
循环不会在那里终止。三份证据：
1. jsdom：两个 shadow host 下的 button → `...DIV:0>BUTTON:0` / `...DIV:1>BUTTON:0`
2. **真 Chrome**（知乎页构造两个 shadow host）→ 同样两条不同路径，`distinct: 2`
3. **端到端**：`vortex_query mode=style pattern=.__sbtn attr=font` 命中 `total: 2`，
   无 fingerprint mismatch，字体正常返回
4. **变异**：删掉 `p.host` 那行，真源与探针两处各有测试转红——它不是死代码

**High「`gap:0px` 该按初始值裁」——不成立。** 真 Chrome 实测（`984534155` 上构造
block/flex/grid/inline-block/显式 gap:0 五例）：未设 gap 的**一律返回 `normal`**，
只有显式 `gap:0` 才是 `0px`。保留 `0px` 是对的。同批实测确认了其余六项初始值
（`row`/`nowrap`/`normal`/`normal`/`none`/`none`），裁剪表准确。

## 已修（`feb26c0`、`403c9c4`）

| 你报的 | 处置 |
|--------|------|
| High 24 段截断碰撞、无碰撞检测 | **采纳**。深度 24→64；**加碰撞检测**：指纹序列有重复直接返回 unavailable，不赌顺序没变 |
| Medium box shape 回归锁 | **采纳**，四形态 handler 级锁（普通 block / flex / grid / block 上显式 gap:0） |
| Medium partial 粒度不足 | **采纳**，`fontFacesPartialReasons: ["cross-origin"\|"rule-unreadable"\|"nesting-depth"]`，排序稳定（发现顺序跟着页面样式表先后走） |
| Medium deadline ≠ 取消 | **采纳措辞**：注释与 CHANGELOG 都写明它只保证调用方不被挂住，`chrome.debugger` 无取消能力，超时那条仍 pending。未做并发限制——释放最多与元素数同阶（≤50） |
| Medium 布局契约措辞 | **采纳**，CHANGELOG 写明基于 computed value、无法区分显式同值声明、当前只覆盖七项 |

## 请终审（最后一轮）

1. 上面两条反驳站得住吗？若你仍认为 shadow 路径有问题，请给出**能在真 Chrome 复现**的具体 DOM。
2. 碰撞检测是否引入新问题：合法页面上多频繁会命中重复身份而误降级？
   （路径含每级位置索引，理论上同树内唯一，只有 >64 层深且前 64 段全同才碰撞）
3. 七个 commit 累计改动很大，**有没有回归**：早先通过的判据被后续改动破坏。
4. 还有没有「把没看说成看过了」的路径。

全量 extension 2442 / mcp 759 全绿；`pnpm build` 过；真站复验字体、布局、shadow 三条路径。
变异验证累计 40+ 条。

报告写 `reports/_review/luna-pseudo-font-final2.md`。带 `file:line`，禁类比推理，
**反驳我的反驳时必须给实测**。

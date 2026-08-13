# 外部基线对照：vortex vs chrome-devtools-mcp

**日期**：2026-08-13
**跑法**：`pnpm --filter @vortex-browser/bench bench external-baseline <url...>`
**对照对象**：`chrome-devtools-mcp@1.7.0`（官方 ChromeDevTools 一手实现，Puppeteer 底座）

## 为什么做这件事

vortex 长期只用自家 bench 自证。历史上多次出现「自闭环判断 → 假绿」（MUI 8 报 0 真、班牛 15 报 1 真、
blank-shell 的 FN 靠 live 才抓到）。这份对照的目的不是宣称谁更好，而是给「vortex 的 text-first
观察确实更省」这类说法一个**外部锚点**。

## 本轮数字

| 工具 | 页面 | 输出字节 | 耗时 |
|---|---|---:|---:|
| vortex | fixture（本地静态页） | 233 | 715 ms |
| chrome-devtools-mcp | fixture（本地静态页） | 477 | 21432 ms |
| vortex | github.com/anthropics/anthropic-sdk-typescript | 10248 | 13631 ms |
| chrome-devtools-mcp | 同上 | 24445 | 17479 ms |

合计：vortex **10481 B**，chrome-devtools-mcp **24922 B**。两次观察都成功，无失败样本。

比较动作：vortex 用 `vortex_navigate` + `vortex_observe`，chrome-devtools-mcp 用 `new_page` + `take_snapshot`。
工具名是实测 `tools/list` 拿到的，不是猜的。

## 哪一栏能用，哪一栏不能

**字节可用（有保留）**：vortex 的观察输出约为对方的 **42%**。这与「text-first 低 token 观察」的设计取向一致。
保留之处在于两边输出的**语义不完全等价**——`take_snapshot` 与 `vortex_observe` 的元素筛选口径不同，
这不是同一份内容的两种编码。因此该数字只能读作「同一任务下的上下文成本量级」，不能读作压缩率。

**耗时不可用**。本轮 runner 为每个样本新建一次 MCP 连接，chrome-devtools-mcp 因此**每个样本冷启一个
Chrome**（本地静态页 21.4 s 几乎全是启动成本），而 vortex 附着到一个已经在跑的浏览器。这个不对称正好
是两者的架构差异本身，但把它当「每次操作的延迟」引用是错的。要测延迟必须改成单连接内多次观察，
本轮没做。

## 环境不对等声明

- vortex 接管**真实已登录**的 Microsoft Edge（用户日常 profile）
- chrome-devtools-mcp 以 `--headless=true --isolated=true` 自启隔离 Chrome 实例
- 登录态、扩展、缓存、字体、窗口尺寸均不同

**任何单项数字都不构成 parity。** 代码里 `summarize()` 恒返回 `caveat` 字段，就是为了让这句话跟着数据走，
而不是留在人的记忆里。

## 顺带实证到的两件事

1. **chrome-devtools-mcp 默认开启向 Google 上报使用统计**（启动横幅明说，需 `--no-usage-statistics` 关闭），
   性能工具还可能访问 CrUX API。本 runner 已显式关闭。这条印证了调研报告 §6.5 的判断：不能照搬它的默认配置。
2. 它对未协商 MCP roots capability 的客户端会**把文件写入限制在系统临时目录**。

## 复现

```bash
pnpm --filter @vortex-browser/bench playground          # 另开一个终端
pnpm --filter @vortex-browser/bench bench external-baseline \
  http://localhost:5173/synth/schema-readback.html \
  https://github.com/anthropics/anthropic-sdk-typescript
```

不进 CI：要拉 npx 包并另起一个 Chrome，只在需要外部锚点时手动跑。

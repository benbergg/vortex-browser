# WebMCP 与 Page.getAnnotatedPageContent 只读探测记录

**日期**：2026-08-13
**浏览器**：`Chrome/151.0.7922.110`（protocol 1.3），headless=new，临时 `--user-data-dir`
**探测方式**：`--remote-debugging-port` + 裸 WebSocket CDP。**不是**经 `chrome.debugger`（见末尾限制）
**产出边界**：本任务只记录事实，**不产生任何生产代码，也不给路线结论**

## 1. `Schema.getDomains` 不是能力探测的可靠依据

它只列出 35 个域：

```
Accessibility, Animation, ApplicationCache, Audits, CSS, CacheStorage, DOM, DOMDebugger,
DOMSnapshot, DOMStorage, Database, Debugger, DeviceOrientation, Emulation,
HeadlessExperimental, HeapProfiler, IO, IndexedDB, Input, Inspector, LayerTree, Log, Memory,
Network, Overlay, Page, Performance, Profiler, Runtime, Schema, Security, ServiceWorker,
Storage, Target, Tracing
```

实际逐个调用的结果：

| 域 | 在 `getDomains` 清单里 | `enable` 调用 |
|---|---|---|
| `Accessibility` | 是 | OK |
| `DOMSnapshot` | 是 | OK |
| `WebMCP` | **否** | **OK** |
| `Autofill` | **否** | **OK** |
| `FedCm` | **否** | **OK** |

清单里还留着 `ApplicationCache`、`Database` 这些早已废弃的域。

**结论**：`Schema.getDomains` 返回的是一份陈旧的静态清单，既漏报当前可用的实验域，也保留了死域。
调研报告 P0-A 建议「用 `Schema.getDomains`/命令探测」建立能力矩阵——**前半句在 Chrome 151 上不成立**，
能力探测只能靠**实际发命令看是否报错**。

另一条限制：`enable` 返回 OK 只证明命令被接受，不证明该域有功能。空白页上 `WebMCP.enable` 成功，
但没有任何 `WebMCP.*` 事件——这与「页面没声明工具」无法区分。要分清必须有一个真正注册了 WebMCP
工具的页面，本机未启用 Origin Trial，**该项未能验证**。

## 2. `Page.getAnnotatedPageContent` 在 Chrome 151 上可用，且代价不小

在 `github.com/anthropics/anthropic-sdk-typescript` 上：

| 项 | 值 |
|---|---|
| 返回形状 | `{ content: <base64> }` |
| base64 长度 | 57,752 |
| 解码后字节 | **43,314** |
| 头部 | `080112f1cf020a9bcf020ad4ce020a84` |

**同一页面的横向对照**（数据来自本目录 `README.md` 那轮）：

| 来源 | 字节 |
|---|---:|
| `vortex_observe` | 10,248 |
| `chrome-devtools-mcp` 的 `take_snapshot` | 24,445 |
| **APC 原始 protobuf** | **43,314** |

APC 是 vortex 当前观察输出的约 4.2 倍，而且这还是**解码之前**的字节。

### `includeActionableInformation` 在本轮无可观测效果

`{}` 与 `{ includeActionableInformation: true }` 两次调用返回**字节数完全相同、头部十六进制完全相同**
（57752 / 43314 / `080112f1cf02...`）。要么该参数默认即为真，要么在此构建上未接线。单轮观测，未深究。

### 裸字节只能捞字符串；结构要靠 proto 解码

原始字节里能直接看到可读片段：

```
....R...Skip to content..........."......... ......... .@.rI.Ghttps://github.com/anthropics/...#start-of-content
```

即页面文本与 URL 不解码也能提取，但节点树、role、actionability 必须解码 protobuf 才拿得到。

> **2026-08-13 订正**：本节初稿写的是「没有公开的 `AnnotatedPageContent` proto 定义 / 没有公开解析入口」，
> **这句话是错的**，由后续调研推翻并经我复核：
> [`components/optimization_guide/proto/features/common_quality_data.proto`](https://chromium.googlesource.com/chromium/src/+/main/components/optimization_guide/proto/features/common_quality_data.proto)
> 在 Chromium main 上是公开的，实查确认其中定义了 `AnnotatedPageContent`（含 `root_node`、`main_frame_data`、
> `viewport_geometry` 等字段）、`ContentNode`、`Geometry`、`InteractionInfo`（含 `clickability_reasons`、
> `is_focusable`、`is_disabled`）。CDP 的 `Page.getAnnotatedPageContent` 文档本身就指向该 proto。
> 我当初只在裸字节里翻找，没去查 Chromium 源码就下了结论。
>
> **仍然成立的较窄表述**：本轮 spike 手上没有现成的 TypeScript/JS 解码器——要用得 vendor 这份 `.proto`
> 并自行生成 decoder，还要承担 Experimental 协议漂移的维护成本。这是工程量问题，不是「拿不到」。
> 注意 `InteractionInfo.clickability_reasons` 正好落在 vortex 的 actionability 主线上，值得单独评估。

## 2.5 后续 spike：`chrome.debugger` 通道实测（2026-08-13，二次）

上一轮把「扩展通道是否可达」列为最大未验证项。本轮用**一次性探针扩展**（MV3，仅 `debugger`+`tabs` 权限，
与 vortex 源码零关联）实测，答案是**可达**。

**环境**：Chrome for Testing `151.0.7922.138`，mac-x64，headful，临时 profile，同一目标页
`github.com/anthropics/anthropic-sdk-typescript`。用 CfT 是因为**品牌版 Chrome 137+ 已移除 `--load-extension`，
142 起连 `--disable-features=DisableLoadExtensionCommandLineSwitch` 这个绕法也一并砍掉**（本机 151 上两条都实测失效：
扩展根本不进 profile）。CfT 是官方给自动化的替代二进制，Chromium 版本相同。

| 探针 | 结果 |
|---|---|
| `Page.enable`（阳性对照） | OK |
| `Accessibility.enable`（阳性对照） | OK |
| `Accessibility.getFullAXTree`（阳性对照） | OK，1628 节点 |
| `Schema.getDomains` | **ERR `-32601 'Schema.getDomains' wasn't found`** |
| `Page.getAnnotatedPageContent {}` | **OK**，base64 105720 → 解码 **79288 B** |
| `Page.getAnnotatedPageContent {includeActionableInformation:true}` | OK，字节与上一行完全相同 |
| `WebMCP.enable` | **OK** |
| `WebMCP.disable` | **OK** |

三条阳性对照全过（都是 vortex 现在正在用的命令），故这不是探针故障。

**三点值得记下**：

1. **`Schema.getDomains` 在扩展通道上根本不存在**，而它在裸 CDP 上是能返回 35 个域的。同一个方法两条通道
   行为不同——这从第二个角度坐实了 §1 的结论：它不能用作能力矩阵数据源。
2. **`includeActionableInformation` 字节相同这次有了解释**：CDP 文档写明该参数**默认即为 true**，所以显式传
   与不传本就该一样。上一轮记的「要么默认为真、要么未接线」，现在可以收敛到前者。
3. **同一 URL 的 APC 体积两轮差了近一倍**：裸 CDP headless 43314 B vs 扩展通道 headful **79288 B**。
   最可能是 headless 与 headful 的布局/渲染差异（headful 有真实视口，内容铺开更多），但**本轮没做对照实验，
   这个归因仍是推测**。要用 APC 体积做预算判断，必须先把这个变量控住。

**仍未验证**：`WebMCP.enable` 成功只证明域可达。该页面没有注册任何 WebMCP 工具，所以「WebMCP 是否真能工作」
与上一轮一样没有答案——要验必须找到真正调用 `document.modelContext` 注册工具的页面。

**vortex 自身还有一道门**：即便通道可达，仓内 `assertEnableable` 的白名单
（`packages/extension/src/lib/cdp-domains.ts`，仅 Accessibility/DOM/Network/Page/Runtime 五个域）会先把
`WebMCP.enable` 拒掉，且该文件顶部明确写着「不要凭印象往里加」。这是我们自己的门，不是浏览器的限制。

## 3. 本轮探测的限制（必须跟着结论走）

1. ~~**走的是裸调试端口，不是 `chrome.debugger`。**~~ **已由 §2.5 的二次 spike 解决：扩展通道实测可达。**
   遗留的限制变成：实测用的是 Chrome for Testing 而非用户日常的品牌版 Chrome/Edge——`chrome.debugger` 的域限制
   是 Chromium 代码而非品牌差异，故认为可迁移，但**未在品牌版上直接复现**。
2. 单次运行、单个 Chrome 构建、headless 模式、空 profile。无跨通道（Stable/Beta/Dev/Canary）对比。
3. WebMCP 的实际功能未验证（无 Origin Trial、无声明工具的页面）。
4. APC 只测了一个页面。字节量随页面复杂度的变化未测。

## 4. 事实小结（不含路线判断）

- Chrome 151 上 `WebMCP` 与 `Page.getAnnotatedPageContent` 两个域**在裸 CDP 与 `chrome.debugger` 扩展通道下都能调用**（§2.5）
- `Schema.getDomains` 不能用作能力矩阵的数据源：裸 CDP 下漏报这两者，扩展通道下该方法干脆不存在
- APC 可用；proto 定义在 Chromium main 上公开（见 §2 订正），缺的是现成解码器而非定义。
  体积两轮分别为 43314 B（headless 裸 CDP）与 79288 B（headful 扩展通道），差异归因未做对照，不可直接引用
- **WebMCP 是否真的工作仍未验证**——域可达 ≠ 有功能，需要一个真正注册了工具的页面
- 阻碍 vortex 用上它们的下一道门在仓内自己手里（`assertEnableable` 白名单），不在浏览器

是否值得进入 v-next，本记录不作判断——按约定留给下一次路线关卡。

## 复现

探测脚本为一次性产物，未入仓。

**第一轮（裸 CDP）**：临时 `--user-data-dir` + `--remote-debugging-port`
（Chrome 136+ 只封默认 profile，临时 profile 不受影响），裸 WebSocket 发 `Schema.getDomains`、
各域 `enable`、`Page.getAnnotatedPageContent`。

**第二轮（扩展通道）**：写一个 MV3 探针扩展（`permissions: ["debugger","tabs"]`，SW 里
`chrome.debugger.attach` 后逐条 `sendCommand`），用 **Chrome for Testing** 加载
（品牌版 Chrome 已不支持 `--load-extension`），结果 POST 到本地 sink 落盘。两个必要设计：
① 每条命令带独立本地超时——首版没有，某条回调不返回时整轮静默无输出；
② 逐条增量回传而非跑完一次性回传——否则中途挂死就什么都看不到。
阳性对照（`Page.enable` / `Accessibility.*`）必须放在待验证项之前，用来区分「API 被禁」与「探针坏了」。

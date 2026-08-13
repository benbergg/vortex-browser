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

### 无 proto 定义时只能捞字符串，捞不到结构

原始字节里能直接看到可读片段：

```
....R...Skip to content..........."......... ......... .@.rI.Ghttps://github.com/anthropics/...#start-of-content
```

即页面文本与 URL 是可提取的，但**节点树、role、actionability 这些真正有价值的结构，没有 Chromium 内部
的 `AnnotatedPageContent` proto 定义就还原不出来**。这正是调研报告开放问题 #1 所问的那件事，本轮的答案是：
没有公开解析入口。

## 3. 本轮探测的限制（必须跟着结论走）

1. **走的是裸调试端口，不是 `chrome.debugger`。** 扩展传输有受限域名单，因此「WebMCP.enable 在裸 CDP 上
   可调」**不等于** vortex 能用它。这一条未验证，要验必须在扩展里加代码——超出本 spike 范围。
2. 单次运行、单个 Chrome 构建、headless 模式、空 profile。无跨通道（Stable/Beta/Dev/Canary）对比。
3. WebMCP 的实际功能未验证（无 Origin Trial、无声明工具的页面）。
4. APC 只测了一个页面。字节量随页面复杂度的变化未测。

## 4. 事实小结（不含路线判断）

- Chrome 151 上 `WebMCP` 与 `Page.getAnnotatedPageContent` 两个域在裸 CDP 下都能调用
- `Schema.getDomains` 漏报这两者，不能用作能力矩阵的数据源
- APC 可用但原始体积是 vortex 现有观察输出的约 4.2 倍，且无公开 proto 解析入口
- WebMCP 是否真的工作、是否经 `chrome.debugger` 可达，两项均未验证

是否值得进入 v-next，本记录不作判断——按约定留给下一次路线关卡。

## 复现

探测脚本为一次性产物，未入仓。要点：临时 `--user-data-dir` + `--remote-debugging-port`
（Chrome 136+ 只封默认 profile，临时 profile 不受影响），裸 WebSocket 发 `Schema.getDomains`、
各域 `enable`、`Page.getAnnotatedPageContent`。

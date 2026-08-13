// I15: tools/list 字节硬断言 + 数量 + 内部化 grep。
// spec: vortex重构-L4-spec.md §0.2.1 (4800B budget v2.1) + §3.3
//
// v0.8 cap: 4500 → 4600 B。v0.7.x backlog 重新暴露 4 个工具
// (vortex_fill / vortex_evaluate / vortex_mouse_drag / vortex_file_upload)，
// payload 实测 4537 B。trim description 会损 LLM 可读性，因此调升 cap
// 而非压缩字符。下一个调整窗口预留至 v0.9 再 review。
//
// v0.8.x: 4600 → 4700 B。vortex_screenshot 增加 format/quality 字段
// 提升 token 节省能力（caller 可 opt-in jpeg quality，实测体积可降 ~40%），
// description 也要点出此能力以引导 LLM 使用。同样优先 cap 微调而非压缩字符。
//
// v0.8.x P1: 4700 → 4800 B。vortex_extract 增加 scroll(boolean) 公开能力
// （提取前 scroll-until-settled 触发懒加载，解决"懒加载内容对裸 extract
// 不可见"的正确性缺口），新增 schema 字段 ~27B + description 点出能力。
// scroll 是真新增公开能力，cap 微调（+100，与前两次同步长）而非压缩字符。
//
// v2.1 PR-A: 4800 → 5200 B。promote vortex_tab_list + vortex_history 两
// 个 schema 块回公开,2 段 description 重写(evaluate / storage)。后端
// 零代码改动,只 +2 schema 块 + description 改写。两个工具 schema 实测
// 共 +~407B,新 payload 实测 5137B,cap +400 至 5200 留 63B 余量。
//
// v3.1 PR-E-scope-reduced: 5200 → 5300 B。vortex_extract 加 maxLength(number,
// 默认 10KB = 10240 chars) 公开能力 (B3-7 落点修对到 handler + 真测
// truncateWithTextTrailer),新增 schema 字段 ~30B + description 改写
// 提及"maxLength 10KB"。maxLength 是真新增公开能力,cap 微调 (+100,
// 跟历次同步长) 而非压缩字符。新 payload 实测 5225B,留 75B 余量。
//
// v3.3 PR-redesign: 5300 → 5500 B,description 60 → 120 char。
// (1) B3-2 vortex_storage 加 list-keys/-all 公开能力,description 重写
//     "list-keys/-all for ls summary."(54 char,在原 60 之内,无 schema 变化)。
// (2) B3-6 vortex_press description 加 scrolling 引导(window.scrollTo 替代
//     key:End)+ 无聚焦元素提示(40 → 114 char)。B3-6 是 P0 体验断点,根因
//     是 body 无 tabindex,提示 LLM 改用 evaluate scrollTo 是真修复。cap
//     同步放宽 (+200B, +60 char),沿用历次"加能力微调 cap 不压缩字符"惯例。
//
// V4 PR-REQ-009 (f577b04): 5500 → 5600 B,description 56 → 112 char。
// vortex_evaluate description 加 IIFE 模板示例 (function(){return 42;})() /
// (async function(){...})(),让 LLM 一次看明白箭头/function 必须 IIFE 包裹
// (vortex_evaluate 用 JSON-RPC 传输 code 字符串,箭头/function 顶层表达式
// 无法 standalone 求值,IIFE 才能成 statement)。新 payload 实测 5506 B,
// cap +100 至 5600 留 94 B 余量,沿用"加能力微调 cap 不压缩字符"惯例。
// description 长度上限同步放宽 60 → 120 (vortex-evaluate-description.test.ts
// 镜像此决策)。
//
// feat/dialog-handling (修正版): 5800 → 6000 B。vortex_act options 新增
// onDialog(enum) + promptText(string) 两个弹窗应答字段 (+84B schema),
// vortex_act description 恢复载荷性 hint (windowMs上限3000,慢站0网络≠失败
// + click observeEffect→effect signals),并追加 onDialog clause。
// 恢复后 description 174 char,schema 字段 +84B,payload 实测 5918B。
// cap +200 至 6000,留 82B 余量。description 长度上限同步放宽 120 → 180
// (沿用"加能力微调 cap 不压缩字符"惯例；174 char = 120 原始 + 54 onDialog子句)
//
// 工具横向优化 T7: 6500 → 7100 B。vortex_fill_form 新增(fields[] 批量填表,
// 部分成功语义)。schema 含 fields.items.properties 结构,payload 实测 6880B,
// cap +600 至 7100 留 220B 余量。沿用"加能力微调 cap 不压缩字符"惯例。
//
// 工具横向优化 vortex_query: 7100 → 7500 B。vortex_query 零 LLM 探测工具新增
// (text grep + css find),schema 含 mode/pattern/isRegex/caseSensitive/contextChars/
// attr/includeText/maxResults 字段,payload 实测 7417B,
// cap +400 至 7500 留 83B 余量。沿用"加能力微调 cap 不压缩字符"惯例。
//
// 可验证确定性重放: 7500 → 7800 B。vortex_act options 新增 fingerprint(object)
// 字段(record/verify 模式 + expect/autoRecover 子字段 + 1 段 description)。
// fingerprint.description 是 handler 已实现的真公开能力(server.ts applyFingerprint
// /shouldRecover record/verify/autoRecover),必须文档化让 LLM 知道 record→fingerprint
// /verify→drift 的契约,沿 vortex_debug_read.filter 单点豁免先例。payload 实测
// 7718B,cap +300 至 7800 留 82B 余量。沿用"加能力微调 cap 不压缩字符"惯例。
//
// vortex_query mode=component: 7800 → 7900 B。vortex_query mode 枚举新增
// component(读 Vue/React 实例数据 + 表行对象),description 同步说明。componentDepth
// 不入 schema(handler 读取,省预算)。payload 实测 7773B,cap +100 留 ~80B 余量。
// 沿用"加能力调 cap 不压字符"惯例。
//
// query mode=css attr 多属性: 8500 → 8600 B,description 180 → 230 char。
// daddd2b(feat: query mode=css attr 支持分隔符拆分多属性)只改了 schemas-public.ts
// 一行(给 attr 加 description),**漏了配套的 cap 与豁免同步**,致本不变式自该提交起
// 一直红着(实测 8522 > 8500、vortex_query description 222 > 180、attr 带 description)。
// 本次补齐该收尾:
//   - 字节 8500 → 8600:实测 8522,+100 同历次步长,留 78B 余量。
//   - description 180 → 230:超标的只有 vortex_query 一个(222,其余最长 174=vortex_act)。
//     222 是 8 个 mode 各一段真能力说明累加的结果(text/css/component/geometry/style/
//     sheet/flow/chart),压到 180 必须删掉某个 mode 的说明 → 该 mode 对 LLM 不可发现。
//     沿本文件既有判断("压缩损 LLM 可读性",见 mode=flow 段)不压字符,调阈值。
//   - attr 进 description 豁免名单(第三处,前两处为 debug_read.filter / act.fingerprint):
//     判据同 filter —— handler 已实现的真能力,且它修的正是 R11 禅道 dogfood 实测的
//     静默失败(attr="class|title" 被当单个畸形属性名 getAttribute 掉,静默返回空 attrs,
//     误导 agent 判定 attr 参数失效)。移除豁免 = 让该 dogfood 真发现复发。
//
// vortex_query mode=flow: 7900 → 8100 B。vortex_query mode 枚举新增
// flow(ipaas 流程图 readback → mermaid/tree/json),description 同步追加
// "; flow=流程图→mermaid."。flowProbeFunc 自包含内联 detect+read+serialize
// (改一处须改两处,query-flow-parity.test.ts 校验);纯读 ipaas Vue
// processSetting._data, 不调用 Vue 方法。考虑过进一步压 description
// (drop "+WCAG"/"Lake "等), 但 +WCAG 是 style 模式真能力, Lake Sheet 是
// 真产品名, 压缩损 LLM 可读性, 沿用"加能力微调 cap 不压字符"惯例
// (与历次 +100 同步长)。cap +200 至 8100, 留 ~94B 余量。

//
// vortex_browser: 8600 → 8900 B。新增浏览器清单/运行时切换工具，让模型
// 在对话中查看在线浏览器并选择绑定目标。新增工具后 payload 实测 8738B,
// 按实测 +~80B 余量取整到百位，沿用"加能力调 cap 不压字符"惯例。
//
// 参数可发现性: 8900 → 9800 B。2026-08-09 工具选择评测显示,113 个参数只有
// 2 个有 description,模型在公开站点任务上 4/4 改用 playwright——而 vortex-only
// 复跑这 4 个任务全部完成,说明是可发现性而非能力问题。典型代价: vortex_screenshot
// 因 target 无说明用了 8 次调用,playwright 只用 3 次。本次给 6 处"模型会填错或
// 不知道能填什么"的参数补描述(target/act.value/fill.value/wait_for.value/
// query.mode/extract.maxLength),实测 9661B,cap 取 9800 留 139B 余量。
// 这是"为可读性提预算",与历次"加能力调 cap"性质不同,故单列。
// 详见 reports/_eval/tool-choice-2026-08-09.md。
//
// vortex_resize: 9800 → 10200 B。2026-08-11 日志分析(4269 次真实调用)显示,
// playwright 占 24.1%,而"vortex 完全无对应能力"的调用只有 32 次——其中 21 次
// 是 browser_resize。这是唯一一条实证的硬能力缺口:响应式验收一旦要改视口就必须
// 留在 playwright,用过 resize 的 6 个会话贡献了全部 playwright 调用的 86.4%。
// 新增工具后实测 10109B,沿用"加能力调 cap 不压字符"惯例取整到 10200,留 91B 余量。
// vortex_query mode=schema: 10200 → 10300 B。vortex_query mode 枚举新增 schema
// (读页面作者声明的 JSON-LD/Microdata/OGP → 带 source/untrusted 的实体列表),
// mode.description 同步追加一句说明。schema 是页面作者声明而非浏览器计算语义,
// 必须在 description 里点明"may differ from visible content",否则模型会把它
// 当页面事实。payload 实测 10236B, cap 取 10300 留 64B 余量。
// 沿用"加能力调 cap 不压字符"惯例。
// vortex_act scroll target 语义: payload 实测 10301B。scroll 传 target=@ref 时
// 改为滚该元素自身(原先被 strip 掉、实际滚 window,指纹还挂着该元素的身份)。
// 行为变了描述必须跟上,否则模型不知道能用 @ref 指容器,能力等于不存在。
// vortex_sequence 多步序列: 10400 → 11100 B。新增一个公开工具,
// 一次调用跑多步且每步自证。日志实测 observe:evaluate=1:12,其中九成是无对应工具的
// 批处理负载(58% 循环 / 17% 跨调用状态),这是那条缺口的正面补齐。
// payload 实测 11005B。沿用"加能力调 cap 不压字符"惯例。

import { describe, it, expect, afterEach } from "vitest";
import { COMMIT_KINDS } from "@vortex-browser/shared";
import { getToolDefs, getInternalToolDef, setEnabledCaps } from "../../src/tools/registry.js";

describe("I15: tools/list budget + count + internalized grep", () => {
  const defs = getToolDefs();
  const toolsListPayload = JSON.stringify(
    defs.map(d => ({ name: d.name, description: d.description, inputSchema: d.schema })),
  );

  it("tools/list 字节 ≤ 11100 B (vortex_sequence 后实测 11005 留 95B buffer)", () => {
    // V2 P0 修复 D16: filter 子字段 description 是必要的文档化豁免
    // (handler 已实现 console.ts:160 level / network.ts:305-321 pattern+statusMin/Max),
    // 移除豁免会触发 V2 D16 真发现复发 (LLM 不知可用子字段)。
    // 上限 7900 = 7800 (可验证重放 fingerprint 基线) + ~100 (vortex_query mode=component
    // schema 枚举加 component + description 说明读 Vue/React 实例数据 + 表行对象)。
    // T1-2 残余收口 (B2): 7900 → 8000。vortex_debug_read description 强化,点明
    // source=network/request 自动捕获 POST 请求/响应体(无需手搓 fetch hook),消除评测员
    // 误搓 fetch hook 的根因(保留 "pattern REQUIRED" 满足 B3-8)。payload 实测 7845B,
    // cap +100 留 155B 余量。沿用"加能力调 cap"惯例。
    // mode=flow: 8000 → 8100。vortex_query mode 枚举新增 flow(ipaas 流程图 readback),
    // description 同步追加 "; flow=流程图→mermaid."。payload 实测 8006B,
    // cap +100 留 ~94B 余量。沿用"加能力调 cap 不压字符"惯例。
    // feat/coord-click: 8100 → 8500。vortex_mouse_click 坐标点击工具从内部化提升为公开
    // (handler mouse.click 早已实现,含 frame→viewport 换算,此前只暴露坐标版 mouse.drag;
    // canvas/地图/无 ref 场景刚需,补齐"坐标 click"能力缺口)。schema 块 +~366B,payload
    // 实测 8378B,cap +400 至 8500 留 ~122B 余量。沿用"加能力调 cap 不压字符"惯例。
    expect(toolsListPayload.length).toBeLessThanOrEqual(11100);
  });

  it("公开工具数量 = 24（23 + vortex_sequence 多步序列）", () => {
    expect(defs.length).toBe(24);
  });

  it("24 个公开工具名匹配 spec L4 §1.1+§1.2 + 工具横向优化 T6+T7+vortex_query+vortex_mouse_click+vortex_browser+vortex_sequence", () => {
    const names = defs.map(d => d.name).sort();
    expect(names).toEqual([
      "vortex_act",
      "vortex_browser",
      "vortex_debug_read",
      "vortex_drag",
      "vortex_evaluate",
      "vortex_extract",
      "vortex_file_upload",
      "vortex_fill",
      "vortex_fill_form",
      "vortex_history",
      "vortex_mouse_click",
      "vortex_mouse_drag",
      "vortex_navigate",
      "vortex_observe",
      "vortex_press",
      "vortex_query",
      "vortex_resize",
      "vortex_screenshot",
      "vortex_sequence",
      "vortex_storage",
      "vortex_tab_close",
      "vortex_tab_create",
      "vortex_tab_list",
      "vortex_wait_for",
    ]);
  });

  it("v0.5 已删/内部化的工具不在 tools/list", () => {
    const names = new Set(defs.map(d => d.name));
    // v0.8: vortex_fill / vortex_evaluate / vortex_mouse_drag / vortex_file_upload
    // 已从内部化回到公开（v0.7.x backlog promotion）。
    // v2.1 PR-A: vortex_tab_list / vortex_history 也从内部化回到公开。
    // 工具横向优化 T6: vortex_drag 提升为公开(元素级 DnD, action=mouse.dragElement,
    // 与坐标版 vortex_mouse_drag/mouse.drag 并存),从本内部化名单移除。
    const internalized = [
      // 写操作 → act
      "vortex_click", "vortex_type", "vortex_select",
      "vortex_scroll", "vortex_hover",
      // 读 → extract / observe
      "vortex_get_text", "vortex_get_html",
      "vortex_frames_list",
      // 等待 → wait_for
      "vortex_wait", "vortex_wait_idle", "vortex_page_info",
      // 调试 → debug_read
      "vortex_console", "vortex_network", "vortex_network_response_body", "vortex_events",
      // 存储 → storage
      "vortex_storage_get", "vortex_storage_set", "vortex_storage_session",
      // 内部化（act/observe 触发）。vortex_mouse_click 已提升为公开坐标点击工具
      // (canvas/无 ref 场景,配对 vortex_mouse_drag),从本内部化名单移除。
      "vortex_mouse_move",
      "vortex_file_download", "vortex_file_list_downloads",
      "vortex_batch",
      // 删除（无业务价值 / 内部化）
      "vortex_ping",
    ];
    for (const n of internalized) {
      expect(names.has(n)).toBe(false);
    }
  });

  it("description 长度 ≤ 230 char", () => {
    // 120 → 180: vortex_act description 恢复原始 hint + 追加 onDialog clause = 174 char。
    // 174 = 120 原始 + 54 onDialog 子句，是真新增能力驱动的增长。
    // 180 → 230: 仅 vortex_query 超(222)，是 8 个 mode 各一段真能力说明累加的结果；
    // 其余工具最长 174(vortex_act)，阈值放宽不会掩盖别处膨胀。
    for (const d of defs) {
      expect(d.description.length).toBeLessThanOrEqual(230);
    }
  });

  it("参数 description 必须在精选白名单内（防滥写）", () => {
    // 原规则是"顶层 property 一律不带 description（节字节）"。2026-08-09 工具选择
    // 评测推翻了这个优先级: 113 个参数只有 2 个有说明,模型在公开站点任务上 4/4
    // 改用 playwright,而 vortex-only 复跑全部完成——是可发现性而非能力问题。
    //
    // 现在改为白名单制: 允许 description,但每一条都要在下面登记并写明理由,
    // 新增必须显式加入。总字节仍由上面的 cap 断言兜底。判据是"模型会填错或
    // 不知道能填什么",tabId/frameId/force 这类自解释参数一律不写。
    const DOCUMENTED: Record<string, string> = {
      "vortex_act.target": "@ref 语法此前只写在源码注释里,模型看不到",
      "vortex_extract.target": "同上,且要说明 null=整页",
      "vortex_screenshot.target": "评测实测: 不知能传 CSS,多花一倍调用(8 次 vs playwright 3 次)",
      "vortex_file_upload.target": "同 target 族",
      "vortex_fill.target": "同 target 族",
      "vortex_fill_form.fields[].target": "同 target 族",
      "vortex_act.value": "各 action 的值形状不同,click 不传/scroll 传对象",
      "vortex_fill.value": "评测实测: daterange 需 {start,end},只能靠报错反推",
      "vortex_wait_for.value": "评测实测: mode=info 时填什么完全无从得知",
      "vortex_query.mode": "评测实测: sheet 只认语雀表格,模型误用于 DOM table",
      "vortex_extract.maxLength": "超长静默截断,不提示会让模型误以为读全了",
      "vortex_query.attr": "attr 支持 , / | 分隔多属性(daddd2b),不写会复发 R11 静默失败",
      "vortex_debug_read.filter": "子字段是 handler 真能力(D16); 盲测复测实测模型把 pattern 嵌进 filter.network,故点明是平铺键",
      "vortex_act.options.fingerprint": "record/verify 契约必须文档化",
      "vortex_sequence.steps[].target": "序列步骤复用 vortex_act 的 target 语义",
      "vortex_sequence.steps[].value": "序列步骤复用 vortex_act 的 value 语义",
      "vortex_sequence.onFailure": "序列失败策略需要明确 stop 或 continue",
    };

    const found: string[] = [];
    function walk(schema: any, path: string, tool: string): void {
      if (!schema || typeof schema !== "object") return;
      if (schema.properties && typeof schema.properties === "object") {
        for (const [k, v] of Object.entries(schema.properties)) {
          if (v && typeof v === "object" && "description" in (v as object)) {
            found.push(`${tool}${path}.${k}`);
          }
          walk(v, `${path}.${k}`, tool);
        }
      }
      if (schema.items) walk(schema.items, `${path}[]`, tool);
      if (schema.oneOf) for (const o of schema.oneOf) walk(o, path, tool);
    }
    for (const d of defs) walk(d.schema, "", d.name);

    expect(found.filter((k) => !(k in DOCUMENTED))).toEqual([]);
    // 白名单不许留废条目,否则会慢慢失去"精选"的意义
    expect(Object.keys(DOCUMENTED).filter((k) => !found.includes(k))).toEqual([]);
  });
});

// v0.8 H-7 fix: `vortex_fill.kind` 在三处 schema 与 extension commit-drivers
// 的 CommitKind 之间必须严格一致。把 COMMIT_KINDS 拆到 @vortex-browser/shared
// 作为单一真值源后，下面三条测试 lock 公开/内部 schema 与 shared 数组一致，
// 任何一边私自加值/减值都会断在 CI。
describe("H-7: vortex_fill.widget enum stays in sync with shared COMMIT_KINDS", () => {
  it("public vortex_fill.widget.enum == COMMIT_KINDS", () => {
    const fill = getToolDefs().find(d => d.name === "vortex_fill")!;
    const enumVals = (fill.schema as { properties: { widget: { enum: string[] } } }).properties.widget.enum;
    expect([...enumVals].sort()).toEqual([...COMMIT_KINDS].sort());
  });

  it("internal vortex_fill.widget.enum == COMMIT_KINDS", () => {
    const fill = getInternalToolDef("vortex_fill")!;
    const enumVals = (fill.schema as { properties: { widget: { enum: string[] } } }).properties.widget.enum;
    expect([...enumVals].sort()).toEqual([...COMMIT_KINDS].sort());
  });
});

// H-13 fix: destructive tools must carry MCP annotations so LLM clients
// (Claude Code, Cursor, …) can gate them with stricter approval prompts.
describe("H-13: destructive public tools carry annotations.destructiveHint", () => {
  it("vortex_evaluate has destructiveHint=true + openWorldHint=true", () => {
    const evaluate = getToolDefs().find(d => d.name === "vortex_evaluate")!;
    expect(evaluate.annotations?.destructiveHint).toBe(true);
    expect(evaluate.annotations?.openWorldHint).toBe(true);
  });

  it("vortex_file_upload has destructiveHint=true + openWorldHint=true", () => {
    const upload = getToolDefs().find(d => d.name === "vortex_file_upload")!;
    expect(upload.annotations?.destructiveHint).toBe(true);
    expect(upload.annotations?.openWorldHint).toBe(true);
  });

  it("non-destructive tools (e.g. vortex_extract) do NOT carry destructiveHint", () => {
    const extract = getToolDefs().find(d => d.name === "vortex_extract")!;
    expect(extract.annotations?.destructiveHint).toBeUndefined();
  });
});

// Bug F (v0.6.0 dogfood): PR #4 门面化把 vortex_observe schema 砍到 scope/filter，
// 漏掉 frames 参数。底层路由（server.ts spread rest, observe.ts:486 args.frames）
// 全部就位，但 LLM 看到的公开 schema 不暴露 → cross-origin iframe / SPA 嵌入场景
// 无从触发 all-permitted。本测试锁住 frames 暴露，防止门面收窄再次静默丢参数。
describe("Bug F regression: vortex_observe surface must expose frames", () => {
  const observe = getToolDefs().find(d => d.name === "vortex_observe")!;
  const props = (observe.schema as { properties: Record<string, any> }).properties;

  it("vortex_observe.schema.properties.frames exists", () => {
    expect(props.frames).toBeDefined();
  });

  // Strict equality (not arrayContaining) — guards against silent enum
  // drift in either direction: subset (capability removed) or superset
  // (untested value sneaked in). Order matches schemas.ts:111 internal enum.
  it("frames enum equals exactly main / all-same-origin / all-permitted / all", () => {
    expect(props.frames.enum).toEqual([
      "main",
      "all-same-origin",
      "all-permitted",
      "all",
    ]);
  });

  // The whole point of the description change is to nudge LLMs to switch
  // away from the implicit 'main' default when iframes are involved.
  // If a future edit drops the hint (e.g. reverts to "List interactive
  // elements in scope."), the schema-shape tests above still pass but
  // discoverability silently regresses — Bug F all over again.
  it("description hints frames usage for iframe contexts", () => {
    expect(observe.description).toMatch(/frames/);
  });
});

// caps opt-in：默认面 verify 不进 tools/list；--caps=testing 时提升进公开面（25）。
// 守住「cap 工具默认零回归 + opt-in 后可见」双向不变量。
describe("I15-caps: vortex_verify 仅在 --caps=testing 时进 tools/list", () => {
  afterEach(() => setEnabledCaps([]));

  it("默认面仍 24，不含 vortex_verify", () => {
    setEnabledCaps([]);
    const defs = getToolDefs();
    expect(defs.length).toBe(24);
    expect(defs.map((d) => d.name)).not.toContain("vortex_verify");
  });

  it("--caps=testing 时公开面 = 25 且含 vortex_verify", () => {
    setEnabledCaps(["testing"]);
    const names = getToolDefs().map((d) => d.name);
    expect(getToolDefs().length).toBe(25);
    expect(names).toContain("vortex_verify");
  });
});

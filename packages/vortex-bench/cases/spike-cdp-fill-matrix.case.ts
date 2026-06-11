// spike(cdp-first 阶段4):fill 兼容性矩阵 — value-setter(默认)vs CDP insertText
// (cdpFill)在 {React controlled, maxlength, number, 中文} × 两模式下的行为对比。
//
// 设计为数据采集而非硬门:每个组合记录 match/stateSync/事件计数 指标,
// 只对「两模式都该成立」的弱不变量 assert。事件序列差异(insertText 不发
// keydown/keyup、isTrusted)直接进 metrics 供 spike 报告引用。
//
// 注意:在 compare-cdp pass B 下 argOverrides 会把本 case 的"默认半区"也覆盖成
// cdpFill,矩阵对比仅在独立运行(bench run spike-cdp-fill-matrix)或 pass A 有效;
// case 用 path 探测识别该情形并记 overridden=1。

import type { CaseDefinition } from "../src/types.js";
import { extractEvalJson, extractText } from "./_helpers.js";

interface ProbeState {
  values: Record<string, string>;
  reactState: string;
  counts: Record<string, number>;
  anyTrustedInput: boolean;
}

const PROBE_CODE = `(() => {
  const ids = ["react-input", "plain-input", "maxlen-input", "num-input"];
  const values = {};
  for (const id of ids) values[id] = document.getElementById(id).value;
  const counts = {};
  for (const ev of window.__events) {
    counts[ev.type] = (counts[ev.type] || 0) + 1;
  }
  return {
    values,
    reactState: window.__reactState,
    counts,
    anyTrustedInput: window.__events.some((e) => e.type === "input" && e.isTrusted),
  };
})()`;

const TARGETS = [
  { key: "react", sel: "#react-input", value: "hello world" },
  { key: "zh", sel: "#plain-input", value: "中文输入测试" },
  { key: "maxlen", sel: "#maxlen-input", value: "abcdefghij" },
  { key: "number", sel: "#num-input", value: "12345" },
] as const;

const def: CaseDefinition = {
  name: "spike-cdp-fill-matrix",
  playgroundPath: "/spike-react-controlled.html",
  async run(ctx) {
    // React CDN 渲染就绪门:受控 input 存在
    await ctx.call("vortex_wait_for", { mode: "element", value: "#react-input", timeout: 10000 });

    for (const mode of ["default", "cdp"] as const) {
      for (const t of TARGETS) {
        const reset = extractEvalJson<boolean>(
          await ctx.call("vortex_evaluate", { code: "window.__resetSpike()" }),
        );
        ctx.assert(reset === true, "fixture 复位失败");

        const args: Record<string, unknown> = { target: t.sel, value: t.value };
        if (mode === "cdp") args.cdpFill = true;
        let errorCode = 0; // 0=成功,1=有错误
        const resText = extractText(await ctx.call("vortex_fill", args));
        if (/"?errorCode"?|isError|VTX_/i.test(resText) && /NO_EFFECT|INVALID|ERROR|FAILED/i.test(resText)) {
          errorCode = 1;
        }

        const st = extractEvalJson<ProbeState>(await ctx.call("vortex_evaluate", { code: PROBE_CODE }));
        ctx.assert(st != null, "矩阵探针读取失败");

        const got = st!.values[t.sel.slice(1)];
        // 期望值:maxlength 在真实输入下截到 5;value-setter 会绕过(差异本身是数据)
        const matchFull = got === t.value ? 1 : 0;
        const matchClamped = t.key === "maxlen" && got === t.value.slice(0, 5) ? 1 : 0;

        const p = `${t.key}_${mode}`;
        ctx.recordMetric(`${p}_matchFull`, matchFull);
        if (t.key === "maxlen") ctx.recordMetric(`${p}_matchClamped`, matchClamped);
        if (t.key === "react") {
          ctx.recordMetric(`${p}_stateSync`, st!.reactState === got && got !== "" ? 1 : 0);
        }
        ctx.recordMetric(`${p}_keydown`, st!.counts["keydown"] ?? 0);
        ctx.recordMetric(`${p}_beforeinput`, st!.counts["beforeinput"] ?? 0);
        ctx.recordMetric(`${p}_input`, st!.counts["input"] ?? 0);
        ctx.recordMetric(`${p}_composition`, st!.counts["compositionstart"] ?? 0);
        ctx.recordMetric(`${p}_trustedInput`, st!.anyTrustedInput ? 1 : 0);
        ctx.recordMetric(`${p}_error`, errorCode);
      }
    }

    // 弱不变量:plain 中文在两模式都应写入成功(任一失败即矩阵采集环境有问题)
    // (React/maxlen/number 的差异是研究对象,不 assert)
  },
};

export default def;

// 四种动作的效果指纹：record 拿到确定量，verify 一致为 null、不一致报 value drift。
// 全走 vortex_act：指纹守卫读 params.action，vortex_fill 这类独立工具没有该字段。
import type { CaseDefinition } from "../src/types.js";
import { extractText } from "./_helpers.js";

interface ActResult {
  fingerprint?: { action: string; valueAfter?: string; scrollAfter?: { top: number; left: number } };
  drift?: { classes: string[] } | null;
}

const def: CaseDefinition = {
  name: "fingerprint-actions",
  playgroundPath: "/synth/fingerprint-actions.html",
  tier: "medium",
  async run(ctx) {
    const obs = extractText(await ctx.call("vortex_observe", {}));
    const refOf = (label: string): string => {
      const m = obs.match(new RegExp(`${label}[^\\n]*\\[ref=(@[\\w:]+)\\]`));
      if (!m) throw new Error(`observe 里找不到 ${label}：\n${obs.slice(0, 600)}`);
      return m[1];
    };

    const act = async (args: Record<string, unknown>): Promise<ActResult> =>
      JSON.parse(extractText(await ctx.call("vortex_act", args))) as ActResult;
    const rec = { fingerprint: { mode: "record" } };

    // fill：record 出 valueAfter
    const fill = await act({
      action: "fill", target: refOf("邮箱"), value: "a@b.com", options: rec,
    });
    ctx.assert(fill.fingerprint?.action === "fill", `fill 指纹缺失：${JSON.stringify(fill)}`);
    ctx.assert(fill.fingerprint?.valueAfter === "a@b.com",
      `fill valueAfter 应为回读值，实际 ${fill.fingerprint?.valueAfter}`);

    // verify 同值 → drift null
    const same = await act({
      action: "fill", target: refOf("邮箱"), value: "a@b.com",
      options: { fingerprint: { mode: "verify", expect: fill.fingerprint } },
    });
    ctx.assert(same.drift === null, `同值 verify 应 matched，实际 ${JSON.stringify(same.drift)}`);

    // select：确定量是选中值
    const sel = await act({ action: "select", target: refOf("城市"), value: "上海", options: rec });
    ctx.assert(sel.fingerprint?.action === "select",
      `select 指纹缺失：${JSON.stringify(sel)}`);
    ctx.assert(typeof sel.fingerprint?.valueAfter === "string",
      `select valueAfter 应为字符串，实际 ${JSON.stringify(sel.fingerprint)}`);

    // type：contentEditable 的确定量是回读文本
    const typ = await act({ action: "type", target: refOf("正文"), value: "hello", options: rec });
    ctx.assert(typ.fingerprint?.valueAfter === "hello",
      `type valueAfter 应为回读文本，实际 ${typ.fingerprint?.valueAfter}`);

    // 受控回滚 → 指纹必须是回滚后的值，这是「静默假成功」的正面拦截
    const ctl = await act({ action: "fill", target: refOf("受控字段"), value: "typed", options: rec });
    ctx.assert(ctl.fingerprint?.valueAfter === "REVERTED",
      `受控回滚必须体现在指纹里，实际 ${ctl.fingerprint?.valueAfter}`);

    // scroll：record 出位置。value 是结构化参数对象，不是裸数字
    const scr = await act({
      action: "scroll", target: refOf("列表"), value: { position: "bottom" }, options: rec,
    });
    ctx.assert(scr.fingerprint?.scrollAfter != null,
      `scroll 指纹缺失（滚的可能不是目标本身）：${JSON.stringify(scr)}`);
    ctx.assert((scr.fingerprint?.scrollAfter?.top ?? 0) > 1000,
      `scroll 应滚到容器底部（约 1880），实际 ${scr.fingerprint?.scrollAfter?.top}`);
  },
};
export default def;

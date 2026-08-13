// 序列底座：绿路径全 verified；红路径（受控回滚）必须中断并把剩余步标 not_executed。
import type { CaseDefinition } from "../src/types.js";
import { extractText } from "./_helpers.js";

interface SeqOut {
  summary: { total: number; verified: number; unverified: number; failed: number; notExecuted: number };
  steps: Array<{ index: number; state: string; drift?: { classes: string[] } | null }>;
}

const def: CaseDefinition = {
  name: "sequence-substrate",
  playgroundPath: "/synth/fingerprint-actions.html",
  tier: "medium",
  async run(ctx) {
    const obs = extractText(await ctx.call("vortex_observe", {}));
    // a11y 树是 `- role "名" [ref=@e3]`，ref 在名字之后；反过来写永远匹配不上。
    const refOf = (label: string): string => {
      const m = obs.match(new RegExp(`${label}[^\\n]*\\[ref=(@[\\w:]+)\\]`));
      if (!m) throw new Error(`observe 里找不到 ${label}：\n${obs.slice(0, 600)}`);
      return m[1];
    };

    // 绿路径：两步都能自证
    const ok = JSON.parse(extractText(await ctx.call("vortex_sequence", {
      steps: [
        { action: "fill", target: refOf("邮箱"), value: "a@b.com" },
        { action: "select", target: refOf("城市"), value: "sh" },
      ],
    }))) as SeqOut;
    ctx.assert(ok.summary.verified === 2, `绿路径应两步 verified，实际 ${JSON.stringify(ok.summary)}`);
    ctx.assert(ok.summary.notExecuted === 0, `绿路径不应有未执行步：${JSON.stringify(ok.summary)}`);

    // 红路径：第一步受控回滚 → stop 策略下第二步必须没跑
    const bad = JSON.parse(extractText(await ctx.call("vortex_sequence", {
      steps: [
        { action: "fill", target: refOf("受控字段"), value: "typed" },
        { action: "fill", target: refOf("邮箱"), value: "never@run.com" },
      ],
      onFailure: "stop",
    }))) as SeqOut;
    ctx.assert(bad.steps[1].state === "not_executed",
      `stop 策略下第二步应为 not_executed，实际 ${bad.steps[1].state}`);
    ctx.assert(bad.summary.notExecuted === 1,
      `未执行步应如实计数，实际 ${JSON.stringify(bad.summary)}`);

    // 判据 3（往返收益）：两个动作只花了一次 MCP 调用。
    // summary.total 是本次调用内执行的动作数，等价的单动作写法需要 2 次调用。
    ctx.assert(ok.summary.total === 2, `序列应在一次调用内完成两步，实际 ${ok.summary.total}`);
  },
};
export default def;

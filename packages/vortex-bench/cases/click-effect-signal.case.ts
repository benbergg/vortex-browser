// GAP-G(N0062) — vortex_act click 效果信号(effect)端到端验证。
// 镜像京东加购 silent-success 现场的可复现版:点击后采集 domMutations / networkRequests,
// 让 agent 自判点击是否真产生副作用。三种按钮断言三类 effect 形态 + 零开销契约。
// effect 在合成 / CDP(useRealMouse / trustedMode)两路皆采集,故断言不区分路径。
import type { CaseDefinition } from "../src/types.js";
import { extractText } from "./_helpers.js";

interface ClickEffect {
  domMutations: number;
  networkRequests: number;
  networkSample: string[];
  urlChanged: boolean;
  focusChanged: boolean;
  ariaChanged: boolean;
  observed: boolean;
  windowMs: number;
}

function parseAct(res: unknown): { success?: boolean; effect?: ClickEffect } {
  return JSON.parse(extractText(res)) as { success?: boolean; effect?: ClickEffect };
}

const def: CaseDefinition = {
  name: "click-effect-signal",
  playgroundPath: "/synth/click-effect-signal.html",
  tier: "medium",
  async run(ctx) {
    // 1) 有效果按钮 → domMutations > 0
    const eff = parseAct(
      await ctx.call("vortex_act", {
        action: "click",
        target: "#eff",
        options: { observeEffect: true, windowMs: 300 },
      }),
    );
    ctx.assert(
      eff.effect != null,
      `effect 字段缺失(扩展可能是旧构建未含 GAP-G): ${JSON.stringify(eff).slice(0, 200)}`,
    );
    ctx.assert(
      eff.effect!.domMutations > 0,
      `有效果按钮应 domMutations>0, got ${eff.effect!.domMutations}`,
    );

    // 2) 惰性按钮 → silent no-op 签名:domMutations=0 且 networkRequests=0
    const inert = parseAct(
      await ctx.call("vortex_act", {
        action: "click",
        target: "#inert",
        options: { observeEffect: true, windowMs: 300 },
      }),
    );
    ctx.assert(
      inert.effect!.domMutations === 0,
      `惰性按钮应 domMutations=0(no-op), got ${inert.effect!.domMutations}`,
    );
    ctx.assert(
      inert.effect!.networkRequests === 0,
      `惰性按钮应 networkRequests=0(no-op), got ${inert.effect!.networkRequests}`,
    );

    // 3) 网络按钮 → networkRequests >= 1(Resource Timing 抓 fetch)
    const net = parseAct(
      await ctx.call("vortex_act", {
        action: "click",
        target: "#net",
        options: { observeEffect: true, windowMs: 500 },
      }),
    );
    ctx.assert(
      net.effect!.networkRequests >= 1,
      `网络按钮应 networkRequests>=1, got ${net.effect!.networkRequests} sample=${JSON.stringify(net.effect!.networkSample)}`,
    );

    // 4) 缺省 observeEffect → 无 effect(零开销契约)
    const noOpt = parseAct(await ctx.call("vortex_act", { action: "click", target: "#inert" }));
    ctx.assert(
      noOpt.effect == null,
      `缺省 observeEffect 不应带 effect, got ${JSON.stringify(noOpt.effect)}`,
    );

    // effect.domMutations / networkRequests 写入 customMetrics,便于报告追踪
    ctx.recordMetric("effDomMutations", eff.effect!.domMutations);
    ctx.recordMetric("netRequests", net.effect!.networkRequests);
  },
};
export default def;

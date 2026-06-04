// 缺口 E — 跨源 OOPIF ⊂ closed shadow。镜像 Stagehand oopif_in_csr。
// **关键非对称(2026-06-04 实测确诊)**:closed shadow 里的普通元素不可达(见
// shadow-closed-unreachable / csr-in-oopif),但 closed shadow 里的 **iframe 内容仍可达**——
// 帧枚举走 chrome.webNavigation.getAllFrames(帧树),不受 closed shadow 影响;帧一旦被
// 枚举到,per-frame 注入即可观测/操作其内容。本 case 锁这条"帧树穿透 closed shadow"的能力。
import type { CaseDefinition } from "../src/types.js";
import { findRef, extractText } from "./_helpers.js";

const def: CaseDefinition = {
  name: "oopif-in-csr",
  playgroundPath: "/synth/oopif-in-csr.html",
  tier: "hard",
  async run(ctx) {
    const snap = extractText(await ctx.call("vortex_observe", { frames: "all-permitted" }));
    const ref = findRef(snap, "跨源按钮");
    ctx.assert(
      ref !== null,
      `closed shadow 内的 iframe 内容应仍可达(帧树枚举不受 shadow 影响)。snapshot:\n${snap.slice(0, 500)}`,
    );
    await ctx.call("vortex_act", { action: "click", target: ref as string });
    await ctx.call("vortex_wait_for", { mode: "idle", value: "dom", timeout: 500 });
    const after = extractText(await ctx.call("vortex_observe", { frames: "all-permitted" }));
    ctx.assert(
      after.includes("OOPIF-CLICKED"),
      `act 应在 closed shadow 内的 OOPIF 生效。after:\n${after.slice(0, 400)}`,
    );
  },
};
export default def;

// 缺口 I — observe 召回 file input。镜像 Stagehand observe_file_uploads:
// observe 应把 <input type=file> 识别为可交互元素。
import type { CaseDefinition } from "../src/types.js";
import { extractText } from "./_helpers.js";

const def: CaseDefinition = {
  name: "i-file-upload-observe",
  playgroundPath: "/synth/i-file-upload.html",
  tier: "medium",
  async run(ctx) {
    const snap = extractText(await ctx.call("vortex_observe", {}));
    ctx.assert(
      snap.includes("上传文件"),
      `observe 应召回 file input(aria-label "上传文件")。snapshot:\n${snap.slice(0, 400)}`,
    );
  },
};
export default def;

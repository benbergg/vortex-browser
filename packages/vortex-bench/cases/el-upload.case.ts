// el-upload：验证 vortex_file_upload 能对接 el-upload 的 hidden input[type=file]。

import type { CaseDefinition } from "../src/types.js";
import { assertResultContains } from "./_helpers.js";

// base64("hello from vortex-bench\n") = "aGVsbG8gZnJvbSB2b3J0ZXgtYmVuY2gK"
const FAKE_CONTENT_B64 = "aGVsbG8gZnJvbSB2b3J0ZXgtYmVuY2gK";
const FILE_NAME = "vortex-bench.txt";

const def: CaseDefinition = {
  name: "el-upload",
  playgroundPath: "/#/el-upload",
  tier: "medium",
  async run(ctx) {
    await ctx.call("vortex_file_upload", {
      selector: "[data-testid=\"target-upload\"] input[type=\"file\"]",
      fileName: FILE_NAME,
      fileContent: FAKE_CONTENT_B64,
      mimeType: "text/plain",
    });
    await ctx.call("vortex_wait_for", {
      mode: "idle",
      value: "dom",
      timeout: 1500
    });

    await assertResultContains(ctx, FILE_NAME);
  },
};

export default def;

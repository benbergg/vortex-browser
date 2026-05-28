// packages/vortex-bench/src/runner/judge-llm.ts
// I/O:BigModel(GLM-4.6V 等)多模态判官调用,经 OpenAI 兼容端点。
// 无 BIGMODEL_API_KEY 时干净抛错,不崩溃。
// 调用一次 chat.completions.create(截图 image_url block + prompt 文本) → 原始文本响应,交给 judge-parse 解析。

import OpenAI from "openai";

/** BigModel 平台 OpenAI 兼容端点(经官方 docs 核实) */
const BIGMODEL_BASE_URL = "https://open.bigmodel.cn/api/paas/v4/";

/** 调用判官时传入的截图数据 */
export interface JudgeImage {
  /** base64 编码的图像数据(不含 data URL 前缀) */
  base64: string;
  /** MIME 类型,如 "image/jpeg" 或 "image/png" */
  mimeType: string;
}

/** callJudge 的入参 */
export interface CallJudgeOptions {
  /** 模型 ID(BigModel 平台串,如 "glm-4.6v");由编排层(T8/T9)决定,此文件不设默认值 */
  model: string;
  /** 判官 prompt 文本(由 judge-prompt.ts 生成) */
  prompt: string;
  /** 截图 */
  image: JudgeImage;
  /** 可选覆盖 BIGMODEL_API_KEY 环境变量 */
  apiKey?: string;
}

/**
 * 调一次 BigModel 多模态判官,返回原始文本响应。
 * 响应由 judge-parse.ts 解析为 ClaimedMiss[]。
 * 图像走 OpenAI 兼容的 image_url 块(BigModel 接受 data URL base64):
 *   { type: "image_url", image_url: { url: "data:image/jpeg;base64,..." } }
 */
export async function callJudge(opts: CallJudgeOptions): Promise<string> {
  const apiKey = opts.apiKey ?? process.env.BIGMODEL_API_KEY;
  if (!apiKey) {
    throw new Error("[judge-llm] 缺少 BIGMODEL_API_KEY 环境变量,judge 子命令需要 BigModel 平台 API key");
  }

  const client = new OpenAI({ apiKey, baseURL: BIGMODEL_BASE_URL });

  // 拼成 data URL,BigModel/Z.ai docs 明确接受
  const dataUrl = `data:${opts.image.mimeType};base64,${opts.image.base64}`;

  const res = await client.chat.completions.create({
    model: opts.model,
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: dataUrl } },
          { type: "text", text: opts.prompt },
        ],
      },
    ],
  });

  // OpenAI Chat Completions 响应:choices[0].message.content 为字符串(纯文本响应)
  return res.choices[0]?.message?.content ?? "";
}

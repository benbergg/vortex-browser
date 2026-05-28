// packages/vortex-bench/src/runner/judge-llm.ts
// I/O:火山方舟(Volcano Ark)Doubao 视觉模型多模态判官调用,经 OpenAI 兼容端点。
// 无 DOUBAO_API_KEY 时干净抛错,不崩溃。
// 调用一次 chat.completions.create(截图 image_url block + prompt 文本) → 原始文本响应,交给 judge-parse 解析。
//
// 选 Doubao 的原因:probe 显示 doubao-1-5-vision-pro-32k 对 cursor:pointer div 等
// 弱视觉信号 recall 命中率 3/3,显著优于 glm-4.6v 的 2/3;价格 ~¥0.007/call;
// OpenAI 兼容 HTTPS,直接 swap baseURL/model/env 即可。

import OpenAI from "openai";

/** 火山方舟 OpenAI 兼容端点(经官方 docs 核实) */
const ARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3/";

/** 调用判官时传入的截图数据 */
export interface JudgeImage {
  /** base64 编码的图像数据(不含 data URL 前缀) */
  base64: string;
  /** MIME 类型,如 "image/jpeg" 或 "image/png" */
  mimeType: string;
}

/** callJudge 的入参 */
export interface CallJudgeOptions {
  /** 模型 ID(火山方舟 endpoint ID 或 model 串,如 "doubao-1-5-vision-pro-32k-250115");由编排层(T8/T9)决定,此文件不设默认值 */
  model: string;
  /** 判官 prompt 文本(由 judge-prompt.ts 生成) */
  prompt: string;
  /** 截图 */
  image: JudgeImage;
  /** 可选覆盖 DOUBAO_API_KEY 环境变量 */
  apiKey?: string;
}

/**
 * 调一次 Doubao 多模态判官,返回原始文本响应。
 * 响应由 judge-parse.ts 解析为 ClaimedMiss[]。
 * 图像走 OpenAI 兼容的 image_url 块(火山方舟接受 data URL base64):
 *   { type: "image_url", image_url: { url: "data:image/jpeg;base64,..." } }
 */
export async function callJudge(opts: CallJudgeOptions): Promise<string> {
  const apiKey = opts.apiKey ?? process.env.DOUBAO_API_KEY;
  if (!apiKey) {
    throw new Error("[judge-llm] 缺少 DOUBAO_API_KEY 环境变量,judge 子命令需要火山方舟 API key");
  }

  const client = new OpenAI({ apiKey, baseURL: ARK_BASE_URL });

  // 拼成 data URL,火山方舟 docs 明确接受 OpenAI image_url 格式
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

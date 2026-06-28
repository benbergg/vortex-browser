/**
 * 行分隔 JSON-RPC 解帧工具。MCP stdio 传输每条消息为一行 JSON(末尾 \n,
 * 消息体内不含裸 \n),与 @modelcontextprotocol/sdk 的 serializeMessage 一致。
 * supervisor 用它在透传 Claude↔child 字节流的同时观察消息(捕获握手/追踪在飞)。
 */
export type JsonRpcMessage = Record<string, unknown>;

/** 一条解析出的消息:raw 保留原始字节(供握手逐字节重放),msg 为解析对象。 */
export interface FramedMessage {
  raw: string;
  msg: JsonRpcMessage;
}

/** 增量解帧器:喂入任意分块,吐出本次能凑齐的完整消息。 */
export class LineFramer {
  private buf = "";

  push(chunk: Buffer | string): FramedMessage[] {
    this.buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const out: FramedMessage[] = [];
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) !== -1) {
      const raw = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (!raw.trim()) continue;
      try {
        out.push({ raw, msg: JSON.parse(raw) as JsonRpcMessage });
      } catch {
        // 非 JSON 行(理论上不该出现):跳过,避免毒化整条流
      }
    }
    return out;
  }
}

/** 序列化为带换行的 JSON-RPC 帧(与 SDK serializeMessage 一致)。 */
export function frame(msg: JsonRpcMessage): string {
  return JSON.stringify(msg) + "\n";
}

/** 请求 = 有 id 且有 method。 */
export function isRequest(msg: JsonRpcMessage): boolean {
  return msg.id != null && typeof msg.method === "string";
}

/** 响应 = 有 id、无 method、且有 result 或 error。 */
export function isResponse(msg: JsonRpcMessage): boolean {
  return (
    msg.id != null &&
    msg.method === undefined &&
    (msg.result !== undefined || msg.error !== undefined)
  );
}

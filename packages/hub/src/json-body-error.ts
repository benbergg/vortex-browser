// Author: qingwa
// Description: express.json() 解析失败时的错误处理。
//
// 背景(真机复现 2026-10-30)：客户端发非法 JSON(实测是 Python repr 的
// `{"code":"1","tabId":None}`)时，express.json() 抛 body-parser 的
// entity.parse.failed，被 Express 默认错误处理接管，返回 **HTML 页面 +
// 内部堆栈**（含 node_modules 绝对路径与请求体片段），日志里也会留下同一段栈。
//
// 后果：① 客户端拿到的是 HTML 而不是 hub 的 JSON 错误形状，无法按 code 分支；
// ② 把内部路径与请求体片段泄露给调用方。
//
// 这里只接管**已知的 body-parser 错误类型**，其余错误照旧交给默认处理
// （如 entity.too.large 的 413 必须保留原状态码，不能一律改 400）。
// 响应里不回显请求体，也不回显堆栈。

import type { NextFunction, Request, Response } from "express";

/** body-parser 错误类型 → (状态码, 面向调用方的说明) */
const BODY_ERRORS: Record<string, { status: number; message: string }> = {
  "entity.parse.failed": {
    status: 400,
    message:
      "Request body is not valid JSON. Send a JSON object (e.g. {\"code\":\"1\",\"tabId\":123}); " +
      "string values must be quoted, and numbers must not be written as None/null/undefined.",
  },
  "entity.too.large": {
    status: 413,
    message: "Request body is too large.",
  },
};

export function jsonBodyErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  const type = (err as { type?: unknown } | null)?.type;
  if (typeof type !== "string" || !(type in BODY_ERRORS)) {
    next(err); // 未知错误保持默认行为，不猜状态码
    return;
  }
  const { status, message } = BODY_ERRORS[type];
  if (res.headersSent) {
    next(err);
    return;
  }
  res.status(status).json({
    message,
    error: { code: "INVALID_PARAMS", message, recoverable: false },
  });
}

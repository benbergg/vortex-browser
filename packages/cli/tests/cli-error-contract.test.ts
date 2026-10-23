import { createServer, type RequestListener, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { formatCliError, sendRequest } from "../src/client.js";

describe("CLI 错误契约", () => {
  it("保留 code / hint / recoverable", () => {
    const text = formatCliError({
      code: "STALE_SNAPSHOT",
      message: "ref 已过期",
      hint: "重新 observe 再试",
      recoverable: true,
    });
    expect(text).toContain("Error [STALE_SNAPSHOT]:");
    expect(text).toContain("ref 已过期");
    expect(text).toContain("重新 observe 再试");
    expect(text).toContain("recoverable");
  });

  it("缺 hint 时不编造", () => {
    const text = formatCliError({ code: "INVALID_PARAMS", message: "参数非法" });
    expect(text).toContain("Error [INVALID_PARAMS]:");
    expect(text).not.toContain("hint:");
  });
});

let httpServer: Server | undefined;

afterEach(async () => {
  if (!httpServer) return;
  await new Promise<void>((resolve, reject) => {
    httpServer!.close((error) => error ? reject(error) : resolve());
  });
  httpServer = undefined;
});

async function startHttpServer(handler: RequestListener): Promise<string> {
  httpServer = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    httpServer!.once("error", reject);
    httpServer!.listen(0, "127.0.0.1", () => resolve());
  });
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("HTTP server did not expose a TCP address");
  return `http://127.0.0.1:${address.port}`;
}

async function sendRequestError(baseUrl: string): Promise<string> {
  const error = await sendRequest("tab.missing", {}, { port: 0, baseUrl }).catch((value) => value);
  expect(error).toBeInstanceOf(Error);
  return (error as Error).message;
}

describe("CLI 非 2xx 错误透传", () => {
  it("从 {error:{...}} 形态取出 code / hint / recoverable / context", async () => {
    const baseUrl = await startHttpServer((_request, response) => {
      response.statusCode = 504;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        message: "Request tab.missing timed out",
        error: {
          code: "TIMEOUT",
          message: "Request tab.missing timed out",
          hint: "确认扩展已连接",
          recoverable: false,
          context: { action: "tab.missing" },
        },
      }));
    });

    const message = await sendRequestError(baseUrl);

    expect(message).toContain("Error [TIMEOUT]:");
    expect(message).toContain("Request tab.missing timed out");
    expect(message).toContain("hint: 确认扩展已连接");
    expect(message).toContain("recoverable: false");
    expect(message).toContain("context:");
  });

  it("从扁平 {code,message,...} 形态取出同样的字段", async () => {
    const baseUrl = await startHttpServer((_request, response) => {
      response.statusCode = 400;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        code: "INVALID_PARAMS",
        message: "tabId must be an integer",
        hint: "带 --tab 重试",
        recoverable: true,
      }));
    });

    const message = await sendRequestError(baseUrl);

    expect(message).toContain("Error [INVALID_PARAMS]:");
    expect(message).toContain("tabId must be an integer");
    expect(message).toContain("hint: 带 --tab 重试");
    expect(message).toContain("recoverable: true");
  });

  it("body 里没有结构化错误时退回裸 message", async () => {
    const baseUrl = await startHttpServer((_request, response) => {
      response.statusCode = 404;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ message: "exact server message" }));
    });

    const message = await sendRequestError(baseUrl);

    expect(message).toBe("exact server message");
    expect(message).not.toContain("Error [");
  });
});

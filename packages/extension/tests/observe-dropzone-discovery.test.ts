/**
 * source-lock 测试:observe.ts 投放区(drop target)发现接线。
 *
 * 背景(iteration 14 真站确诊):observe 的 listener discovery 只筛点击类事件
 * (observe-js-listener.ts CLICK_EVENT_TYPES),drop/dragenter/dragover 监听的投放区
 * 若无 role/无 cursor:pointer/非 draggable,则既不被 discovery 标记也不被启发式收集
 * → 对 observe 任何 filter 不可见 → ref-based vortex_drag 无合法 endRef 投放。
 *
 * 修复:扩展 discovery 标 data-vtx-dropzone,observe scan 把它当入池信号 + 渲染 [dropzone]。
 * scan 内联于 executeScript func,无法行为执行,故以源码锁保护接线不被回退。
 * (marker 模块与渲染层的真行为测试见 observe-js-listener.test.ts。)
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OBSERVE_SRC = readFileSync(join(__dirname, "../src/handlers/observe.ts"), "utf8");

describe("observe.ts 投放区发现接线(source-lock)", () => {
  it("入池信号:cursor!=pointer 分支纳入 data-vtx-dropzone(并集 framework/listener)", () => {
    // __hasDropzone 须参与 continue 守卫,否则仅 drop 监听的 div 被滤掉
    expect(OBSERVE_SRC).toMatch(/__hasDropzone\s*=[\s\S]*?hasAttribute\("data-vtx-dropzone"\)/);
    expect(OBSERVE_SRC).toMatch(
      /if\s*\(\s*!hasFrameworkClick\(el\)\s*&&\s*!__hasDirectListener\s*&&\s*!__hasDropzone\s*\)\s*continue/,
    );
  });

  it("body/html 排除:全局 file-drop 监听绑文档根,不得把整页当投放区", () => {
    // 收集侧守卫
    expect(OBSERVE_SRC).toMatch(
      /hasAttribute\("data-vtx-dropzone"\)\s*&&\s*el\.tagName\s*!==\s*"BODY"\s*&&\s*el\.tagName\s*!==\s*"HTML"/,
    );
  });

  it("dropzone 不让位 finer-pointer 子项(与 direct listener 同,绑在元素自身)", () => {
    expect(OBSERVE_SRC).toMatch(/if\s*\(\s*!__hasDirectListener\s*&&\s*!__hasDropzone\s*\)\s*\{/);
  });

  it("entry 构造:data-vtx-dropzone(排除 body/html)→ dropzoneInteractive 真值透传", () => {
    expect(OBSERVE_SRC).toMatch(/dropzoneInteractive:\s*true as const/);
    // entry 侧也带 body/html 守卫
    const entryGuard =
      /hasAttribute\("data-vtx-dropzone"\)\s*&&[\s\S]{0,80}tagName\s*!==\s*"BODY"[\s\S]{0,40}tagName\s*!==\s*"HTML"[\s\S]{0,40}dropzoneInteractive/;
    expect(OBSERVE_SRC).toMatch(entryGuard);
  });

  it("透传渲染层:e.dropzoneInteractive → 输出 entry(compact + full 两路径)", () => {
    const matches = OBSERVE_SRC.match(/e\.dropzoneInteractive\s*\?\s*\{\s*dropzoneInteractive:\s*true as const\s*\}/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2); // compact + full
  });

  it("marker 清理含 data-vtx-dropzone(防标记残留)", () => {
    expect(OBSERVE_SRC).toMatch(/querySelectorAll\("\[data-vtx-dropzone\]"\)/);
  });
});

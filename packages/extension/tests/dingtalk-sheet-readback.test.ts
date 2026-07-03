// @vitest-environment jsdom
//
// 钉钉 spreadsheetv2(纯 canvas 电子表格)检测 + activeCell 读回。
// 范围(2026-07 dogfood):仅检测 + 地址框 activeCell,单元格网格需 collab-engine
// 模型未 live 验证故不臆造。见 sheet-readback.ts readDingtalkSheet 注释。
import { describe, it, expect } from "vitest";
import {
  readDingtalkSheet,
  readDingtalkActiveCell,
  resolveDingtalkSheetDoc,
} from "../src/page-side/sheet-readback.js";

function docWithAddr(addr: string): Document {
  document.body.innerHTML = `
    <div class="m-formular-bar-inner">
      <div class="name-box">${addr}</div>
      <div class="fx">fx</div>
    </div>`;
  return document;
}

describe("钉钉 activeCell 读回", () => {
  it("从 .m-formular-bar-inner 叶子节点读 A1 地址", () => {
    expect(readDingtalkActiveCell(docWithAddr("B8"))).toBe("B8");
  });

  it("多字母列 + 多位行(AB123)可读", () => {
    expect(readDingtalkActiveCell(docWithAddr("AB123"))).toBe("AB123");
  });

  it("无地址框时返回 null", () => {
    document.body.innerHTML = `<div>无表格</div>`;
    expect(readDingtalkActiveCell(document)).toBeNull();
  });

  it("地址框存在但无合法 A1 文本时返回 null", () => {
    document.body.innerHTML = `<div class="m-formular-bar-inner"><div>请选择</div></div>`;
    expect(readDingtalkActiveCell(document)).toBeNull();
  });
});

describe("钉钉表格检测 resolveDingtalkSheetDoc / readDingtalkSheet", () => {
  it("本 doc 直含地址框 → 检测到,返回该 doc", () => {
    const d = docWithAddr("C5");
    expect(resolveDingtalkSheetDoc(d)).toBe(d);
  });

  it("非钉钉表格页 → resolve 返回 null,readDingtalkSheet 返回 null", () => {
    document.body.innerHTML = `<div class="lake-sheet-editor">语雀</div>`;
    expect(resolveDingtalkSheetDoc(document)).toBeNull();
    expect(readDingtalkSheet(document)).toBeNull();
  });

  it("检测到时返回 {detected:true, activeCell}", () => {
    const info = readDingtalkSheet(docWithAddr("D12"));
    expect(info).toEqual({ detected: true, activeCell: "D12" });
  });
});

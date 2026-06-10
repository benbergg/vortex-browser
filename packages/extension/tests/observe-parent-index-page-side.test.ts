import { describe, it, expect, beforeEach } from "vitest";
import { JSDOM } from "jsdom";

const COMPUTE_PARENT_INDEX = `
  const set = new Set(collectedEls);
  const out = [];
  for (let i = 0; i < collectedEls.length; i++) {
    let parentIdx = undefined;
    let cur = collectedEls[i].parentElement || (collectedEls[i].getRootNode() && collectedEls[i].getRootNode().host) || null;
    while (cur) {
      if (set.has(cur)) {
        parentIdx = collectedEls.indexOf(cur);
        break;
      }
      cur = cur.parentElement || (cur.getRootNode() && cur.getRootNode().host) || null;
    }
    out.push(parentIdx);
  }
  return out;
`;
const computeParentIndex = (collectedEls: Element[]): (number | undefined)[] =>
  new Function("collectedEls", COMPUTE_PARENT_INDEX)(collectedEls);

let document: Document;
beforeEach(() => {
  document = new JSDOM(`<!DOCTYPE html><body>
    <ul id="list"><li id="li1"><span id="s1">名</span><button id="b1">+</button></li></ul>
    <div id="loose"></div>
  </body>`).window.document;
});

describe("computeParentIndex (page-side 建树逻辑)", () => {
  it("nearest collected ancestor, collapsing uncollected wrappers", () => {
    const list = document.getElementById("list")!;
    const b1 = document.getElementById("b1")!;
    const parents = computeParentIndex([list, b1]);
    expect(parents).toEqual([undefined, 0]);
  });

  it("element with no collected ancestor is a root", () => {
    const loose = document.getElementById("loose")!;
    const list = document.getElementById("list")!;
    expect(computeParentIndex([list, loose])).toEqual([undefined, undefined]);
  });

  it("direct parent when both collected", () => {
    const li1 = document.getElementById("li1")!;
    const b1 = document.getElementById("b1")!;
    const list = document.getElementById("list")!;
    expect(computeParentIndex([list, li1, b1])).toEqual([undefined, 0, 1]);
  });

  it("shadow DOM: button inside shadow host resolves to host", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const sr = host.attachShadow({ mode: "open" });
    const btn = document.createElement("button");
    sr.appendChild(btn);
    expect(computeParentIndex([host, btn])).toEqual([undefined, 0]);
  });
});

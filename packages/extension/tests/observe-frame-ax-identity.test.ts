import { describe, expect, it } from "vitest";
import { resolveFrameDocument } from "../src/handlers/observe-ax-overlay.js";

// These are CDP-shaped fixtures, not evidence of Chrome's frame/target routing.
const documentWith = (token: string, backendNodeId: number) => ({
  nodeName: "#document",
  children: [{ nodeName: "HTML", attributes: ["data-vtx-frame-ax", token], children: [
    { nodeName: "BUTTON", backendNodeId, attributes: ["data-vtx-ax", "0"] },
  ] }],
});
const owner = (frameId: string, contentDocument: unknown) => ({ nodeName: "IFRAME", frameId, contentDocument });

describe("CDP child document identity", () => {
  it("uses the unique document marker and its owner CDP ID, not URL or extension ID", () => {
    const a = documentWith("first", 101);
    const b = documentWith("second", 202);
    const root = { children: [owner("CDP-B", b), owner("CDP-A", a)] };
    expect(resolveFrameDocument(root, "first")).toEqual({ frameId: "CDP-A", document: a });
    expect(resolveFrameDocument(root, "second")).toEqual({ frameId: "CDP-B", document: b });
  });

  it("does not assign a nested document's marker to its parent", () => {
    const inner = documentWith("inner", 303);
    const outer = documentWith("outer", 202);
    outer.children.push(owner("CDP-INNER", inner) as never);
    const root = { children: [owner("CDP-OUTER", outer)] };
    expect(resolveFrameDocument(root, "inner")).toEqual({ frameId: "CDP-INNER", document: inner });
    expect(resolveFrameDocument(root, "outer")).toEqual({ frameId: "CDP-OUTER", document: outer });
  });

  it("rejects missing, duplicate, and ownerless mappings", () => {
    expect(resolveFrameDocument({ children: [] }, "x")).toBeUndefined();
    expect(resolveFrameDocument({ children: [owner("A", documentWith("x", 1)), owner("B", documentWith("x", 2))] }, "x")).toBeUndefined();
    expect(resolveFrameDocument({ children: [{ contentDocument: documentWith("x", 1) }] }, "x")).toBeUndefined();
  });
});

// logicflow-connect: lock the regression that default vortex_mouse_drag
// (CDP, no force / no useRealMouse) already triggers a full trusted
// pointer sequence — the exact precondition LogicFlow / AntV X6 anchor
// drag relies on. 2026-06-13 live spike on real banniu falsified the
// V1 claim that "CDP dispatches MouseEvent only, not PointerEvent".
// Keeping this case in the suite means any future PR that adds a
// `force` / synthetic-PointerEvent mode citing "CDP can't fire pointer
// events" will surface as a redundant change against a green assertion.
//
// Reused fixture: /evaluate-globals.html — any JS-injectable blank
// page works; we synthesize the listener target via vortex_evaluate
// so no new fixture file is added.

import type { CaseDefinition } from "../src/types.js";
import { extractEvalJson } from "./_helpers.js";

interface PointerLogEntry {
  type: string;
  isTrusted: boolean;
  pointerType: string;
  buttons: number;
}

interface StageGeometry {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
}

const STEPS = 5;

const def: CaseDefinition = {
  name: "logicflow-connect",
  playgroundPath: "/evaluate-globals.html",
  tier: "easy",
  async run(ctx) {
    // 1. Setup: inject a fixed-position stage div and attach pointer +
    //    mouse listeners that record into window.__pointerLog. Geometry
    //    is read back so the drag stays inside the stage rect.
    const geom = extractEvalJson<StageGeometry>(
      await ctx.call("vortex_evaluate", {
        code: `(() => {
          const prior = document.getElementById('__vortex_drag_stage');
          if (prior) prior.remove();
          const stage = document.createElement('div');
          stage.id = '__vortex_drag_stage';
          stage.style.cssText =
            'position:fixed;left:80px;top:80px;width:320px;height:200px;' +
            'background:#eef;border:1px solid #99c;z-index:99999;';
          document.body.appendChild(stage);
          window.__pointerLog = [];
          const types = [
            'pointerdown', 'pointermove', 'pointerup',
            'mousedown',   'mousemove',   'mouseup',
          ];
          for (const t of types) {
            stage.addEventListener(t, (e) => {
              window.__pointerLog.push({
                type: e.type,
                isTrusted: e.isTrusted === true,
                pointerType: typeof e.pointerType === 'string' ? e.pointerType : '',
                buttons: typeof e.buttons === 'number' ? e.buttons : -1,
              });
            });
          }
          const r = stage.getBoundingClientRect();
          return {
            fromX: r.left + 20,
            fromY: r.top  + r.height / 2,
            toX:   r.right - 20,
            toY:   r.top  + r.height / 2,
          };
        })()`,
      }),
    );
    ctx.assert(geom != null, "stage geometry should be returned");

    // 2. Action: default CDP drag path. No `force`, no `useRealMouse`,
    //    no synthetic PointerEvent override. This is the exact call
    //    shape that connected a LogicFlow edge in the live spike.
    await ctx.call("vortex_mouse_drag", {
      fromX: geom.fromX,
      fromY: geom.fromY,
      toX: geom.toX,
      toY: geom.toY,
      steps: STEPS,
    });

    // 3. Assert: the recorded log must contain a trusted pointerdown
    //    (isTrusted, pointerType=mouse, buttons=1), >= STEPS pointermove
    //    entries, and a pointerup. Reading back as an array — vortex_evaluate
    //    JSON-stringifies at the MCP boundary, extractEvalJson parses it.
    const log = extractEvalJson<PointerLogEntry[]>(
      await ctx.call("vortex_evaluate", {
        code: "window.__pointerLog || []",
      }),
    );
    ctx.assert(
      Array.isArray(log) && log.length > 0,
      `__pointerLog should be a non-empty array, got: ${JSON.stringify(log).slice(0, 200)}`,
    );

    const pointerdown = log.find((e) => e.type === "pointerdown");
    ctx.assert(
      pointerdown != null,
      `CDP drag should fire pointerdown (regression: would mean CDP path lost pointer events). log types: ${log.map((e) => e.type).join(",")}`,
    );
    ctx.assert(
      pointerdown!.isTrusted === true,
      `pointerdown.isTrusted should be true (CDP path is the only one that yields trusted pointer events). got: ${JSON.stringify(pointerdown)}`,
    );
    ctx.assert(
      pointerdown!.pointerType === "mouse",
      `pointerdown.pointerType should be 'mouse'. got: ${JSON.stringify(pointerdown)}`,
    );
    ctx.assert(
      pointerdown!.buttons === 1,
      `pointerdown.buttons should be 1 (primary button held during drag). got: ${JSON.stringify(pointerdown)}`,
    );

    // CDP drag dispatches one move per intermediate step (STEPS), but the
    // browser COALESCES pointermove delivery under load — observed counts
    // vary run-to-run (3–5 for STEPS=5). The regression this case locks is
    // "CDP path fires a trusted pointer MOVE sequence during drag", not an
    // exact count; asserting `>= STEPS` was brittle (flaky <5). Require at
    // least 2 moves (a genuine drag, not a teleport) with a held button on
    // one of them — coalescing-tolerant while still proving the sequence.
    const moves = log.filter((e) => e.type === "pointermove");
    ctx.assert(
      moves.length >= 2,
      `pointermove sequence should fire during CDP drag (>=2, coalescing-tolerant). got: ${moves.length}`,
    );
    ctx.assert(
      moves.some((m) => m.buttons === 1),
      `at least one pointermove should carry buttons=1 (button held during drag). got: ${JSON.stringify(moves).slice(0, 200)}`,
    );

    const pointerup = log.find((e) => e.type === "pointerup");
    ctx.assert(
      pointerup != null,
      `CDP drag should fire pointerup. log types: ${log.map((e) => e.type).join(",")}`,
    );

    // Cleanup so the synthesized stage doesn't bleed into the next case
    // if the runner reuses the tab.
    await ctx.call("vortex_evaluate", {
      code: `(() => {
        const s = document.getElementById('__vortex_drag_stage');
        if (s) s.remove();
        delete window.__pointerLog;
      })()`,
    });
  },
};

export default def;

// mode=schema 结构化回读。fixture 三源齐全，且含非法 JSON-LD / itemref / name="og:" 非规范写法。
import type { CaseDefinition } from "../src/types.js";
import { extractText } from "./_helpers.js";

interface SchemaEntity {
  type: string;
  props: Record<string, unknown>;
  source: string;
  untrusted: boolean;
  id?: string;
}

const def: CaseDefinition = {
  name: "query-schema",
  playgroundPath: "/synth/schema-readback.html",
  tier: "easy",
  async run(ctx) {
    // 工具返回 {text,total,truncated}；attr=json 时实体载荷在 text 里，要剥两层
    const all = extractText(await ctx.call("vortex_query", { mode: "schema", pattern: "*", attr: "json" }));
    const outer = JSON.parse(all) as { text: string; total: number };
    const parsed = JSON.parse(outer.text) as { entities: SchemaEntity[]; total: number };

    const bySource = (p: string) => parsed.entities.filter((e) => e.source.startsWith(p));
    ctx.assert(bySource("jsonld").length === 3, `JSON-LD 应出 3 个实体，实际 ${bySource("jsonld").length}`);
    ctx.assert(bySource("microdata").length === 2, `Microdata 应出 2 个实体，实际 ${bySource("microdata").length}`);
    ctx.assert(bySource("og").length === 1, `OGP 应出 1 个实体，实际 ${bySource("og").length}`);
    ctx.assert(parsed.entities.every((e) => e.untrusted === true), "所有实体必须带 untrusted");

    const product = parsed.entities.find((e) => e.type.endsWith("Product"));
    ctx.assert(product?.id === "https://fixture.test/p/1", `Product 的 @id 应被提取，实际 ${product?.id}`);
    ctx.assert(
      JSON.stringify(product?.props.offers).includes("99.00"),
      `嵌套 offers 应原样保留在 props，实际 ${JSON.stringify(product?.props.offers)}`,
    );

    // 非规范 name="og:site_name" 必须被收，否则说明双属性回退失效
    const og = bySource("og")[0];
    ctx.assert(og.props.site_name === "Fixture Shop", `name="og:" 写法应被收，实际 ${JSON.stringify(og.props)}`);

    // 非法 JSON-LD 只废那一段：合计 6 个实体说明另两段照常解析
    ctx.assert(parsed.total === 6, `合计应为 6 个实体，实际 ${parsed.total}`);

    // 过滤空时必须自陈，且指出是过滤条件的问题而非页面没有数据
    const missText = JSON.stringify(await ctx.call("vortex_query", { mode: "schema", pattern: "NoSuchType" }));
    ctx.assert(missText.includes("NoSuchType"), `过滤空时自陈应点名过滤条件。实际:\n${missText.slice(0, 400)}`);
    ctx.assert(missText.includes("JSON-LD script"), `过滤空时自陈应报出扫到的事实。实际:\n${missText.slice(0, 400)}`);
    // 本 fixture 的 itemscope 全部带 itemtype，自陈不得声称有 item 因缺 itemtype 被跳过
    ctx.assert(!missText.includes("no itemtype"), `不得编造 itemtype 跳过。实际:\n${missText.slice(0, 400)}`);
  },
};
export default def;

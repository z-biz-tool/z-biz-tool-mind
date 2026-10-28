/**
 * 流程图两码（flowRight / flowDown，超出蓝本的自研版式，03 §1.3-32）。
 *
 * 与既有版式族的三条边界：
 * 1) 一级分支不是"枝"是"步骤"：链上画的是步骤之间的流线箭头（根 → 步骤 1 → 步骤 2 …），
 *    数量守恒仍是"主题数 - 1"，但落点从父子桩变成了前驱后继；
 * 2) 箭头不进 d：连线的 d 被全码通用的"折线不许有斜段"门盯着，chevron 走
 *    ConnectorPath.head（buildAxis.head 同一条先例），画布 / SVG / PDF 三处各补一笔同色 path；
 * 3) 子树挂在步骤右下角的目录式（深度=列、前序=行），与 layoutTreeCorner 同一套规矩 ——
 *    深层盒子不许横过来压住浅层连线（右向时曾把子树排在步骤正下方，连到第二个子步骤的
 *    竖线会从第一个子步骤的框里穿过去，就是靠这条断言抓出来的）。
 */
import { done, eq, near, ok } from "./_harness.ts";
import { createPage } from "../src/model/factory.ts";
import { insertChild } from "../src/engine/tree.ts";
import { computeLayout } from "../src/engine/layout.ts";
import { paintPage, renderSvg } from "../src/engine/export/svg.ts";
import type { NodeBox } from "../src/engine/layout.ts";

let page = createPage("流程");
page = insertChild(page, page.rootId, "第一步").page;
page = insertChild(page, page.rootId, "第二步").page;
page = insertChild(page, page.rootId, "第三步").page;
const root = page.rootId;
const [s1, s2, s3] = page.shapes[root].childIds;
page = insertChild(page, s1, "子步骤甲").page;
page = insertChild(page, s1, "子步骤乙").page;
page = insertChild(page, s1, "子步骤丙").page;
const [sa, sb] = page.shapes[s1].childIds;
page = insertChild(page, sa, "孙步骤").page;
const total = Object.keys(page.shapes).length;

/** 路径顶点序列（M/L 都是绝对坐标，两两成点）。 */
const pts = (d: string): [number, number][] => {
  const n = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < n.length; i += 2) out.push([n[i], n[i + 1]]);
  return out;
};
/** 数一条路径里有几段斜线（箭头 chevron 不算 —— 它住在 head 里，不进 d）。 */
const slanted = (d: string) => {
  const n = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  let bad = 0;
  for (let i = 2; i + 1 < n.length; i += 2)
    if (n[i] !== n[i - 2] && n[i + 1] !== n[i - 1]) bad += 1;
  return bad;
};
const overlapBad = (boxes: Record<string, NodeBox>) => {
  const bs = Object.values(boxes);
  const bad: string[] = [];
  for (let i = 0; i < bs.length; i += 1)
    for (let j = i + 1; j < bs.length; j += 1) {
      const ox = Math.min(bs[i].x + bs[i].w / 2, bs[j].x + bs[j].w / 2) -
        Math.max(bs[i].x - bs[i].w / 2, bs[j].x - bs[j].w / 2);
      const oy = Math.min(bs[i].y + bs[i].h / 2, bs[j].y + bs[j].h / 2) -
        Math.max(bs[i].y - bs[i].h / 2, bs[j].y - bs[j].h / 2);
      if (ox > 1 && oy > 1) bad.push(`${bs[i].id}×${bs[j].id}`);
    }
  return bad;
};

/* ---------------- flowRight：链从左往右 ---------------- */

const R = computeLayout({ ...page, layout: { ...page.layout, code: "flowRight" } });
const b = (id: string) => R.boxes[id];
eq("右向：每个主题都有盒子", Object.keys(R.boxes).length, total);
eq("右向：连线数 = 主题数 - 1", R.connectors.length, total - 1);
eq(
  "右向：步骤按文档序从左往右",
  [b(s1).x < b(s2).x, b(s2).x < b(s3).x],
  [true, true]
);
near("右向：三个步骤在同一行", b(s1).y, b(s3).y, 0.51);
ok("右向：根主题站在链头左侧", b(root).x + b(root).w / 2 <= b(s1).x - b(s1).w / 2, "");

const chain1 = R.connectors.find((c) => c.id === `c-${root}-${s1}`);
ok("右向：根到第一步的链箭头存在", chain1 !== undefined, "");
if (chain1) {
  const p = pts(chain1.d);
  eq("右向：链箭头是两点的水平线", [p.length, p[0][1] === p[1][1]], [2, true]);
  near("右向：箭头从根的右缘出", p[0][0], b(root).x + b(root).w / 2, 0.51);
  near("右向：箭头指入第一步的左缘", p[1][0], b(s1).x - b(s1).w / 2, 0.51);
  ok("右向：链箭头带 chevron（head）", typeof chain1.head === "string" && chain1.head.length > 0, "");
  const hp = chain1.head ? pts(chain1.head) : [];
  ok("右向：chevron 尖顶落在入射点上", hp.length === 3 && hp[1][0] === p[1][0] && hp[1][1] === p[1][1], chain1.head ?? "");
  ok("右向：chevron 翼在来路一侧（向左张）", hp.length === 3 && hp[0][0] < hp[1][0] && hp[2][0] < hp[1][0], chain1.head ?? "");
}

const stub = R.connectors.find((c) => c.id === `c-${s1}-${sa}`);
ok("右向：子步骤桩存在", stub !== undefined, "");
if (stub) {
  const p = pts(stub.d);
  near("右向：桩从父步骤底边出（x=父中心）", p[0][0], b(s1).x, 0.51);
  near("右向：桩从父步骤底边出（y=父下缘）", p[0][1], b(s1).y + b(s1).h / 2, 0.51);
  near("右向：桩指入子步骤左缘", p[p.length - 1][0], b(sa).x - b(sa).w / 2, 0.51);
  eq("右向：桩的折线一段斜线都没有", slanted(stub.d), 0);
  ok("右向：桩也带 chevron", typeof stub.head === "string" && stub.head.length > 0, "");
}
eq(
  "右向：子步骤在父的右下方",
  [b(sa).x > b(s1).x, b(sa).y > b(s1).y],
  [true, true]
);
ok("右向：孙步骤在子步骤右侧", (() => {
  const gId = page.shapes[sa].childIds[0];
  return b(gId).x > b(sa).x;
})(), "");
eq("右向：盒子互不压框", overlapBad(R.boxes), []);
eq(
  "右向：深层子树不会撞进下一步的领地",
  (() => {
    const rightOfSub = Math.max(...[sa, sb].map((id) => b(id).x + b(id).w / 2));
    const gId = page.shapes[sa].childIds[0];
    const gRight = b(gId).x + b(gId).w / 2;
    return b(s2).x - b(s2).w / 2 >= Math.max(rightOfSub, gRight);
  })(),
  true
);

/* ---------------- flowDown：链从上往下 ---------------- */

const D = computeLayout({ ...page, layout: { ...page.layout, code: "flowDown" } });
const dv = (id: string) => D.boxes[id];
near("向下：三个步骤在同一列", dv(s1).x, dv(s3).x, 0.51);
eq(
  "向下：步骤按文档序从上往下",
  [dv(s1).y < dv(s2).y, dv(s2).y < dv(s3).y],
  [true, true]
);
ok("向下：根主题压在链头之上", dv(root).y + dv(root).h / 2 <= dv(s1).y - dv(s1).h / 2, "");
const dchain = D.connectors.find((c) => c.id === `c-${root}-${s1}`);
ok("向下：链箭头存在", dchain !== undefined, "");
if (dchain) {
  const p = pts(dchain.d);
  eq("向下：链箭头是两点的竖直线", [p.length, p[0][0] === p[1][0]], [2, true]);
  ok("向下：chevron 翼在来路一侧（向上张）", (() => {
    const h = dchain.head ? pts(dchain.head) : [];
    return h.length === 3 && h[0][1] < h[1][1] && h[2][1] < h[1][1];
  })(), dchain.head ?? "");
}
eq("向下：盒子互不压框", overlapBad(D.boxes), []);

/* ---------------- 层级裁剪与导出 ---------------- */

const cut = computeLayout({ ...page, layout: { ...page.layout, code: "flowRight" } }, { displayLevel: 1 });
ok(
  "显示层级 1 时子步骤整层不进布局",
  cut.boxes[sa] === undefined && cut.boxes[sb] === undefined && cut.boxes[s1] !== undefined,
  ""
);
eq("裁剪后连线跟着少（链 3 + 桩 0）", cut.connectors.length, 3);
eq("裁剪后箭头也跟着少（只剩链上 3 支）", cut.connectors.filter((c) => c.head).length, 3);

const paint = paintPage({ ...page, layout: { ...page.layout, code: "flowRight" } });
eq(
  "导出侧的箭头一共 7 支（链 3 + 桩 4），画布导出同一份",
  paint.connectors.filter((c) => c.head).length,
  7
);
eq("流程页没有主轴", paint.layout.axis, null);
const svg = renderSvg(paint);
// chevron 是带斜段的折线 path（corner 桩全是轴对齐段）；全页只有 7 支箭头带斜段
const ds = (svg.match(/<path d="([^"]+)"/g) ?? []).map((m) => m.slice("<path d=\"".length, -1));
const chevrons = ds.filter((d) => !d.includes("C") && slanted(d) > 0);
eq("SVG 里恰好 7 支 chevron path", chevrons.length, 7);

done();

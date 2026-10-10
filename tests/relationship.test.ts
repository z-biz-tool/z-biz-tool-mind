/**
 * 关系线：数据侧一直读得到、也存得回，但画布和导出以前一条都没画 ——
 * 导入带关系线的文件等于静默丢内容。这里钉住"画得出来、只有一份几何、两端点顺序无关"。
 */
import { done, eq, ok } from "./_harness.ts";
import { createDocument, createPage } from "../src/model/factory.ts";
import {
  insertChild,
  relationshipBetween,
  relationshipReveal,
  removeShape,
  setCollapsed,
  setRelationshipText,
  revealCollapsed,
  toggleRelationship,
} from "../src/engine/tree.ts";
import { computeLayout, relationshipPaths } from "../src/engine/layout.ts";
import { buildSvg, paintPage } from "../src/engine/export/svg.ts";
import { parseEmmx, writeEmmx } from "../src/engine/emmx/codec.ts";
import { plainText } from "../src/types/model.ts";
import type { Page, RelationshipShape } from "../src/types/model.ts";

/** d = "M x y Q cx cy x y"，测试要把锚点抠出来核对它确实落在框边上。 */
function pts(d: string): number[] {
  return d
    .split(/[\sMQ]+/)
    .filter(Boolean)
    .map(Number);
}

function withRels(p: Page, rels: RelationshipShape[]): Page {
  return { ...p, relationships: rels };
}

/** 点 (px,py) 到直线 (ax,ay)-(bx,by) 的距离。 */
function perpendicular(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const vx = bx - ax;
  const vy = by - ay;
  const len = Math.hypot(vx, vy) || 1;
  return Math.abs(vx * (py - ay) - vy * (px - ax)) / len;
}

let page = createPage("关系线");
for (const t of ["左侧甲", "左侧乙", "另一头"]) page = insertChild(page, page.rootId, t).page;
const [a, b, c] = page.shapes[page.rootId].childIds;

eq("没连线时一条都不画", relationshipPaths(page, computeLayout(page).boxes).length, 0);
eq("界面里没选够两个主题就不该有连线", toggleRelationship(page, a, a) === page, true);
eq("连着不存在的主题等于没连", toggleRelationship(page, a, "9999") === page, true);

let linked = toggleRelationship(page, a, b);
eq("连一条就是一条", linked.relationships.length, 1);
eq("再点一次是同一条取消掉", toggleRelationship(linked, b, a).relationships.length, 0);
ok(
  "查找与端点顺序无关",
  relationshipBetween(linked, a, b)?.id === relationshipBetween(linked, b, a)?.id,
  JSON.stringify(linked.relationships)
);

const layout = computeLayout(linked);
const rel = relationshipPaths(linked, layout.boxes);
eq("画布拿到一条", rel.length, 1);
const p = pts(rel[0].d);
eq("路径是一笔二次曲线", rel[0].d.startsWith("M ") && rel[0].d.includes(" Q "), true);

// 两端锚点必须贴在各自主题的边上，不能扎在框里或飘在框外
const onEdge = (id: string, x: number, y: number) => {
  const box = layout.boxes[id];
  const hitX = Math.abs(x - (box.x - box.w / 2)) < 0.01 || Math.abs(x - (box.x + box.w / 2)) < 0.01;
  const hitY = Math.abs(y - (box.y - box.h / 2)) < 0.01 || Math.abs(y - (box.y + box.h / 2)) < 0.01;
  return hitX || hitY;
};
ok("起点贴在起端主题的边框上", onEdge(rel[0].fromId, p[0], p[1]), rel[0].d);
ok("终点贴在终端主题的边框上", onEdge(rel[0].toId, p[4], p[5]), rel[0].d);
ok(
  "控制点把线弯出去了（不是直的）",
  Math.hypot(p[2] - (p[0] + p[4]) / 2, p[3] - (p[1] + p[5]) / 2) > 0.5,
  rel[0].d
);

const swapped = withRels(linked, [{ ...linked.relationships[0], beginId: b, endId: a }]);
const relSwap = relationshipPaths(swapped, computeLayout(swapped).boxes);
const ps = pts(relSwap[0].d);
ok(
  "端点换了顺序，弧还是同一条",
  Math.abs(ps[2] - p[2]) < 0.01 && Math.abs(ps[3] - p[3]) < 0.01,
  `${rel[0].d} vs ${relSwap[0].d}`
);

// 折叠掉一端：那个主题根本不在当前布局里，半条线没有意义
const a1 = insertChild(linked, a, "被折叠的孩子").page;
const folded = setCollapsed(a1, a, true);
const rels1 = withRels(folded, [
  ...folded.relationships,
  {
    id: "9001",
    beginId: c,
    endId: a1.shapes[a].childIds[0],
    text: a1.shapes[a1.shapes[a].childIds[0]].text,
    style: {},
  },
]);
const foldLayout = computeLayout(rels1);
ok(
  "端点被折叠时不画",
  foldLayout.boxes[rels1.relationships[1].endId] === undefined &&
    relationshipPaths(rels1, foldLayout.boxes).length === 1,
  String(Object.keys(foldLayout.boxes).length)
);

// 删主题要顺手摘掉挂在它身上的线（P-1：一处数据一个答案）
const gone = removeShape(linked, a);
eq("主题删了，连着它的线也没了", gone.relationships.length, 0);

// 样式：虚线、线色、线宽都从关系线自己的 style 来
const styled = withRels(linked, [
  {
    ...linked.relationships[0],
    text: setRelationshipText(linked, linked.relationships[0].id, "依赖").relationships[0].text,
    style: {
      line: {
        weight: 2.5,
        style: "Dashes",
        fill: { type: "Solid", color: { v: "#ff0000" } },
      },
    },
  },
]);
const relStyled = relationshipPaths(styled, computeLayout(styled).boxes)[0];
eq("虚线样式跟着模型走", relStyled.dash, "6 4");
eq("线色取关系线自己的", relStyled.line, "#ff0000");
eq("线宽取关系线自己的", relStyled.lineWidth, 2.5);
eq("线上写着说明文字", relStyled.text, "依赖");

const svg = buildSvg(styled);
ok("导出的 SVG 里就是同一条路径", svg.includes(`d="${relStyled.d}"`), relStyled.d);
ok("导出的 SVG 里有线上那四个字", svg.includes(">依赖</text>"));
// 关系线常从别的主题身上跨过去：画在框底下，那段弧就被填色盖得一个字都不露
ok(
  "关系线画在所有矩形之后",
  svg.indexOf(`d="${relStyled.d}"`) > svg.lastIndexOf("<rect"),
  `rel@${svg.indexOf(`d="${relStyled.d}"`)} lastRect@${svg.lastIndexOf("<rect")}`
);
ok(
  "相邻主题之间也弯得出来（不是贴着框的一条直线）",
  // 垂距而不是 y 分量差：同侧相邻主题的弦是竖直的，只量纵向会在该弯的时候读到 0。
  perpendicular(p[2], p[3], p[0], p[1], p[4], p[5]) >= 12,
  rel[0].d
);
const paintRel = paintPage(styled).rels;
eq("画布与导出共用一份关系线几何", paintRel[0].d, relStyled.d);

// emmx 往返：界面上连出来的线要真的落到文件里，改过的线色也不许在重生成节点时丢掉
const doc = createDocument("关系线往返");
let docPage = insertChild(doc.pages[0], doc.pages[0].rootId, "主题一").page;
docPage = insertChild(docPage, docPage.rootId, "主题二").page;
const [t1, t2] = docPage.shapes[docPage.rootId].childIds;
const drawn = toggleRelationship(docPage, t1, t2);
const saved = await writeEmmx({ ...doc, pages: [drawn] });
const back = (await parseEmmx(saved)).doc.pages[0];
eq("写出去的关系线读得回来", back.relationships.length, 1);
ok(
  "端点还是那两个主题",
  relationshipBetween(back, t1, t2) !== undefined,
  JSON.stringify(back.relationships)
);

const colored = withRels(drawn, [
  {
    ...drawn.relationships[0],
    style: {
      line: { weight: 3, style: "Dashes", fill: { type: "Solid", color: { v: "#00A859" } } },
    },
  },
]);
const back2 = (await parseEmmx(await writeEmmx({ ...doc, pages: [colored] }))).doc.pages[0];
const r2 = back2.relationships[0];
eq("线色存住了", r2?.style.line?.fill?.color?.v, "#00A859");
eq("虚线存住了", r2?.style.line?.style, "Dashes");
eq("线宽存住了", r2?.style.line?.weight, 3);

const twoRels = toggleRelationship(linked, a, c);
eq("第二条线叠在同一个起点上", twoRels.relationships.length, 2);
const named = setRelationshipText(twoRels, twoRels.relationships[0].id, "依赖");
eq("标注写进了这一条", plainText(named.relationships[0].text), "依赖");
eq("别的线不受影响", plainText(named.relationships[1].text), "");
eq(
  "标注只改文字，端点不动",
  `${named.relationships[0].beginId}>${named.relationships[0].endId}`,
  `${twoRels.relationships[0].beginId}>${twoRels.relationships[0].endId}`
);
eq("改不存在的线等于没改", setRelationshipText(linked, "9999", "x") === linked, true);
ok(
  "几何读得到这条标注",
  relationshipPaths(named, computeLayout(named).boxes).some((r) => r.text === "依赖")
);

// ---- 关系线"打开时自动展开"（03 §1.3-31）：揭示是视图态，模型与 <Toggler> 一个字节都不动 ----

eq(
  "没有关系线就无事可做",
  JSON.stringify(relationshipReveal(page)),
  JSON.stringify({ ids: [], maxLevel: 0 })
);

// rels1：a 被折叠，第二条关系线从 c 连到 a 的折叠子树里（深度 2）
const rev1 = relationshipReveal(rels1);
ok(
  "揭示表抓住折叠祖先",
  rev1.ids.length === 1 && rev1.ids[0] === a,
  JSON.stringify(rev1)
);
eq("端点深度决定要抬的层级", rev1.maxLevel, 2);

// 深处的端点被两层折叠挡住：两层都要揭示，层级抬到端点那一层
const deep1 = insertChild(rels1, a, "深层一").page;
const deep1Id = deep1.shapes[a].childIds[deep1.shapes[a].childIds.length - 1];
const deep2 = insertChild(deep1, deep1Id, "深层二").page;
const deepEnd = deep2.shapes[deep1Id].childIds[0];
const deepRel = withRels(deep2, [
  ...deep2.relationships,
  { id: "9002", beginId: b, endId: deepEnd, text: deep2.shapes[deepEnd].text, style: {} },
]);
const folded2 = setCollapsed(deepRel, deep1Id, true);
const rev2 = relationshipReveal(folded2);
ok(
  "两层折叠祖先都在表里",
  rev2.ids.length === 2 && rev2.ids.includes(a) && rev2.ids.includes(deep1Id),
  JSON.stringify(rev2)
);
eq("层级抬到端点那一层", rev2.maxLevel, 3);

// 揭示的落笔方式：派生副本摘 collapsed，原页保持同一引用、同一字节
const snapshot = JSON.stringify(rels1);
const shown = revealCollapsed(rels1, rev1.ids);
ok("派生页上折叠被摘掉", shown.shapes[a].extras.collapsed === false, String(shown.shapes[a].extras.collapsed));
eq("原始页一个字节都没动", JSON.stringify(rels1), snapshot);
eq("没列进表的形状保持同一引用", shown.shapes[b], rels1.shapes[b]);
ok("揭示列表为空就原样返回", revealCollapsed(rels1, []) === rels1);

// 绘制层：折叠挡住的那条线回来了，徽标跟着归零，模型仍然折叠
eq("揭示前那条线不画", paintPage(rels1).rels.length, 1);
const paintShown = paintPage(rels1, { reveal: rev1.ids });
eq("揭示后画布看得见那条线", paintShown.rels.length, 2);
ok(
  "揭示后的折叠徽标归零（画的份数与看见的一致）",
  paintShown.boxes.find((x) => x.id === a)?.hiddenCount === 0,
  JSON.stringify(paintShown.boxes.find((x) => x.id === a))
);
eq("绘制不洗模型", JSON.stringify(rels1), snapshot);

// 导出同一份 opts：SVG 里也多出那条线；不加 reveal 就是没有
const svgPlain = buildSvg(rels1);
const svgShown = buildSvg(rels1, { reveal: rev1.ids });
const shownPath = paintShown.rels.find((r) => r.toId === rels1.relationships[1].endId)?.d;
ok("揭示后的 SVG 里就是那条路径", Boolean(shownPath) && svgShown.includes(`d="${shownPath}"`), shownPath ?? "");
ok("不加揭示的 SVG 里没有它", Boolean(shownPath) && svgPlain.includes(`d="${shownPath}"`) === false, shownPath ?? "");

done();

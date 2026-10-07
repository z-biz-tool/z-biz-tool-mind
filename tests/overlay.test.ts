/**
 * 页面级覆盖层：外框、概要大括号、概要主题、标注框。
 *
 * 缺陷形状（这里刻意覆盖的）：
 * 1) 亿图用 id 列表表达"盖住谁"（`<BoundaryData><Shapes V="104;111"/>`、`<Callout V="182;183"/>`），
 *    不是兄弟下标 —— 下标模型表达不了跨分支的选区；
 * 2) 这四类 Shape 的 `<LevelData>` 是空的，永远不在主题树里。以前它们存得回、却一个都不画：
 *    真实用户图 doc4 里 18 个标注框，画布与导出全空；
 * 3) 覆盖层必须跟着布局走：折叠掉一个成员，框要缩，不能停在原地；
 * 4) 屏上和导出必须是同一份几何（P-2 只有一条绘制路径）。
 *
 * 注：五份用户地图里没有出现过一个外框/概要（实测 Type="Boundary" 计数 0），
 * 页面级格式的唯一真样本是亿图自己那份内置模板页（同一个 Page schema），所以拿它当夹具。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { done, eq, near, ok, skip } from "./_harness.ts";
import { parseEmmx, writeEmmx } from "../src/engine/emmx/codec.ts";
import { computeLayout, overlayShapes, type OverlayPaint } from "../src/engine/layout.ts";
import { buildSvg, paintPage } from "../src/engine/export/svg.ts";
import { createDocument, createPage, createShape } from "../src/model/factory.ts";
import {
  addBoundary,
  addCallout,
  addSummary,
  countTopics,
  insertChild,
  layersCovering,
  normalize,
  removeOverlay,
  removeShape,
  setCollapsed,
} from "../src/engine/tree.ts";
import { plainText, type DocumentModel, type Page, type Shape } from "../src/types/model.ts";

const TEMPLATE = join(process.cwd(), "_research", "extract", "overlay", "boundary-summary.emmx");
const DOC4 = join(process.cwd(), "_research", "extract", "doc4", "doc.zip");

/** 覆盖层的留白，与 layout.ts 里的 OVERLAY_PAD 同一个数。 */
const PAD = 12;

function addShape(p: Page, s: Shape): Page {
  return { ...p, shapes: { ...p.shapes, [s.id]: s } };
}
function withExtras(p: Page, id: string, extras: Shape["extras"]): Page {
  return {
    ...p,
    shapes: {
      ...p.shapes,
      [id]: { ...p.shapes[id], extras: { ...p.shapes[id].extras, ...extras } },
    },
  };
}
/** 被盖住主题的并集（布局真算出来的那几个）。 */
function union(page: Page, ids: string[]) {
  const boxes = computeLayout(page).boxes;
  const bs = ids.map((i) => boxes[i]).filter(Boolean);
  return {
    x0: Math.min(...bs.map((b) => b.x - b.w / 2)),
    y0: Math.min(...bs.map((b) => b.y - b.h / 2)),
    x1: Math.max(...bs.map((b) => b.x + b.w / 2)),
    y1: Math.max(...bs.map((b) => b.y + b.h / 2)),
    boxes: bs.length,
  };
}
const pick = (ov: OverlayPaint[], kind: OverlayPaint["kind"]) => ov.filter((o) => o.kind === kind);

// ---------------------------------------------------------------- 真亿图模板页

if (!existsSync(TEMPLATE)) {
  skip("模板页：外框与概要", `找不到夹具 ${TEMPLATE}`);
} else {
  const parsed = (await parseEmmx(new Uint8Array(readFileSync(TEMPLATE)))).doc;
  const page = parsed.pages[0];

  eq(
    "外框记住的是主题 id，不是下标",
    page.shapes["121"].extras.covered?.join(";"),
    "104;111;113;115;128;130"
  );
  eq(
    "概要大括号也走 BoundaryData",
    page.shapes["126"].extras.covered?.join(";"),
    "102;110;106;124;108"
  );
  eq("概要主题挂在括号下面（SubLevel）", page.shapes["126"].childIds.join(","), "127");

  const layout = computeLayout(page);
  ok("这四个形状本来就不在主题树里", !layout.boxes["121"] && !layout.boxes["126"]);

  const ov = overlayShapes(page, layout.boxes);
  const bd = pick(ov, "boundary")[0];
  eq("模板页里画出一个外框", pick(ov, "boundary").length, 1);
  const u = union(page, page.shapes["121"].extras.covered!);
  near("外框左边 = 成员并集左边 - 留白", bd.x, u.x0 - PAD);
  near("外框下边 = 成员并集下边 + 留白", bd.y + bd.h, u.y1 + PAD);

  const brace = pick(ov, "brace")[0];
  ok("大括号用曲线，不是把括号退化成一条直线", /\d+(\.\d+)?\s+Q\s/.test(brace.d ?? ""), brace.d);

  const paint = paintPage(page);
  ok(
    "概要主题作为主题进了 paint.boxes（于是它可点、可编辑）",
    paint.boxes.some((b) => b.id === "127")
  );
  const svg = buildSvg(page);
  ok("导出画的就是 paint 里那条括号（同一份几何）", svg.includes(brace.d ?? "—"), brace.d);
  ok("导出里有概要主题那五个字", svg.includes("Summary"));

  const back = (await parseEmmx(await writeEmmx(parsed))).doc.pages[0];
  eq(
    "写出去再读回来，外框成员一个没少",
    back.shapes["121"].extras.covered?.join(";"),
    "104;111;113;115;128;130"
  );
  eq("概要成员也保住了", back.shapes["126"].extras.covered?.length, 5);
}

// ---------------------------------------------------------------- 真用户图：标注框

if (!existsSync(DOC4)) {
  skip("doc4：标注框", `找不到样本 ${DOC4}`);
} else {
  const page = (await parseEmmx(new Uint8Array(readFileSync(DOC4)))).doc.pages[0];
  const calloutShapes = Object.values(page.shapes).filter((s) => s.type === "Callout");
  eq("实测标注框形状数", calloutShapes.length, 18);
  const hosts = Object.values(page.shapes).filter((s) => (s.extras.calloutIds?.length ?? 0) > 0);
  eq("挂得上主机的主题数（<Callout V> 真的读进来了）", hosts.length, 9);
  eq(
    "列出的标注 id 总数",
    hosts.reduce((n, s) => n + (s.extras.calloutIds?.length ?? 0), 0),
    18
  );

  const boxes = computeLayout(page).boxes;
  const bubbles = pick(overlayShapes(page, boxes), "callout");
  // 折叠掉的分支不在布局里，那些标注本轮就不该画 —— 但可见主机身上的必须一个不少。
  const expect = hosts.reduce(
    (n, s) => n + (boxes[s.id] ? s.extras.calloutIds!.filter((c) => page.shapes[c]).length : 0),
    0
  );
  eq("可见主题身上的标注全都画出来了", bubbles.length, expect);
  ok(
    "没写文字的标注按序号画小圆泡",
    bubbles.some((b) => b.lines.join("") === "1")
  );
  ok(
    "每个标注都带引导线",
    bubbles.every((b) => (b.d ?? "").startsWith("M ") && (b.d ?? "").includes(" L "))
  );
  ok("标注框几何进了导出（以前一个都没露过）", buildSvg(page).includes(bubbles[0]?.d ?? "¤"));
  const rects = Object.values(boxes).map((b) => ({
    x0: b.x - b.w / 2,
    y0: b.y - b.h / 2,
    x1: b.x + b.w / 2,
    y1: b.y + b.h / 2,
  }));
  const press = bubbles.filter((o) =>
    rects.some((r) => r.x0 < o.x + o.w && o.x < r.x1 && r.y0 < o.y + o.h && o.y < r.y1)
  );
  ok(
    `18 个真实标注没有一个压在主题框上（压了 ${press.length} 个）`,
    press.length === 0,
    JSON.stringify(press.map((p) => [p.id, p.x, p.y, p.w, p.h]))
  );
  // 标注泡走 boxes 那条路：它因此自动可点、可选中、可就地改字；
  // 引导线仍留在 overlays 里 —— 两边都少一个，屏幕上就只剩半个标注。
  const painted = paintPage(page, {});
  const inBoxes = bubbles.filter((b) => painted.boxes.some((x) => x.id === b.id));
  eq("标注泡进了 boxes（所以点得中、改得了字）", inBoxes.length, bubbles.length);
  eq(
    "引导线还在 overlays 里",
    painted.overlays.filter((o) => o.kind === "callout").length,
    bubbles.length
  );
  ok(
    "每根引导线都真的带几何",
    painted.overlays.every((o) => o.kind !== "callout" || Boolean(o.d))
  );
}

// ---------------------------------------------------------------- 合成页：跟布局走

{
  let p = createPage("覆盖层");
  for (const t of ["甲", "乙", "丙"]) p = insertChild(p, p.rootId, t).page;
  const [a, b] = p.shapes[p.rootId].childIds;
  const a1 = insertChild(p, a, "甲的子").page;
  const a1id = a1.shapes[a].childIds[0];

  let boxed = addShape(a1, {
    ...createShape("900", "Boundary", "", null),
    extras: { covered: [b, a1id] },
  });
  const u0 = union(boxed, [b, a1id]);
  const bd0 = pick(overlayShapes(boxed, computeLayout(boxed).boxes), "boundary")[0];
  near("外框按成员并集定高", bd0.y, u0.y0 - PAD);

  // 折叠掉甲：它的孩子退出布局，框必须跟着缩
  const folded = setCollapsed(boxed, a, true);
  const u1 = union(folded, [b, a1id]);
  ok("成员被折叠后并集变小了", u1.y1 - u1.y0 < u0.y1 - u0.y0, `${u1.boxes} 个成员`);
  const bd1 = pick(overlayShapes(folded, computeLayout(folded).boxes), "boundary")[0];
  near("外框跟着布局缩，不停在原地", bd1.h, u1.y1 - u1.y0 + PAD * 2);

  // 全被折叠：不画空框
  const empty = withExtras(boxed, "900", { covered: ["不存在的id"] });
  eq(
    "盖不住任何东西时不画空框",
    pick(overlayShapes(empty, computeLayout(empty).boxes), "boundary").length,
    0
  );

  // 左侧分支的大括号必须在并集左边
  let sum = addShape(boxed, {
    ...createShape("901", "Summary", "", null),
    childIds: ["902"],
    extras: { covered: [b] },
  });
  sum = addShape(sum, { ...createShape("902", "SummaryTopic", "概括", "901") });
  const sBoxes = computeLayout(sum).boxes;
  const brace = pick(overlayShapes(sum, sBoxes), "brace")[0];
  const ub = union(sum, [b]);
  const side = sBoxes[b].side;
  ok(
    side > 0 ? brace.x >= ub.x1 : brace.x + brace.w <= ub.x0 + 1,
    `大括号长在主题${side > 0 ? "右" : "左"}侧外面`,
    `brace.x=${brace.x} 并集 ${ub.x0}..${ub.x1} side=${side}`
  );
  const label = pick(overlayShapes(sum, sBoxes), "label")[0];
  ok("概要主题排在括号尖之外，不压着主题", label.x > brace.x, JSON.stringify([label.x, brace.x]));
}

{
  // 两个空标注 = 序号 1、2；有文字的用文字
  let p = createPage("标注");
  p = insertChild(p, p.rootId, "宿主").page;
  const host = p.shapes[p.rootId].childIds[0];
  p = addShape(p, { ...createShape("800", "Callout", "", null) });
  p = addShape(p, { ...createShape("801", "Callout", "说明文字", null) });
  p = withExtras(p, host, { calloutIds: ["800", "801"] });
  const ov = pick(overlayShapes(p, computeLayout(p).boxes), "callout");
  eq("两个标注都画出来", ov.length, 2);
  eq("空的用序号", ov[0].lines.join(""), "1");
  eq("有文字的按文字折行", ov[1].lines.join(""), "说明文字");
  const side = computeLayout(p).boxes[host].side;
  const right = side >= 0;
  ok(
    "标注长在主题外侧",
    right
      ? ov[0].x > computeLayout(p).boxes[host].x
      : ov[0].x + ov[0].w < computeLayout(p).boxes[host].x,
    `x=${ov[0].x} side=${side}`
  );
  // 折叠掉宿主：宿主不在布局里，它的标注也不该画
  const folded = setCollapsed(p, p.rootId, true);
  eq(
    "宿主被折叠时标注一起消失",
    pick(overlayShapes(folded, computeLayout(folded).boxes), "callout").length,
    0
  );
}

{
  // 标注要整棵子树都让开：只让开宿主那一格，就会压在它孩子的框上（真机截图里露的馅）
  let p = createPage("标注避让");
  p = insertChild(p, p.rootId, "宿主").page;
  const host = p.shapes[p.rootId].childIds[0];
  let withKid = insertChild(p, host, "孩子").page;
  const kidId = withKid.shapes[host].childIds[0];
  withKid = addShape(withKid, { ...createShape("700", "Callout", "第一条", null) });
  withKid = addShape(withKid, { ...createShape("701", "Callout", "第二条标注", null) });
  withKid = withExtras(withKid, host, { calloutIds: ["700", "701"] });
  const boxes = computeLayout(withKid).boxes;
  const subtreeBottom = Math.max(
    boxes[host].y + boxes[host].h / 2,
    boxes[kidId].y + boxes[kidId].h / 2
  );
  const ov = pick(overlayShapes(withKid, boxes), "callout");
  eq("两条标注都画出来", ov.length, 2);
  ok(
    "标注让开整棵子树，不压孩子的框",
    ov.every((o) => o.y >= subtreeBottom),
    `泡顶 ${ov.map((o) => o.y).join("/")} vs 子树底 ${subtreeBottom}`
  );
  ok(
    "两条标注横向排开，不叠在一起",
    ov[0].x + ov[0].w <= ov[1].x || ov[1].x + ov[1].w <= ov[0].x,
    JSON.stringify(ov.map((o) => [o.x, o.w]))
  );
}

// ------------------------------------------------- 造：外框/概要/标注的编辑原语

function twoKids() {
  let p = createPage("造覆盖层");
  p = insertChild(p, p.rootId, "甲").page;
  p = insertChild(p, p.rootId, "乙").page;
  const [a, b] = p.shapes[p.rootId].childIds;
  return { p, a, b };
}

{
  const { p, a, b } = twoKids();

  const one = addBoundary(p, [a]);
  ok("一个主题不盖外框（它自己就是框）", one.id === null && one.page === p);

  const r = addBoundary(p, [a, b, "查无此形"]);
  const bd = r.page.shapes[r.id ?? ""];
  ok("两个主题盖出一层外框", bd?.type === "Boundary");
  eq("陌生 id 进不了成员表", bd?.extras.covered?.join(";"), `${a};${b}`);
  eq("外框不挂父", bd?.parentId, null);
  eq("外框不进主题树", p.shapes[p.rootId].childIds.join(";"), `${a};${b}`);

  const again = addBoundary(r.page, [b, a]);
  ok("同一批主题再点一次是取消，不是叠第二层", again.id === null && !again.page.shapes[r.id ?? ""]);

  const nz = normalize(r.page);
  eq("normalize 不动外框的成员", nz.shapes[r.id ?? ""]?.extras.covered?.join(";"), `${a};${b}`);
  eq("normalize 不把外框收编成主题", nz.shapes[r.id ?? ""]?.type, "Boundary");
  eq("外框仍然不在根的孩子里", nz.shapes[nz.rootId].childIds.includes(r.id ?? ""), false);
  eq("盖了外框不多数一个主题", countTopics(r.page), countTopics(p));
  eq(
    "反查：盖住甲的层找得回来",
    layersCovering(nz, [a]).map((s) => s.id),
    [r.id]
  );
}

{
  const { p, a, b } = twoKids();
  const r = addSummary(p, [a, b], "小结");
  const sum = r.page.shapes[r.id ?? ""];
  ok("概要形状建出来了", sum?.type === "Summary");
  eq("概要盖住选中的两个主题", sum?.extras.covered?.join(";"), `${a};${b}`);
  const labelId = sum?.childIds[0] ?? "";
  eq("概要主题挂在 Summary 自己下面（亿图的 <SubLevel>）", sum?.childIds.length, 1);
  eq("概要主题认 Summary 当爹", r.page.shapes[labelId]?.parentId, r.id);
  eq(
    "概要主题的文字",
    plainText(r.page.shapes[labelId]?.text ?? { paragraphs: [], characters: [] }),
    "小结"
  );

  const nz = normalize(r.page);
  eq(
    "normalize 保住 Summary→SummaryTopic 这条边",
    nz.shapes[r.id ?? ""]?.childIds.join(";"),
    labelId
  );
  const ov = overlayShapes(nz, computeLayout(nz).boxes);
  eq("概要主题本身算一个主题", countTopics(nz), countTopics(p) + 1);
  eq("标注不多数主题", countTopics(addCallout(nz, a, "x").page), countTopics(nz));
  eq("概要画出大括号", ov.filter((o) => o.kind === "brace").length, 1);
  eq("括号尖上画出概要主题", ov.filter((o) => o.kind === "label").length, 1);

  const off = addSummary(r.page, [b, a], "小结");
  ok("同一批主题再点一次取消概要", off.id === null && !off.page.shapes[r.id ?? ""]);
  ok("概要主题跟着一起删", !off.page.shapes[labelId]);
}

{
  const { p, a, b } = twoKids();
  const r = addCallout(p, a, "备注");
  const cid = r.id ?? "";
  ok("标注形状建出来了", r.page.shapes[cid]?.type === "Callout");
  eq("宿主记下了标注", r.page.shapes[a].extras.calloutIds?.join(";"), cid);
  eq("标注自己不认父", r.page.shapes[cid]?.parentId, null);
  eq("标注不进主题树", r.page.shapes[r.page.rootId].childIds.join(";"), `${a};${b}`);

  const nz = normalize(r.page);
  eq("normalize 之后标注还是标注", nz.shapes[cid]?.type, "Callout");
  eq("normalize 不把标注挂到根下", nz.shapes[nz.rootId].childIds.includes(cid), false);
  const boxes = computeLayout(nz).boxes;
  ok("标注不在布局的格子里", !boxes[cid]);
  eq(
    "但标注作为覆盖层画得出来",
    overlayShapes(nz, boxes).filter((o) => o.kind === "callout").length,
    1
  );

  // 亿图有的文件把宿主写在标注自己的 <Super> 上：这条边要归位到 calloutIds，不能变成一根分支
  let viaSuper = r.page;
  viaSuper = {
    ...viaSuper,
    shapes: { ...viaSuper.shapes, [cid]: { ...viaSuper.shapes[cid], parentId: b } },
  };
  const nz2 = normalize(viaSuper);
  eq("<Super> 反查回 calloutIds", nz2.shapes[b].extras.calloutIds?.join(";"), cid);
  eq("归位之后标注不再认父", nz2.shapes[cid].parentId, null);
  eq("归位之后标注不是 b 的孩子", nz2.shapes[b].childIds.includes(cid), false);

  const dropped = removeOverlay(nz, cid);
  eq("删掉标注：宿主身上的引用一起摘", dropped.shapes[a].extras.calloutIds?.length ?? 0, 0);
  ok("删掉标注：形状本身也没了", !dropped.shapes[cid]);
}

{
  // 删除主题时覆盖层要跟着收尾，否则会留下一个盖着空气的空框
  const { p, a, b } = twoKids();
  const bd = addBoundary(p, [a, b]).page;
  const bdId = Object.keys(bd.shapes).find((k) => bd.shapes[k].type === "Boundary") ?? "";
  const afterOne = removeShape(bd, a);
  eq("删掉一个成员：外框缩到剩下的那个", afterOne.shapes[bdId]?.extras.covered?.join(";"), b);
  const afterAll = removeShape(afterOne, b);
  ok("成员删光：外框 itself 也不再留着", !afterAll.shapes[bdId]);

  const c = addCallout(p, a, "x");
  const cid = c.id ?? "";
  const gone = removeShape(c.page, a);
  ok("删掉宿主：它身上的标注一起删", !gone.shapes[cid]);

  // 陌生文件里 covered 本来就空的层不是我们造的，不能被无关的删除牵连
  let odd = addBoundary(p, [a, b]).page;
  const oddId = Object.keys(odd.shapes).find((k) => odd.shapes[k].type === "Boundary") ?? "";
  odd = {
    ...odd,
    shapes: { ...odd.shapes, [oddId]: { ...odd.shapes[oddId], extras: { covered: [] } } },
  };
  const untouched = removeShape(odd, a);
  ok("空成员的外框原样留着（等写回时按陌生数据带回）", Boolean(untouched.shapes[oddId]));
}

{
  // 造出来的东西必须能写回 .emmx 再读回来 —— 否则用户点完按钮只是看见一个假象
  const { p, a, b } = twoKids();
  let page = addBoundary(p, [a, b]).page;
  page = addSummary(page, [a], "要点").page;
  page = addCallout(page, b, "注").page;
  const doc: DocumentModel = { ...createDocument("覆盖层往返"), pages: [page] };
  const back = (await parseEmmx(await writeEmmx(doc))).doc.pages[0];
  const kindOf = (t: string) => Object.values(back.shapes).find((s) => s.type === t);
  ok("外框写回去还在", Boolean(kindOf("Boundary")));
  eq("外框的成员还在", kindOf("Boundary")?.extras.covered?.join(";"), `${a};${b}`);
  ok("概要写回去还在", Boolean(kindOf("Summary")));
  eq("概要盖住的还是那一个", kindOf("Summary")?.extras.covered?.join(";"), a);
  ok("概要主题作为 SummaryTopic 回来了", Boolean(kindOf("SummaryTopic")));
  eq(
    "概要主题还挂在 Summary 下面",
    kindOf("Summary")?.childIds.join(";"),
    kindOf("SummaryTopic")?.id
  );
  const host = back.shapes[b];
  eq("标注的宿主关系回来了", host?.extras.calloutIds?.length, 1);
  eq(
    "标注的文字回来了",
    plainText(back.shapes[host.extras.calloutIds![0]]?.text ?? { paragraphs: [], characters: [] }),
    "注"
  );
  eq("往返之后标注没有变成主题", back.shapes[host.extras.calloutIds![0]]?.type, "Callout");
}

done();

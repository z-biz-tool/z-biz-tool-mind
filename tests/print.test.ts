/**
 * 打印（doc/复刻方案/00 §3.11）。
 *
 * 这一层的价值全在"纸装不装得下、装不下的那些怎么办"这两个问题上，所以断言都盯着数字：
 * 1) 24 种纸型（清单要求 ≥22）+ 横纵向 + 页边距都要落到 @page 上；
 * 2) 五种缩放模式各自的页数与缩放必须算得出来、且网格一定盖住内容 —— 唯独 center 不盖，
 *    而它超出纸张的主题数必须被数出来（悄悄少打一半是最坏的打印 bug）；
 * 3) 范围与打印边界是筛选不是重算：幸存的连线两头都得在（P-2），
 *    一页纸上打的框数与 paint 给的框数必须一个不多一个不少；
 * 4) 份数 = 整组页面重复几遍，不是打印机驱动里的那个数字。
 */
import { done, eq, near, ok } from "./_harness.ts";
import { createPage } from "../src/model/factory.ts";
import { insertChild, updateText } from "../src/engine/tree.ts";
import { buildSvg, paintPage } from "../src/engine/export/svg.ts";
import {
  MAX_PRINT_SCALE,
  MM_TO_PX,
  PAPERS,
  SCALE_MODES,
  RANGES,
  buildPrintHtml,
  filterPaint,
  paperOf,
  paperSizeOf,
  printJobOf,
  printPlanOf,
  printSvgsOf,
} from "../src/engine/export/print.ts";
import type { Page } from "../src/types/model.ts";

let cur: Page = createPage("打印");
cur = updateText(cur, cur.rootId, "打印文档");
function add(parentId: string, text: string): string {
  const r = insertChild(cur, parentId, text);
  cur = r.page;
  return r.id;
}

const dev = add(cur.rootId, "开发");
const login = add(dev, "登录联调");
add(dev, "报表导出");
const qa = add(cur.rootId, "测试");
add(qa, "两轮回归");
add(cur.rootId, "设计");
const page = cur;

/** 一份完整 paint，用来做纯几何断言。 */
const paint = paintPage(page, { displayLevel: 9 });

// ---------------------------------------------------------------- 纸型表
{
  eq("纸型不少于清单要求的 22 种", PAPERS.length >= 22, true);
  eq("实际给出的纸型数", PAPERS.length, 24);
  eq("纸型 id 不重复", new Set(PAPERS.map((p) => p.id)).size, PAPERS.length);
  eq(
    "除自动尺寸外都有正的毫米数",
    PAPERS.every((p) => (p.id === "auto" ? p.wMm === 0 : p.wMm > 0 && p.hMm > 0)),
    true
  );
  eq("未知纸型兜到 A4", paperOf("nope").id, "a4");
  eq("A4 纵向", paperSizeOf("a4", false), { w: 210, h: 297 });
  eq("A4 横向就是两个数换过来", paperSizeOf("a4", true), { w: 297, h: 210 });
  eq("自动尺寸没有固定纸张", paperSizeOf("auto", true), { w: 0, h: 0 });
  eq("毫米到 CSS 像素", Math.round(MM_TO_PX * 25.4), 96);
  eq("五种缩放模式与界面对应", SCALE_MODES.length, 5);
  eq("四种打印范围与界面对应", RANGES.length, 4);
}

// ---------------------------------------------------------------- 单页适应
{
  const plan = printPlanOf(paint, { paperId: "a4", landscape: true, marginMm: 10 });
  const boxW = (297 - 20) * MM_TO_PX;
  const boxH = (210 - 20) * MM_TO_PX;
  eq("可打印区宽（px）", Math.round(plan.boxPx.w), Math.round(boxW));
  eq("可打印区高（px）", Math.round(plan.boxPx.h), Math.round(boxH));
  eq("只有一页", plan.views.length, 1);
  eq("纸张横向", plan.paperMm, { w: 297, h: 210 });
  const v = plan.views[0];
  near("视口宽 = 纸张区 / 缩放", v.w * plan.scale, plan.boxPx.w, 0.02);
  near("视口高 = 纸张区 / 缩放", v.h * plan.scale, plan.boxPx.h, 0.02);
  ok("缩放在内容两个方向都装得下", v.w >= paint.width - 0.01 && v.h >= paint.height - 0.01);
  eq("没有主题落在纸外", plan.outside, 0);
  const s = Math.min(boxW / paint.width, boxH / paint.height);
  eq("缩放就是适应值", plan.scale, s);
}

// ---------------------------------------------------------------- 适应上限
{
  // 纸上几乎没东西时不能一路放大到 20 张纸
  const tiny = printPlanOf(
    { ...paint, width: 40, height: 30 },
    { paperId: "a3", landscape: true, marginMm: 5 }
  );
  eq("放大封顶 4 倍", tiny.scale, MAX_PRINT_SCALE);
  eq("封顶之后仍然是一页", tiny.views.length, 1);
}

// ---------------------------------------------------------------- 多页网格
{
  const plan = printPlanOf(paint, {
    paperId: "a4",
    landscape: true,
    mode: "fitMulti",
    gridCols: 2,
    gridRows: 1,
  });
  eq("网格 2×1 就是两页", plan.views.length, 2);
  eq("行列记在计划里", plan.grid, { cols: 2, rows: 1 });
  const coverW = plan.views[0].w * 2;
  const coverH = plan.views[0].h;
  ok("网格盖住了整张图", coverW >= paint.width - 0.01 && coverH >= paint.height - 0.01);
  const boxW = (297 - 20) * MM_TO_PX;
  const boxH = (210 - 20) * MM_TO_PX;
  near(
    "缩放取这个网格下的最大",
    plan.scale,
    Math.round(Math.min((boxW * 2) / paint.width, boxH / paint.height) * 1000) / 1000,
    0.002
  );
  eq("整组居中：两页首尾相接", plan.views[1].x, plan.views[0].x + plan.views[0].w);
  eq("没有主题落在纸外", plan.outside, 0);
}

// ---------------------------------------------------------------- 适应宽度：纵向续页
{
  const plan = printPlanOf(paint, { paperId: "a4", landscape: false, mode: "fitWidth" });
  eq("横向只有一页", plan.grid.cols, 1);
  const boxH = (297 - 20) * MM_TO_PX;
  eq(
    "页数 = 内容高 / 单页可容高",
    plan.views.length,
    Math.ceil(paint.height / (boxH / plan.scale))
  );
  ok("宽度正好撑满纸面", Math.abs(plan.views[0].w * plan.scale - (210 - 20) * MM_TO_PX) < 0.02);
  eq("第二页在第一页下面", plan.views.length > 1 ? plan.views[1].y > plan.views[0].y : true, true);
  eq("没有主题落在纸外", plan.outside, 0);
}

// ---------------------------------------------------------------- 精准打印：100% 分页
{
  const plan = printPlanOf(paint, {
    paperId: "a6",
    landscape: false,
    mode: "exact",
    scalePct: 100,
  });
  eq("真实尺寸就是 1 倍", plan.scale, 1);
  const boxW = (105 - 20) * MM_TO_PX;
  const boxH = (148 - 20) * MM_TO_PX;
  eq("横页数", plan.grid.cols, Math.max(1, Math.ceil(paint.width / boxW)));
  eq("纵页数", plan.grid.rows, Math.max(1, Math.ceil(paint.height / boxH)));
  eq("总页数 = 行列相乘", plan.views.length, plan.grid.cols * plan.grid.rows);
  eq("每个视口就是一张纸的可打印区", plan.views[0].w, boxW);
  eq("没有主题落在纸外", plan.outside, 0);

  const half = printPlanOf(paint, { paperId: "a6", mode: "exact", scalePct: 50 });
  eq("缩到 50% 页数就少", half.views.length <= plan.views.length, true);
  eq("缩放记在视口上", half.views[0].scale, 0.5);
}

// ---------------------------------------------------------------- 居中打印：装不下要数出来
{
  // A6 的纸面中心只够容下中心主题：这张图 504px 宽，横向必然有框落在纸外。
  const plan = printPlanOf(paint, {
    paperId: "a6",
    landscape: false,
    marginMm: 40,
    mode: "center",
    scalePct: 100,
  });
  eq("只出一页", plan.views.length, 1);
  eq("不缩放", plan.scale, 1);
  const box = (105 - 80) * MM_TO_PX;
  ok("视口宽就是纸张可打印区", Math.abs(plan.views[0].w - box) < 0.02);
  ok("有主题落在纸外", plan.outside > 0, `实际 ${plan.outside}`);
  eq(
    "落在纸外的数量能被数出来",
    plan.outside,
    paint.boxes.filter((b) => {
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      const v = plan.views[0];
      return cx < v.x || cx > v.x + v.w || cy < v.y || cy > v.y + v.h;
    }).length
  );
  ok(
    "居中的证据：内容中心与页面中心对齐",
    Math.abs(plan.views[0].x + plan.views[0].w / 2 - (paint.minX + paint.width / 2)) < 0.02
  );
}

// ---------------------------------------------------------------- 自动尺寸
{
  const plan = printPlanOf(paint, { paperId: "auto" });
  eq("自动尺寸就是一页", plan.views.length, 1);
  eq("自动尺寸没有页边距", plan.marginMm, 0);
  eq("纸张 = 内容尺寸", Math.round(plan.paperMm.w), Math.round(paint.width / MM_TO_PX));
  eq("缩放 100%", plan.scale, 1);
  eq("视口等于内容外框", [plan.views[0].x, plan.views[0].y], [paint.minX, paint.minY]);
}

// ---------------------------------------------------------------- 坏参数不能算出 NaN
{
  const plan = printPlanOf(paint, { paperId: "a6", marginMm: 60, mode: "fitOne" });
  ok("边距吃掉整张纸也不会出负数", plan.boxPx.w >= 1 && plan.boxPx.h >= 1);
  ok("缩放不是 NaN 或 Infinity", Number.isFinite(plan.scale) && plan.scale > 0, String(plan.scale));
  ok("页数至少一页", plan.views.length >= 1);
  eq("页边距原样带出去", plan.marginMm, 60);
}

// ---------------------------------------------------------------- 份数
{
  const one = printPlanOf(paint, { paperId: "a4" });
  const three = printPlanOf(paint, { paperId: "a4", copies: 3 });
  eq("份数不改页数", three.views.length, one.views.length);
  eq("走纸张数 = 页数 × 份数", three.sheets, one.views.length * 3);
  const job = buildPrintHtml(page, { paperId: "a4", copies: 2 });
  eq(
    "文档里的 sheet 数 = 走纸张数",
    (job.html.match(/class="sheet"/g) ?? []).length,
    job.plan.sheets
  );
  eq("份数 2 就是两遍", job.plan.sheets, job.plan.views.length * 2);
}

// ---------------------------------------------------------------- 打印文档
{
  const job = buildPrintHtml(page, { paperId: "a4", landscape: true, displayLevel: 9 });
  ok(
    "@page 写的是所选纸张",
    /@page\{size:297mm 210mm;margin:10mm\}/.test(job.html),
    job.html.slice(0, 400)
  );
  ok("每张纸一页", job.html.includes("break-after:page"));
  eq("标题取根主题", job.title, "打印文档");
  eq("页面数与计划一致", (job.html.match(/<svg /g) ?? []).length, job.plan.views.length);
  eq("每张纸自带 XML 声明", (job.html.match(/<\?xml/g) ?? []).length, job.plan.views.length);

  // 最硬的一条 P-2：自动尺寸那张纸就是整图，打出来的串与 SVG 导出逐字相同。
  const whole = printJobOf(page, { paperId: "auto", displayLevel: 9 });
  eq(
    "打印页与 SVG 导出字节相同",
    printSvgsOf(whole.paint, whole.plan)[0],
    buildSvg(page, { displayLevel: 9 })
  );
  eq("同一份 paint：框数没变", whole.paint.boxes.length, paint.boxes.length);

  const expectTexts =
    paint.boxes.reduce(
      (n, b) => n + b.lines.length + (b.hiddenCount > 0 ? 1 : 0) + b.labels.length,
      0
    ) + paint.rels.filter((r) => r.text).length;
  eq(
    "文字行数 = 折行 + 折叠徽标 + 标签条",
    expectTexts,
    (printSvgsOf(whole.paint, whole.plan)[0].match(/<text /g) ?? []).length
  );
}

// ---------------------------------------------------------------- 范围：仅选中主题
{
  const job = printJobOf(page, { range: "topic", keepIds: [login], paperId: "a4" });
  eq("只剩选中的那一个框", job.paint.boxes.length, 1);
  eq("连线一根都不剩", job.paint.connectors.length, 0);
  const doc = buildPrintHtml(page, { range: "topic", keepIds: [login], paperId: "a4" });
  eq("界面显示的主题数 = 幸存框数", doc.topics, 1);
}

// ---------------------------------------------------------------- 范围：选中分支
{
  const job = printJobOf(page, { range: "branch", keepIds: [dev], paperId: "a4" });
  eq("开发连同两个子主题", job.paint.boxes.length, 3);
  const ids = new Set(job.paint.boxes.map((b) => b.id));
  ok(
    "幸存连线两头都在（不留断头线）",
    job.paint.connectors.every((c) => ids.has(c.fromId) && ids.has(c.toId))
  );
  eq("测试那一枝不在内", ids.has(qa), false);
  eq(
    "原位：每个框的坐标都还是整页上的那个数",
    job.paint.boxes.map((b) => `${b.x},${b.y}`).join("|"),
    paint.boxes
      .filter((b) => ids.has(b.id))
      .map((b) => `${b.x},${b.y}`)
      .join("|")
  );
}

// ---------------------------------------------------------------- 范围：重排
{
  const branch = printJobOf(page, { range: "branch", keepIds: [dev], paperId: "a4" });
  const subtree = printJobOf(page, { range: "subtree", keepIds: [dev], paperId: "a4" });
  eq("两种范围主题数相同", subtree.paint.boxes.length, branch.paint.boxes.length);
  const at = (p: ReturnType<typeof paintPage>, id: string) => {
    const b = p.boxes.find((x) => x.id === id);
    return b ? `${b.x},${b.y}` : "-";
  };
  ok(
    "重排真的换位置（only 走的是布局那条路）",
    subtree.paint.boxes.some((b) => at(branch.paint, b.id) !== `${b.x},${b.y}`)
  );
  eq("重排后仍然一页装下", subtree.plan.views.length, 1);
}

// ---------------------------------------------------------------- 打印边界
{
  const bounds = { x: paint.minX, y: paint.minY, w: 1, h: 1 };
  const job = printJobOf(page, { bounds, paperId: "a4" });
  eq("边界缩到一个点就什么都不剩", job.paint.boxes.length, 0);
  const big = printJobOf(page, {
    bounds: { x: paint.minX, y: paint.minY, w: paint.width, h: paint.height },
    paperId: "a4",
  });
  eq("边界给满就是全打", big.paint.boxes.length, paint.boxes.length);
  eq("边界决定纸张上的内容区", big.plan.views[0].x <= paint.minX + 0.01, true);
}

// ---------------------------------------------------------------- 筛选不重算
{
  const kept = filterPaint(paint, (id) => id === page.rootId);
  eq("只剩中心主题", kept.boxes.length, 1);
  const rootBox = paint.boxes.find((b) => b.id === page.rootId)!;
  eq(
    "框的坐标一个数都没动",
    [kept.boxes[0].x, kept.boxes[0].y, kept.boxes[0].w],
    [rootBox.x, rootBox.y, rootBox.w]
  );
  eq("外框收拢到幸存框", [kept.minX, kept.minY], [rootBox.x, rootBox.y]);
  const none = filterPaint(paint, () => false);
  eq("全裁掉时外框退回原图", [none.minX, none.width], [paint.minX, paint.width]);
  eq("全裁掉时不留下任何框", none.boxes.length, 0);
}

// ---------------------------------------------------------------- 每页 SVG 的视口
{
  const plan = printPlanOf(paint, { paperId: "a6", mode: "exact", scalePct: 100 });
  const svgs = printSvgsOf(paint, plan);
  eq("一页一张 SVG", svgs.length, plan.views.length);
  const first = /viewBox="([^"]+)"/.exec(svgs[0])?.[1];
  eq(
    "viewBox 就是那一页的内容坐标",
    first,
    `${round2(plan.views[0].x)} ${round2(plan.views[0].y)} ${round2(plan.views[0].w)} ${round2(plan.views[0].h)}`
  );
  const wh = /width="([\d.]+)" height="([\d.]+)"/.exec(svgs[0]);
  eq("width/height 是走纸像素", wh ? Number(wh[1]) : 0, Math.round(plan.boxPx.w * 100) / 100);
}

function round2(v: number): string {
  return String(Math.round(v * 100) / 100);
}

done();

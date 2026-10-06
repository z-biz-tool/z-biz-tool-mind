/**
 * 标签条：布局早就为 labels 加了高度，这里补上"看得见"的那一半，并且不许吞标签。
 * 覆盖的缺陷形状：预留带是空的（框比字高出一截却什么都没画）、屏上与导出两份坐标各算一遍、
 * 框不够宽时标签被静默丢掉（真机上第一版就是这样：填三个只画出一个）。
 */
import { done, eq, ok } from "./_harness.ts";
import { createPage } from "../src/model/factory.ts";
import { insertChild, updateExtras } from "../src/engine/tree.ts";
import {
  buildSvg,
  cornerBadgePaths,
  labelChips,
  lineGap,
  paintPage,
  textStartY,
} from "../src/engine/export/svg.ts";
import {
  badgeExtent,
  chipHeight,
  labelInsets,
  labelRows,
  labelStripHeight,
} from "../src/engine/layout.ts";

const TITLES = ["干净主题", "带标签的主题", "标签加角标", "标签很多", "只有一条长标签"];

let page = createPage("标签");
for (const t of TITLES) page = insertChild(page, page.rootId, t).page;
const [clean, plain, withBadge, many, lone] = page.shapes[page.rootId].childIds;
page = updateExtras(page, plain, { labels: ["原型", "待评审", "已评审"] });
page = updateExtras(page, withBadge, {
  note: "备注",
  hyperlink: { kind: "web", target: "https://example.com" },
  labels: ["A"],
});
page = updateExtras(page, many, { labels: ["原型", "待评审", "已评审", "二轮", "定稿", "归档"] });
page = updateExtras(page, lone, { labels: ["这一条标签长得足够把框撑开"] });

// 同一批文字、只有 labels 差别的对照页：框宽的差、框高的差才归得清是谁造成的。
let bare = createPage("标签");
for (const t of TITLES) bare = insertChild(bare, bare.rootId, t).page;

const box = (p: typeof page, id: string) => paintPage(p).boxes.find((x) => x.id === id)!;
const rowsOf = (chips: { y: number }[]) => new Set(chips.map((c) => c.y)).size;

eq("没有标签就没有标签条", labelChips(box(page, page.rootId)).length, 0);
eq("没挂过 extras 的主题不带标签位", labelChips(box(page, clean)).length, 0);
eq(
  "paint 的标签位与 extras 同源（P-1）",
  box(page, plain).labels.join(";"),
  ["原型", "待评审", "已评审"].join(";")
);

const bPlain = box(page, plain);
const chips = labelChips(bPlain);
eq("三个标签画三条，一条不丢", chips.length, 3);
ok("第一条写的是第一个标签", chips[0].text === "原型", chips[0].text);
const sameRow = chips.filter((c) => c.y === chips[0].y);
ok(
  "同一行里从左到右排，彼此不叠",
  sameRow.every((c, i) => i === 0 || c.x > sameRow[i - 1].x + sameRow[i - 1].w),
  JSON.stringify(sameRow)
);

const bBadge = box(page, withBadge);
const badgeed = labelChips(bBadge);
eq("带角标的主题也画标签", badgeed.length, 1);
ok(
  "标签从角标右边开始，两者不叠",
  badgeed[0].x >= bBadge.x + badgeExtent(bBadge),
  `${badgeed[0].x} vs ${bBadge.x + badgeExtent(bBadge)}`
);
ok("角标还是那两条", cornerBadgePaths(bBadge).length, 2);

// 真正会被吞的那条路径：窄框 + 多标签。必须换行，一条都不能少。
const bMany = box(page, many);
const manyChips = labelChips(bMany);
eq("六个标签一条都不许丢", manyChips.length, 6);
ok("放不下就换行", rowsOf(manyChips) > 1, `rows=${rowsOf(manyChips)}`);
ok(
  "每一行都在框里",
  manyChips.every(
    (c) =>
      c.x >= bMany.x &&
      c.x + c.w <= bMany.x + bMany.w + 0.01 &&
      c.y >= bMany.y &&
      c.y + c.h <= bMany.y + bMany.h + 0.01
  ),
  JSON.stringify(manyChips[manyChips.length - 1])
);
const ys = [...new Set(manyChips.map((c) => c.y))].sort((a, b) => a - b);
ok(
  "行与行之间不叠",
  ys.every((y, i) => i === 0 || y >= ys[i - 1] + chipHeight(bMany.fontSize)),
  JSON.stringify(ys)
);

// 正文必须在标签条之上：整框居中的话，标签一换行字就压到标签上（真机截图里正是这样）。
const textBottom =
  textStartY(bMany) + (bMany.lines.length - 1) * lineGap(bMany.fontSize) + bMany.fontSize * 0.25;
ok(
  "正文不压标签",
  textBottom <= Math.min(...manyChips.map((c) => c.y)),
  `text≈${Math.round(textBottom)} chipsTop=${Math.min(...manyChips.map((c) => c.y))}`
);
ok(
  "正文也没顶出框",
  textStartY(bMany) - bMany.fontSize >= bMany.y,
  `textTop≈${Math.round(textStartY(bMany) - bMany.fontSize)} boxTop=${bMany.y}`
);

// 布局预留的高必须正好等于绘制排出的行数所需的高：一边按 1 行留、一边画 2 行就是压到框外。
const rowsPainted = labelRows(
  bMany.labels,
  bMany.fontSize,
  bMany.w,
  labelInsets({ note: bMany.note, link: bMany.link, hideRight: bMany.hiddenCount > 0 })
).length;
eq("绘制排出的行数与 paint 的框宽自洽", rowsPainted, rowsOf(manyChips));
eq(
  "布局为标签预留的高 = 行数的实际需要",
  bMany.h - box(bare, many).h,
  labelStripHeight(rowsOf(manyChips), bMany.fontSize)
);

const bLone = box(page, lone);
ok("单条长标签把框撑宽", bLone.w > box(bare, lone).w, `${bLone.w} vs ${box(bare, lone).w}`);
eq("长标签仍然只有一条", labelChips(bLone).length, 1);

// 屏与导出共用同一份几何：buildSvg 里出现的矩形坐标就是 labelChips 算出来的那个。
const svg = buildSvg(page);
ok("导出的 SVG 里有标签文字", svg.includes("待评审"));
ok("导出的 SVG 里有标签框", /<rect[^>]*rx="2"/.test(svg), svg.slice(0, 80));
ok(
  "SVG 里的矩形坐标与 labelChips 同源",
  svg.includes(`x="${chips[0].x}" y="${chips[0].y}"`),
  `chip=${chips[0].x},${chips[0].y}`
);

done();

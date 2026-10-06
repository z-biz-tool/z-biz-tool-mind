/**
 * 标签条：布局早就为 labels 加了高度，这里补上"看得见"的那一半。
 * 覆盖的缺陷形状：预留带是空的（框比字高出一截却什么都没画）、屏上与导出两份坐标各算一遍、
 * 放不下的标签溢出到框外。
 */
import { done, eq, ok } from "./_harness.ts";
import { createPage } from "../src/model/factory.ts";
import { insertChild, updateExtras } from "../src/engine/tree.ts";
import {
  badgeExtent,
  buildSvg,
  cornerBadgePaths,
  labelChips,
  paintPage,
} from "../src/engine/export/svg.ts";

const T = ["原型", "待评审", "已评审"];
const TITLES = ["干净主题", "带标签的主题文字足够长", "标签加角标", "标签挤不下"];

let page = createPage("标签");
for (const t of TITLES) page = insertChild(page, page.rootId, t).page;
const [clean, plain, withBadge, crowded] = page.shapes[page.rootId].childIds;
page = updateExtras(page, plain, { labels: T });
page = updateExtras(page, withBadge, {
  note: "备注",
  hyperlink: { kind: "web", target: "https://example.com" },
  labels: ["A"],
});

// 同一份文字、只有 labels 差别的对照页：证明多出来的高度确实是标签预留带而不是别的什么。
let bare = createPage("标签");
for (const t of TITLES) bare = insertChild(bare, bare.rootId, t).page;

const box = (p: typeof page, id: string) => paintPage(p).boxes.find((x) => x.id === id)!;
const root = box(page, page.rootId);

eq("没有标签就没有标签条", labelChips(root).length, 0);
eq("没挂过 extras 的主题不带标签位", labelChips(box(page, clean)).length, 0);
eq("paint 的标签位与 extras 同源（P-1）", box(page, plain).labels.join(";"), T.join(";"));

const chips = labelChips(box(page, plain));
eq("三个标签画三条", chips.length, 3);
ok("第一条写的是第一个标签", chips[0].text === "原型", chips[0].text);

const bPlain = box(page, plain);
for (const c of chips) {
  ok(
    "标签不出框",
    c.x >= bPlain.x && c.x + c.w <= bPlain.x + bPlain.w + 0.01,
    `${c.text} ${c.x}+${c.w} vs ${bPlain.x}..${bPlain.x + bPlain.w}`
  );
  ok("标签不越过底边", c.y + c.h <= bPlain.y + bPlain.h + 0.01, `${c.text} ${c.y}+${c.h}`);
}
ok(
  "从左到右排，彼此不叠",
  chips.every((c, i) => i === 0 || c.x > chips[i - 1].x + chips[i - 1].w)
);

const bBare = box(bare, plain);
ok("有标签的框比没标签的高出预留带", bPlain.h > bBare.h, `${bPlain.h} vs ${bBare.h}`);
ok(
  "预留带确实容得下标签条",
  bPlain.h - bBare.h >= chips[0].h,
  `${bPlain.h - bBare.h} vs ${chips[0].h}`
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

const crowdedBox = (() => {
  let p = updateExtras(page, crowded, { labels: ["中长的", "这个标签特别长，根本放不下"] });
  return box(p, crowded);
})();
const crowdedChips = labelChips(crowdedBox);
ok(
  "挤不下的标签宁可不画",
  crowdedChips.length < crowdedBox.labels.length,
  `${crowdedChips.length}/${crowdedBox.labels.length}`
);
ok(
  "画出来的每一个都在框里",
  crowdedChips.every((c) => c.x + c.w <= crowdedBox.x + crowdedBox.w + 0.01)
);

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

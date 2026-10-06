/**
 * 主题角标（备注 / 超链接）：布局早就为它们留了地方，这里补上"看得见"的那一半。
 * 覆盖的缺陷形状：extras 里有备注但画布与导出上没有任何标记；两份坐标各算一遍。
 */
import { done, eq, ok } from "./_harness.ts";
import { createPage } from "../src/model/factory.ts";
import { insertChild, updateExtras } from "../src/engine/tree.ts";
import { cornerBadgePaths, paintPage } from "../src/engine/export/svg.ts";

let page = createPage("角标");
for (const t of ["带备注", "带链接", "两个都有"]) page = insertChild(page, page.rootId, t).page;
const [a, b, c] = page.shapes[page.rootId].childIds;
page = updateExtras(page, a, { note: "第一段备注" });
page = updateExtras(page, b, { hyperlink: { kind: "web", target: "https://example.com" } });
page = updateExtras(page, c, { note: "备注", hyperlink: { kind: "topic", target: a } });

const box = (id: string) => paintPage(page).boxes.find((x) => x.id === id)!;
const root = box(page.rootId);

eq("没写备注的主题不带备注位", root.note, false);
eq("没挂链接的主题不带链接位", root.link, false);
eq("什么都没有就没有角标", cornerBadgePaths(root).length, 0);
eq("备注只点亮备注那一位", [box(a).note, box(a).link].join(), [true, false].join());
eq("超链接只点亮链接那一位", [box(b).note, box(b).link].join(), [false, true].join());
eq("两个都有就出两条 path", cornerBadgePaths(box(c)).length, 2);
ok("备注角标画的是那页折角纸", cornerBadgePaths(box(a))[0].includes("h-8 z"));
ok("链接角标画的是那支斜箭头", cornerBadgePaths(box(b))[0].includes("l6 -6"));
eq("paint 的角标位与 extras 同源（P-1）", box(c).note, Boolean(page.shapes[c].extras.note));

done();

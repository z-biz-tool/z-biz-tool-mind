/**
 * 主题推导：颜色 / 字号 / 效果（doc/复刻方案/00 §3.5，P-1 "换主题只改样式，树不动"）。
 *
 * 覆盖的缺陷形状：
 * 1) 十六进制的三种写法（#rgb / #rrggbb / #aarrggbb）与非法输入都必须有确定结果；
 * 2) Shade/Tint 是相对 Ref 推导（实测 theme.xml 的 ShapeFormat 全用这条），0/100/越界/NaN 都要钳住；
 * 3) ColorValue 四元组的优先级：Shade > Tint > V，且 V 的 alpha 段要剥掉；
 * 4) 常量必须与真实 .emmx 的 theme.xml 逐字对齐（主色顺序、8 档字号、Rounding/LineWeight）；
 * 5) styleFor：层级 → 色/字号/字重/字色，分支 → 主色轮转，用户覆盖优先；
 * 6) applyPalette：mask bit0 独立配色不动、幂等、树结构不动、paint 与落地值一致；
 * 7) contrastText 的深底白字阈值。
 */
import { done, eq } from "./_harness.ts";
import { existsSync, readFileSync } from "node:fs";
import { createPage } from "../src/model/factory.ts";
import { insertChild, updateStyle } from "../src/engine/tree.ts";
import { ANGEL_ACCENTS, DEFAULTS } from "../src/model/constants.ts";
import {
  accentAt,
  applyPalette,
  contrastText,
  defaultPalette,
  EDRAW_FONT_FAMILY,
  EDRAW_FONT_SIZES,
  mix,
  parseHex,
  resolveColor,
  shade,
  styleFor,
  tint,
  toHex,
} from "../src/engine/style.ts";
import { skip } from "./_harness.ts";

const A1 = "#5e84ff";
const S0 = "#000000";
const W = "#ffffff";

// ---------------------------------------------------------------- 十六进制
{
  eq("六位带 #", parseHex(A1), { r: 94, g: 132, b: 255 });
  eq("六位不带 # 与大小写/空格都等价", [parseHex("5e84ff"), parseHex(" #5E84FF ")], [parseHex(A1), parseHex(A1)]);
  eq("三位缩写展开", parseHex("#5ef"), { r: 85, g: 238, b: 255 });
  eq("八位 #aarrggbb 剥 alpha", parseHex("#33f5f6ff"), { r: 245, g: 246, b: 255 });
  eq("位数不对或含非法字符 = undefined", [parseHex("#12345"), parseHex("#1234567"), parseHex(""), parseHex("#gggggg")], [undefined, undefined, undefined, undefined]);
  eq("toHex 往返 + 越界钳制 + 四舍五入", [toHex(parseHex(A1)!), toHex({ r: 300, g: -20, b: 229.5 })], [A1, "#ff00e6"]);
}

// ---------------------------------------------------------------- shade / tint / mix
{
  eq("0% 都是原色", [shade(A1, 0), tint(A1, 0)], [A1, A1]);
  eq("100% 分别到黑与白", [shade(A1, 100), tint(A1, 100)], [S0, W]);
  eq("shade 向黑线性", shade(W, 50), "#808080");
  eq("tint 向白线性（实测三级用的 35/60/78 档）", [tint(A1, 35), tint(A1, 60), tint(A1, 78)], ["#96afff", "#bfceff", "#dce4ff"]);
  eq("负百分比钳到 0", shade(A1, -50), A1);
  eq("超过 100 钳到 100", tint(A1, 500), W);
  eq("NaN 当 0（绝不把 NaN 写进颜色）", shade(A1, Number.NaN), A1);
  eq("非法颜色原样返回（不炸渲染路径）", shade("#zzzzzz", 50), "#zzzzzz");
  eq("mix 中点", mix(S0, W, 0.5), "#808080");
  eq("mix 两端与 t 钳位", [mix(S0, W, 0), mix(S0, W, 1), mix(S0, W, 5)], [S0, W, W]);
  eq("mix 任一侧非法返回 a", mix("#zzz", W), "#zzz");
}

// ---------------------------------------------------------------- resolveColor：四元组优先级
{
  eq("没给颜色 = undefined", resolveColor(), undefined);
  eq("只有 V 直接用 V，#aarrggbb 剥掉 alpha", [resolveColor({ v: "#abcdef" }), resolveColor({ v: "#ffffffff" })], ["#abcdef", W]);
  eq("Shade 以 Ref 为基准推导", resolveColor({ v: W, shade: 50, ref: W }), "#808080");
  eq("Shade 缺 Ref 退回 V", resolveColor({ v: "#6580ff", shade: 50 }), "#334080");
  eq("shade=0 视为未给", resolveColor({ v: "#abcdef", shade: 0 }), "#abcdef");
  eq("Shade 与 Tint 同时给时 Shade 优先", resolveColor({ v: "#abcdef", tint: 20, shade: 50 }), "#566778");
  // 引擎缺陷：ColorValue.themeColor（实测 .emmx 的主色槽绑定，codec 还把它抄进 style.colorRef）在解析链里从未被读，
  // 而这类节点的 V 往往是占位的 #ffffffff —— 所有绑定主题槽的形状都掉成白色
  eq("绑定主题槽位要解析到对应 Accent", resolveColor({ v: W, themeColor: 1 }), ANGEL_ACCENTS[0]);
}

// ---------------------------------------------------------------- 常量对齐真实 .emmx 的 theme.xml
{
  const file = "_research/extract/doc1/theme.xml.txt";
  if (!existsSync(file)) {
    skip("theme.xml 实测对齐", "找不到 _research 解包样本");
  } else {
    const xml = readFileSync(file, "utf8");
    const found: Record<number, string> = {};
    for (const m of xml.matchAll(/Accent(\d+)="(#[0-9a-fA-F]{6})"/g)) found[Number(m[1])] = m[2].toLowerCase();
    eq("Angel 十个主色按 Accent1..10 排序 == ANGEL_ACCENTS（原文顺序是打乱的）", Array.from({ length: 10 }, (_, i) => found[i + 1]), ANGEL_ACCENTS);
    const sizes = [...xml.matchAll(/<FontScheme FontName="[^"]+" FontSize="(\d+)"/g)].map((m) => Number(m[1]));
    eq("8 档字号逐字 == EDRAW_FONT_SIZES", sizes, EDRAW_FONT_SIZES);
    eq("第 5 档字号回到 11（不是单调递减）", [EDRAW_FONT_SIZES.length, EDRAW_FONT_SIZES[4]], [8, 11]);
    eq("文字主题名 == EDRAW_FONT_FAMILY", /<ThemeText Name="([^"]+)"/.exec(xml)?.[1], EDRAW_FONT_FAMILY);
    eq("实测 Rounding=4 / LineWeight=1 已写进 DEFAULTS", [/Rounding V="4"/.test(xml) ? DEFAULTS.rounding : -1, DEFAULTS.lineWeight], [4, 1]);
  }
  const pal = defaultPalette();
  pal.accents[0] = "#000000";
  pal.fontSizes.push(99);
  eq("defaultPalette 给的是副本（改它不污染常量）", [ANGEL_ACCENTS[0], EDRAW_FONT_SIZES.length], [A1, 8]);
  eq("accentAt 越界轮转", [accentAt(defaultPalette(), 0), accentAt(defaultPalette(), 9), accentAt(defaultPalette(), 10)], [A1, "#4dc7bc", A1]);
  eq("空色板回退 Angel", accentAt({ accents: [], fontSizes: [], fontFamily: "" }, 3), ANGEL_ACCENTS[3]);
}

// ---------------------------------------------------------------- styleFor：层级与分支推导
{
  let pg = createPage("样式");
  const ks: string[] = [];
  for (let i = 0; i < 6; i++) {
    const r = insertChild(pg, pg.rootId, `分支${i + 1}`);
    pg = r.page;
    ks.push(r.id);
  }
  // 在第一个分支下串 8 层：level 2..9
  const ids: string[] = [];
  for (let i = 0; i < 8; i++) {
    const r = insertChild(pg, ids[i - 1] ?? ks[0], `L${i + 2}`);
    pg = r.page;
    ids.push(r.id);
  }
  const pal = defaultPalette();
  const root = styleFor(pg, pg.shapes[pg.rootId], pal);
  // 引擎缺陷：branchIndex(中心主题) 返回 -1，accentAt 把 -1 取模成"最后一格"，
  // 中心主题于是拿 Accent10(#4dc7bc) 推导，而不是主色 Accent1
  eq("中心主题应由 Accent1 推导", root.fill, shade(A1, 10));
  eq("中心主题字号 14 / 白字 / 加粗", [root.font.size, root.font.color, root.font.bold], [14, W, true]);
  const l1 = styleFor(pg, pg.shapes[ks[0]], pal);
  eq("一级 = 主色本身，线色 shade25、概要色 tint78", [l1.fill, l1.line, l1.soft], [A1, shade(A1, 25), tint(A1, 78)]);
  eq("一级字号 12 / 白字 / 加粗", [l1.font.size, l1.font.color, l1.font.bold, l1.font.family], [12, W, true, EDRAW_FONT_FAMILY]);
  eq("第 2、3 主分支取 Accent2、Accent3", [styleFor(pg, pg.shapes[ks[1]], pal).fill, styleFor(pg, pg.shapes[ks[2]], pal).fill], ["#5c9dff", "#cc7eb0"]);
  const l2 = styleFor(pg, pg.shapes[ids[0]], pal);
  eq("二级 = tint 35，字色转深、不加粗", [l2.fill, l2.font.color, l2.font.bold], [tint(A1, 35), DEFAULTS.textColor, false]);
  eq("三级 = tint 60", styleFor(pg, pg.shapes[ids[1]], pal).fill, tint(A1, 60));
  eq("四级及更深仍是 tint 60", styleFor(pg, pg.shapes[ids[7]], pal).fill, tint(A1, 60));
  eq("第 5 档字号（level 4）回到 11（照抄实测档位）", styleFor(pg, pg.shapes[ids[2]], pal).font.size, 11);
  eq("字号档位在第 8 档封顶", styleFor(pg, pg.shapes[ids[7]], pal).font.size, 10);
  eq("线宽/圆角取实测默认", [l1.lineWidth, l1.rounding], [DEFAULTS.lineWeight, DEFAULTS.rounding]);
  const styled = updateStyle(pg, ks[1], { fill: { type: "Solid", color: { v: "#ff0000" } }, font: { size: 20, italic: true } });
  const over = styleFor(styled, styled.shapes[ks[1]], pal);
  eq("用户填充覆盖推导色", over.fill, "#ff0000");
  eq("用户字体只覆盖给定字段", [over.font.size, over.font.italic, over.font.family, over.font.color], [20, true, EDRAW_FONT_FAMILY, W]);
  const lined = updateStyle(pg, ks[1], { line: { weight: 3, rounding: 8, fill: { type: "Solid", color: { v: "#0f0f0f", shade: 50 } } } });
  const ln = styleFor(lined, lined.shapes[ks[1]], pal);
  eq("用户线色/线宽/圆角生效", [ln.line, ln.lineWidth, ln.rounding], [shade("#0f0f0f", 50), 3, 8]);
  const ylw = styleFor(pg, pg.shapes[ks[5]], pal);
  // 引擎缺陷：一级/中心主题的字色硬编码 "#ffffff"，没有走同模块的 contrastText ——
  // Accent6(#f8ae1a)、Accent9、Accent10 亮度已高于 0.62 阈值，白字在这些分支上看不清
  eq("浅底分支的字色应与 contrastText 一致", ylw.font.color, contrastText(ylw.fill));
}

// ---------------------------------------------------------------- applyPalette：换主题
{
  let pg = createPage("换主题");
  const ks: string[] = [];
  for (const t of ["普通", "独立配色", "渐变+虚线"]) {
    const r = insertChild(pg, pg.rootId, t);
    pg = r.page;
    ks.push(r.id);
  }
  let p = updateStyle(pg, ks[1], { mask: 1, fill: { type: "Solid", color: { v: "#00ff00" } } });
  p = updateStyle(p, ks[2], {
    fill: { type: "Gradient", angle: 90, stops: [{ pos: 0, color: { v: "#111111" } }, { pos: 1, color: { v: "#222222" } }] },
    line: { weight: 2, style: "Dashes", cap: "Round", endArrow: 5, fill: { type: "Solid", color: { v: "#333333" } } },
  });
  const pal = defaultPalette();
  const after = applyPalette(p, pal);
  eq("被推导形状落地为主色填充", after.shapes[ks[0]].style.fill?.color?.v, A1);
  eq("落地值 == paint 时算出的值（P-2 共用一支笔）", after.shapes[ks[0]].style.fill?.color?.v, styleFor(after, after.shapes[ks[0]], pal).fill);
  eq("mask bit0 的形状整体不动", after.shapes[ks[1]].style.fill?.color?.v, "#00ff00");
  eq("换主题不碰树（id 集与根不变，P-1）", [Object.keys(after.shapes).join(","), after.rootId], [Object.keys(p.shapes).join(","), p.rootId]);
  eq("再换一次是幂等的", JSON.stringify(applyPalette(after, pal).shapes), JSON.stringify(after.shapes));
  eq("自定义色板整体换色", applyPalette(p, { accents: ["#ff0000"], fontSizes: EDRAW_FONT_SIZES, fontFamily: "宋体" }).shapes[ks[0]].style.fill?.color?.v, "#ff0000");
  // 引擎缺陷：applyPalette 用新的 {weight,rounding,fill} 整体替换 line 对象、用 {type:"Solid",color} 整体替换 fill ——
  // 虚线(style)/线帽(cap)/箭头(endArrow) 与渐变的 angle+stops 全被抹掉，换一次主题就把手绘线型洗成实线纯色
  eq("换主题保留虚线线型、箭头与渐变色标", [after.shapes[ks[2]].style.line?.style, after.shapes[ks[2]].style.line?.endArrow, after.shapes[ks[2]].style.fill?.type, after.shapes[ks[2]].style.fill?.stops?.length], ["Dashes", 5, "Gradient", 2]);
}

// ---------------------------------------------------------------- contrastText
{
  eq("浅底深字 / 深底白字", [contrastText(W), contrastText(S0)], [DEFAULTS.textColor, W]);
  eq("Accent1 深蓝配白字", contrastText(A1), W);
  eq("非法底色退回正文色", contrastText("#zzzzzz"), DEFAULTS.textColor);
  eq("Angel 里恰好 3 个主色亮到要换深字", ANGEL_ACCENTS.filter((c) => contrastText(c) === DEFAULTS.textColor), ["#f8ae1a", "#f38590", "#4dc7bc"]);
}

done();

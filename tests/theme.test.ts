/**
 * 文档自带的 theme.xml → 色板（复刻方案 00 §2.5）。
 *
 * 缺陷形状（这里刻意覆盖的）：
 * 1) `ColorScheme` 的 Accent 属性在真实文件里**顺序是打乱的** —— 按出现顺序收等于把色板洗成随机色；
 * 2) 数组下标就是 `ThemeColor="N"` 的槽位号 —— 缺档必须按 Angel 同档补位，压缩会让后面全体错位；
 * 3) 认不出的色值（"auto"、#ZZZ）当作没写，不能把 NaN 送进画布；`#aarrggbb`/`#rgb` 要归一成 `#rrggbb`；
 * 4) 一套文件里有多个 `ThemeColor`/`ThemeText` 时按 page 绑的 ID 选，认不出取第一套；
 * 5) 对现有的五份亿图样本，这份解析必须是 **no-op**（逐值等于 defaultPalette），否则动它就等于改所有旧文件的颜色；
 * 6) theme.xml 整份原样带走这条往返链不能把自定义色板丢掉（写盘→重开还是那一套色）；
 * 7) 缓存按 themeRoot 的对象身份，交出去的数组必须是副本 —— 调用方写脏等于污染整份文档的颜色；
 * 8) 色板必须真走到画布与导出文件（paintPage 的盒子、buildSvg 的属性都跟着文档说的走），
 *    否则这一份只是解析出来好看 —— 实测序列化那一步原本只认死常量：颜色靠 paint 带过去了，
 *    字族却被 `<svg font-family>` 那条建栈写死，导出文件里没有文档自己的字。
 */
import { existsSync, readFileSync } from "node:fs";
import { done, eq, ok, skip } from "./_harness.ts";
import { parseXml } from "../src/engine/emmx/xparse.ts";
import { parseEmmx, writeEmmx } from "../src/engine/emmx/codec.ts";
import { docThemes, paletteForDoc, paletteOf } from "../src/engine/emmx/theme.ts";
import { ANGEL_ACCENTS } from "../src/model/constants.ts";
import {
  defaultPalette,
  EDRAW_FONT_FAMILY,
  EDRAW_FONT_SIZES,
  resolveColor,
  shade,
} from "../src/engine/style.ts";
import { activePage, createDocument, withActivePage } from "../src/model/factory.ts";
import { insertChild } from "../src/engine/tree.ts";
import { FONT_STACK, buildSvg, paintPage, fontStackOf } from "../src/engine/export/svg.ts";

/** 一份"不是 Angel"的主题：顺序故意打乱，且只写 Accent1/2/3/7（4/5/6 缺档）。 */
const CUSTOM = `<?xml version="1.0" encoding="utf-8"?>
<Themes>
  <Theme Effect="0" Name="Mine" Rainbow="0" ID="77">
    <ThemeColor Name="Custom" ID="5">
      <ColorScheme Accent3="#333333" Accent1="#111111" Accent7="#777777" Accent2="#222222"/>
    </ThemeColor>
    <ThemeColor Name="Other" ID="9">
      <ColorScheme Accent1="#aaaaaa"/>
    </ThemeColor>
    <ThemeText Name="宋体" ID="12">
      <FontSchemeLst>
        <FontScheme FontName="宋体" FontSize="20" Flag="0"/>
        <FontScheme FontName="宋体" FontSize="16" Flag="0"/>
      </FontSchemeLst>
    </ThemeText>
  </Theme>
</Themes>`;

const root = parseXml(CUSTOM);

{
  const p = paletteOf(root, 5, 12);
  eq("Accent 按序号落位（书写顺序是 3,1,7,2），缺的 4/5/6 按 Angel 同档补位", p.accents, [
    "#111111",
    "#222222",
    "#333333",
    ANGEL_ACCENTS[3],
    ANGEL_ACCENTS[4],
    ANGEL_ACCENTS[5],
    "#777777",
  ]);
  eq("文件只说 7 档就不补到 10 档：补到几档是替文件编造它没说的颜色", p.accents.length, 7);
  eq("字号档按 <FontScheme> 的文档顺序", [p.fontFamily, p.fontSizes], ["宋体", [20, 16]]);
  eq(
    "槽位号解到文档自己的 Accent3，而不是 Angel 的 #ef6653",
    resolveColor({ v: "#ffffff", themeColor: 3 }, p.accents),
    "#333333"
  );
}

{
  eq("按 ID 选第二套 ThemeColor", paletteOf(root, 9, 12).accents[0], "#aaaaaa");
  eq(
    "ID 认不出取第一套（亿图一个 Theme 下通常就一套）",
    paletteOf(root, 3, 12).accents[0],
    "#111111"
  );
  eq("没给 ID 也取第一套", paletteOf(root).accents[0], "#111111");
  eq("文字主题认不出取第一套，字号仍来自它", paletteOf(root, 5, 99), {
    accents: paletteOf(root, 5, 12).accents,
    fontSizes: [20, 16],
    fontFamily: "宋体",
  });
}

{
  const bad = parseXml(
    '<Themes><Theme><ThemeColor ID="1"><ColorScheme Accent1="#ffffff" Accent2="auto" Accent3="#ZZZZZZ" Accent4=""/></ThemeColor></Theme></Themes>'
  );
  eq("认不出的值当作没写，同档回退 Angel", paletteOf(bad, 1).accents, [
    "#ffffff",
    ANGEL_ACCENTS[1],
    ANGEL_ACCENTS[2],
    ANGEL_ACCENTS[3],
  ]);
  eq(
    "只写 Accent5 也是五档（前面按 Angel 补，不压缩成 1 档）",
    paletteOf(
      parseXml(
        '<Themes><Theme><ThemeColor ID="1"><ColorScheme Accent5="#555555"/></ThemeColor></Theme></Themes>'
      ),
      1
    ).accents,
    [...ANGEL_ACCENTS.slice(0, 4), "#555555"]
  );
  eq(
    "Accent0 是脏值：不算写过，也不占位",
    paletteOf(
      parseXml(
        '<Themes><Theme><ThemeColor ID="1"><ColorScheme Accent0="#000000" Accent1="#111111"/></ThemeColor></Theme></Themes>'
      ),
      1
    ).accents,
    ["#111111"]
  );
  const allBad = parseXml(
    '<Themes><Theme><ThemeColor ID="1"><ColorScheme Accent1="auto"/></ThemeColor></Theme></Themes>'
  );
  eq("一档都读不出就整列回退 Angel（不是空色板）", paletteOf(allBad, 1).accents, ANGEL_ACCENTS);
}

{
  const odd = parseXml(
    '<Themes><Theme><ThemeColor ID="2"><ColorScheme Accent1="#ff112233" Accent2="#abc"/></ThemeColor></Theme></Themes>'
  );
  eq("#aarrggbb 剥 alpha、#rgb 展开成 #rrggbb", paletteOf(odd, 2).accents, ["#112233", "#aabbcc"]);
}

{
  const bare = parseXml('<Themes><Theme><ThemeColor Name="Angel" ID="3"/></Theme></Themes>');
  eq("没有 ColorScheme 就退回 Angel 十档", paletteOf(bare, 3).accents, ANGEL_ACCENTS);
  const txt = parseXml(
    '<Themes><Theme><ThemeText Name="楷体" ID="8"><FontSchemeLst><FontScheme/>' +
      '<FontScheme FontSize="0"/></FontSchemeLst></ThemeText></Theme></Themes>'
  );
  eq("字号缺失/为 0 按 Angel 同档补，不压缩（压缩会让层级全体错一档）", paletteOf(txt).fontSizes, [
    EDRAW_FONT_SIZES[0],
    EDRAW_FONT_SIZES[1],
  ]);
  eq("FontScheme 没带字名就取 ThemeText 的 Name", paletteOf(txt).fontFamily, "楷体");
  eq(
    "FontScheme 自己带字名时优先用它（字主题名只是这套的标签）",
    paletteOf(
      parseXml(
        '<Themes><Theme><ThemeText Name="楷体" ID="8"><FontSchemeLst>' +
          '<FontScheme FontName="仿宋" FontSize="14"/></FontSchemeLst></ThemeText></Theme></Themes>'
      )
    ).fontFamily,
    "仿宋"
  );
  eq(
    "没有 FontSchemeLst 就整列回退 8 档实测字号",
    paletteOf(parseXml('<Themes><Theme><ThemeText Name="X" ID="1"/></Theme></Themes>')).fontSizes,
    EDRAW_FONT_SIZES
  );
}

{
  eq("没有 theme.xml（新建文档 / 别的格式导入）= 老行为", paletteOf(undefined), defaultPalette());
  eq("空 <Themes/> = 老行为", paletteOf(parseXml("<Themes/>")), defaultPalette());
}

{
  const pal = paletteOf(root, 5, 12);
  pal.accents[0] = "#000000";
  pal.fontSizes.push(99);
  eq(
    "交出去的是副本：调用方写脏不能污染整份文档的颜色",
    paletteOf(root, 5, 12).accents[0],
    "#111111"
  );
  eq("字号数组同样是副本", paletteOf(root, 5, 12).fontSizes.length, 2);
  const a = docThemes(root);
  const b = docThemes(root);
  ok("解析结果按 themeRoot 的对象身份缓存（每帧问一次不该重解一遍 XML）", a === b);
  ok(
    "同一份内容重新解析是另一个对象 ⇒ 重新解一遍，不会读到旧值",
    docThemes(parseXml(CUSTOM)) !== a
  );
}

// ---------------------------------------------------------------- 对真实亿图样本必须是 no-op
{
  const file = "_research/extract/doc1/theme.xml.txt";
  if (!existsSync(file)) {
    skip("五份样本的 theme.xml 解析 == defaultPalette", "找不到 _research 解包样本");
  } else {
    const xml = readFileSync(file, "utf8");
    eq(
      "Angel 十色按 Accent1..10 逐字还原（原文顺序是打乱的）",
      paletteOf(parseXml(xml), 3, 8),
      defaultPalette()
    );
  }
}

// ---------------------------------------------------------------- .emmx 往返把自定义色板带着走
{
  let doc = createDocument("自定义主题", "logicRight");
  let page = activePage(doc);
  const a = insertChild(page, page.rootId, "市场需求");
  page = a.page;
  const b = insertChild(page, page.rootId, "竞品分析");
  page = b.page;
  page = { ...page, theme: { ...page.theme, colorId: 9, textId: 12 } };
  doc = withActivePage({ ...doc, pages: [page] }, page);
  doc = { ...doc, rawUnknown: { ...(doc.rawUnknown ?? {}), themeRoot: parseXml(CUSTOM) } };

  const before = paletteForDoc(doc, page);
  eq("page 绑的 colorId 决定用哪一套（这里 ID=9 那一套）", before.accents, ["#aaaaaa"]);
  eq("文字主题按 page.theme.textId 选", [before.fontFamily, before.fontSizes], ["宋体", [20, 16]]);

  const rt = await parseEmmx(await writeEmmx(doc));
  const rtPage = rt.doc.pages[0];
  eq("theme.xml 整份原样带走，重开还是那一套色", paletteForDoc(rt.doc, rtPage), before);
  eq(
    "往返不靠运气：槽位号在重开之后仍然解到文件自己的 Accent1",
    resolveColor({ v: "#fff", themeColor: 1 }, paletteForDoc(rt.doc, rtPage).accents),
    "#aaaaaa"
  );

  const paint = paintPage(rtPage, { palette: before });
  const plain = paintPage(rtPage, {});
  eq(
    "色板真走到画布：中心主题用文档 Accent1 推的深色，不是 Angel 的",
    paint.boxes.find((x) => x.id === rtPage.rootId)?.fill,
    shade("#aaaaaa", 10)
  );
  ok(
    "与默认色板确实不同（否则这条断言等于自证）",
    paint.boxes.find((x) => x.id === rtPage.rootId)?.fill !==
      plain.boxes.find((x) => x.id === rtPage.rootId)?.fill
  );
  eq("分支取色也换了一套", paint.boxes.find((x) => x.id === b.id)?.fill, "#aaaaaa");

  // 导出侧：paint 之外还有一次序列化，颜色与字族都得真落到文件里
  const svg = buildSvg(rtPage, { palette: before });
  ok("SVG 导出文件里就是文档那套色", svg.includes('fill="#aaaaaa"'));
  ok("文档自带的字族排在建栈前面", svg.includes(`font-family="宋体, ${FONT_STACK}"`));
  ok("默认色板导出的不是同一张图", !buildSvg(rtPage, {}).includes('fill="#aaaaaa"'));
  eq(
    "默认那套的 font-family 属性逐字没变（五份样本的旧导出文件不受影响）",
    fontStackOf(EDRAW_FONT_FAMILY),
    FONT_STACK
  );
}

done();

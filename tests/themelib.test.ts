/**
 * 主题库（03 §1.3-17）：一套能起名字的色板，写进文档的 theme.xml、存进 config.json、再读回来。
 *
 * 覆盖的缺陷形状（3A 那份只管"读"，这一份管"写"与"存"）：
 * 1) 写完必须能原样读回来，且**读写同一条 pick 规矩** —— 给一份没有那个槽位号的文件换主题，
 *    如果写侧取第一套而读侧取"认不出就回退 Angel"，用户看到的是"应用了个寂寞"；
 * 2) copy-on-write：传进去的 root 就是 codec 的解包缓存，也是撤销栈里那一份的同一个对象，
 *    就地改会把历史一起改掉（撤销之后仍是新配色，且再 redo 会拿到两份）；
 * 3) 只动该动的那几档：文件里我们不认识的节点（ThemeEffect 的 Shade/Tint、ThemeShape 的连线方案、
 *    ColorScheme 上非 Accent 的属性、FontScheme 上多出来的属性）必须原样带走；
 * 4) 档数变了要收口：新色板只有 3 档时不能留着重开文件里的 Accent4..10（那是上一套的颜色）；
 * 5) 对Angel样本必须是 no-op —— 用内置那套"应用"一次等于什么都没做，否则旧文件的颜色被动；
 * 6) config.json 是用户能手改的：坏色值、空名、重名、超上限都要有明确下场，不许把 NaN 送进画布；
 * 7) .emmx 往返 + 「设为当前默认」真的影响新建文档 —— 存下来的东西如果只活在内存里，
 *    这一整个功能就只是个预览。
 */
import { existsSync, readFileSync } from "node:fs";
import { done, eq, ok, skip } from "./_harness.ts";
import {
  attr,
  find,
  nodeEquals,
  parseXml,
  serializeXml,
  type XmlNode,
} from "../src/engine/emmx/xparse.ts";
import { parseEmmx, writeEmmx } from "../src/engine/emmx/codec.ts";
import {
  colorNameOf,
  paletteForDoc,
  paletteOf,
  themeRootOf,
  withPalette,
} from "../src/engine/emmx/theme.ts";
import {
  ACCENT_MAX,
  applyTheme,
  BUILTIN_DEFAULT,
  BUILTIN_DEFAULT_ID,
  blankTheme,
  extractTheme,
  findTheme,
  FONT_LEVEL_MAX,
  nextThemeId,
  paletteOfTheme,
  removeTheme,
  samePalette,
  sanitizeTheme,
  sanitizeThemes,
  saveTheme,
  THEME_MAX,
  THEME_NAME_MAX,
  THEME_REASON_TEXT,
  type StoredTheme,
} from "../src/engine/themelib.ts";
import { activePage, createDocument } from "../src/model/factory.ts";
import { ANGEL_ACCENTS } from "../src/model/constants.ts";
import { defaultPalette, EDRAW_FONT_FAMILY, EDRAW_FONT_SIZES } from "../src/engine/style.ts";
import { DEFAULT_SETTINGS, useSettings } from "../src/stores/settingsStore.ts";
import { activeDoc, useDoc } from "../src/stores/docStore.ts";

/** 一份"不是 Angel"的两套色板文件：ID=5 与 ID=9 各一套，各带一个我们不认识的属性。 */
const TWO =
  '<Themes><Theme Effect="0" Name="Edraw" Rainbow="0" ID="31">' +
  '<ThemeColor Name="First" ID="5"><ColorScheme Accent1="#111111" Accent2="#222222" Shade="1"/></ThemeColor>' +
  '<ThemeColor Name="Other" ID="9"><ColorScheme Accent1="#aaaaaa"/></ThemeColor>' +
  '<ThemeEffect ID="31"><Shade V="0.8"/></ThemeEffect>' +
  '<ThemeText Name="宋体" ID="12"><FontSchemeLst>' +
  '<FontScheme FontName="宋体" FontSize="20" Flag="0" ThemeFont="1"/>' +
  '<FontScheme FontName="宋体" FontSize="16" Flag="0"/>' +
  '<FontScheme FontName="宋体" FontSize="14" Flag="0"/>' +
  "</FontSchemeLst></ThemeText>" +
  '<ThemeShape ID="31"/></Theme></Themes>';

const pal = (accents: string[], fontSizes: number[], fontFamily: string) => ({
  accents,
  fontSizes,
  fontFamily,
});

/** find() 找不到给的是 undefined，喂给 attr() 就读空 —— 报错看不出"少了哪个标签"。缺标签是硬失败。 */
function needTag(root: XmlNode, tag: string): XmlNode {
  const n = find(root, tag);
  if (!n) throw new Error(`没有 <${tag}>`);
  return n;
}

// ---------------------------------------------------------------- 写：读完必须相等（读写同规矩）
{
  const p = pal(["#111111", "#222222", "#333333"], [20, 16, 12], "宋体");
  const out = withPalette(undefined, p, { colorId: 3, textId: 8, themeName: "我的" });
  eq("没有 theme.xml 的文件也能种出一棵：写完立刻读回同一套", paletteOf(out, 3, 8), p);
  eq("种出来的 ThemeColor 用页面绑的槽位号", colorNameOf(out, 3), "我的");
  eq("槽位号认不出的页仍然取第一套（读写同一条规矩）", paletteOf(out, 777, 8), p);

  const root = parseXml(TWO);
  // 页绑的是 ID=9：写它，不能顺手把 ID=5 那套也改了（多页文档里另一页还绑着它）。
  const written = withPalette(root, p, { colorId: 9, textId: 12, themeName: "第二个" });
  eq("按页绑的槽位号写那两套", paletteOf(written, 9, 12), p);
  eq("隔壁那套一个字节没动", paletteOf(written, 5, 12).accents, ["#111111", "#222222"]);
  eq("名字盖在被写的那一套上", colorNameOf(written, 9), "第二个");
  eq("没被写的那套保留原名", colorNameOf(written, 5), "First");

  const ghost = withPalette(root, p, { colorId: 404, textId: 404, themeName: "名字" });
  eq(
    "页绑的 ID 在文件里不存在：写第一套，读回来也是第一套（不是 Angel、也不是第二套）",
    paletteOf(ghost, 404, 404),
    p
  );
  eq("写第一套时不动第二套", paletteOf(ghost, 9, 12).accents, ["#aaaaaa"]);
}

// ---------------------------------------------------------------- 写：只动该动的
{
  const root = parseXml(TWO);
  const before = serializeXml(root);
  const out = withPalette(root, pal(["#010203"], [11], "黑体"), {
    colorId: 5,
    textId: 12,
    themeName: "改名",
  });
  ok("输入一个字节没被改（撤销栈与解析缓存共用那个对象）", serializeXml(root) === before);
  ok("交出去的是新对象", out !== root);
  ok(
    "不认识的颜色属性照带（Shade 是亿图写的，不是我们编的）",
    serializeXml(out).includes('Shade="1"')
  );
  ok("ThemeEffect 整截原样带走", serializeXml(out).includes('<Shade V="0.8"/>'));
  ok("空的 ThemeShape 也还在", serializeXml(out).includes("<ThemeShape"));
  ok("FontScheme 上多出来的属性留着", serializeXml(out).includes('ThemeFont="1"'));
  eq("新色板只有一档就只写一档：旧文件的 Accent2 不能留着重开", paletteOf(out, 5).accents, [
    "#010203",
  ]);
  eq("字号从 3 档收到 1 档，多的两行删掉", paletteOf(out, 5, 12).fontSizes, [11]);
  eq("字族改了 ThemeText 也改了每档", paletteOf(out, 5, 12).fontFamily, "黑体");
}

// ---------------------------------------------------------------- 缺的那两套按亿图的顺序插
{
  // 故意拿一份"只有 ThemeEffect + ThemeShape"的文件：补出来的两套必须落进自己的位置。
  // append 的话 ThemeText 会排到 ThemeShape 后面 —— 顺序错了亿图不认，
  // 而单看读回来的色板又是正常的，只有真打开那个文件才会发现整套主题没了。
  const sparse = parseXml(
    '<Themes><Theme Effect="0" Name="Edraw" Rainbow="0" ID="31">' +
      '<ThemeEffect ID="31"><Shade V="0.8"/></ThemeEffect>' +
      '<ThemeShape ID="31"/></Theme></Themes>'
  );
  const out = withPalette(sparse, pal(["#010203"], [11], "黑体"), {
    colorId: 3,
    textId: 8,
    themeName: "新建的一套",
  });
  const theme = needTag(out, "Theme");
  eq(
    "<Theme> 下的书写顺序是 ThemeColor → ThemeEffect → ThemeText → ThemeShape",
    theme.children.map((c) => c.tag),
    ["ThemeColor", "ThemeEffect", "ThemeText", "ThemeShape"]
  );
  eq("补出来的 ThemeColor 用页面绑的槽位号", attr(needTag(theme, "ThemeColor"), "ID"), "3");
  eq("补出来的 ThemeText 同理", attr(needTag(theme, "ThemeText"), "ID"), "8");
  eq("名字盖在新建的这一套上", colorNameOf(out, 3), "新建的一套");
  eq(
    "已有的两套用原样待着",
    [attr(needTag(theme, "ThemeEffect"), "ID"), attr(needTag(theme, "ThemeShape"), "ID")],
    ["31", "31"]
  );
  eq(
    "整套缺失时造出来的 <Theme> 带亿图那几个属性",
    Object.keys(
      find(withPalette(parseXml("<Themes/>"), pal(["#010203"], [11], "黑体"), {}), "Theme")
        ?.attrs ?? {}
    ).sort(),
    ["Effect", "ID", "Name", "Rainbow"]
  );
  eq(
    "没有 theme.xml 的文件应用后读回那一套",
    paletteOf(withPalette(undefined, pal(["#010203"], [11], "黑体")), 3, 8),
    pal(["#010203"], [11], "黑体")
  );
}

// ---------------------------------------------------------------- 对亿图样本必须是 no-op
{
  const file = "_research/extract/doc1/theme.xml.txt";
  if (!existsSync(file)) {
    skip("用内置那套应用 = 文件不变", "找不到 _research 解包样本");
  } else {
    const angel = parseXml(readFileSync(file, "utf8"));
    eq(
      "把 defaultPalette 写回 Angel 样本：结构等价（属性顺序不算差异）",
      nodeEquals(
        withPalette(angel, defaultPalette(), { colorId: 3, textId: 8, themeName: "Angel" }),
        angel
      ),
      true
    );
    ok(
      "内置那一套的色值就是样本里那十档",
      samePalette(paletteOf(angel, 3, 8), paletteOfTheme(BUILTIN_DEFAULT))
    );
  }
}

// ---------------------------------------------------------------- 应用：doc 级纯函数 + .emmx 往返
{
  let doc = createDocument("主题库", "logicRight");
  const page = activePage(doc);
  ok("新建文档本来没有 theme.xml", themeRootOf(doc) === undefined);

  const t: StoredTheme = {
    id: "t1",
    name: "深海",
    accents: ["#0b3d5c", "#1f7a8c", "#39a0ca"],
    fontSizes: [24, 18, 14],
    fontFamily: "微软雅黑",
  };
  const next = applyTheme(doc, page, t);
  ok("原 doc 不动（mutateDoc 之前不能有副作用）", themeRootOf(doc) === undefined);
  eq(
    "应用后这一页的色板就是那套",
    paletteForDoc(next, page),
    pal(t.accents, t.fontSizes, t.fontFamily)
  );
  eq(
    "列表名盖进文件的 ThemeColor/@Name",
    colorNameOf(themeRootOf(next), page.theme.colorId),
    "深海"
  );

  const again = applyTheme(next, page, t);
  ok("同一套重复应用是文件级空转（结构等价）", nodeEquals(themeRootOf(again)!, themeRootOf(next)!));

  const rt = await parseEmmx(await writeEmmx(next));
  eq(
    ".emmx 往返带着这套色走",
    paletteForDoc(rt.doc, rt.doc.pages[0]),
    pal(t.accents, t.fontSizes, t.fontFamily)
  );

  // 提取 → 再应用，对同一份文档必须是 no-op：读写两侧的镜像关系
  const extracted = extractTheme(next, page);
  eq("提取出的名字用文件里那一套的", extracted.name, "深海");
  eq("提取带上 themeName", extracted.themeName, "深海");
  eq("提取出来的就是此刻在用的", extracted.accents, t.accents);
  ok(
    "提取→应用不改变文件（这一条钉死读写镜像）",
    nodeEquals(themeRootOf(applyTheme(next, page, extracted))!, themeRootOf(next)!)
  );
  const bare = extractTheme(createDocument("空"), activePage(createDocument("空")));
  eq("没有 theme.xml 时列表叫什么", bare.name, "当前主题");
  ok("没有 theme.xml 就不带 themeName（应用时不该凭空造一个名字）", bare.themeName === undefined);
}

// ---------------------------------------------------------------- 落库：校验与增删改
{
  const good: StoredTheme = {
    id: "t1",
    name: "深海",
    accents: ["#0b3d5c"],
    fontSizes: [24],
    fontFamily: "微软雅黑",
  };
  /** 存成功的列表；失败就交回空列表，让后面那几条断言自己红，而不是整个文件抛错中断。 */
  const okList = (op: ReturnType<typeof saveTheme>): StoredTheme[] => (op.ok ? op.list : []);

  const saved = okList(saveTheme([], good));
  eq("空列表存一条", saved.length, 1);
  eq("新建的号从 t1 起（config.json 里人眼可读）", saved[0]?.id, "t1");
  const renamed = okList(saveTheme(saved, { ...good, name: "浅海" }));
  eq("同 id 再存是改不是加", renamed.length, 1);
  eq("改的是名字", renamed[0]?.name, "浅海");
  eq("改完还留着原 id", renamed[0]?.id, "t1");

  const dup = saveTheme(saved, { ...good, id: "t2", name: "深海 " });
  eq("重名（含大小写与首尾空格）被拒", dup.ok, false);
  eq(
    "重名的文案是参考软件原文",
    dup.ok ? "" : THEME_REASON_TEXT[dup.reason],
    "保存失败，该自定义主题已经存在。"
  );
  eq("名字空着被拒", saveTheme([], { ...good, name: "  " }).ok, false);
  eq("一个能用的色都没有被拒", saveTheme([], { ...good, accents: ["auto", ""] }).ok, false);

  const many = Array.from({ length: THEME_MAX }, (_, i) => ({
    ...good,
    id: `o${i}`,
    name: `n${i}`,
  }));
  eq("库确实铺到了上限", many.length, THEME_MAX);
  eq(
    "满库时改现有那一条仍然要过（上限不该挡住编辑）",
    saveTheme(many, { ...many[3], name: "改了个名" }).ok,
    true
  );
  eq(
    "满了再加就拒，不悄悄淘汰最老的",
    saveTheme(many, { ...good, id: "", name: "新来的" }).ok,
    false
  );
  eq(
    "差一条时还能加",
    okList(saveTheme(many.slice(0, THEME_MAX - 1), { ...good, id: "", name: "最后一条" })).length,
    THEME_MAX
  );
  eq(
    "色值落库前先归一：#abc 展开成 #aabbcc",
    okList(saveTheme([], { ...good, accents: ["#abc"] }))[0]?.accents,
    ["#aabbcc"]
  );
  eq(
    "超过 16 档的色直接判这套不合规（而不是裁一半存下来）",
    saveTheme([], { ...good, accents: Array.from({ length: ACCENT_MAX + 1 }, () => "#111111") }).ok,
    false
  );
  eq(
    "字号超出档数上限就裁到上限",
    okList(
      saveTheme([], {
        ...good,
        fontSizes: Array.from({ length: FONT_LEVEL_MAX + 5 }, (_, i) => i + 6),
      })
    )[0]?.fontSizes.length,
    FONT_LEVEL_MAX
  );

  eq("按 id 删", removeTheme(renamed, "t1").length, 0);
  eq(
    "内置那一套不在库里（findTheme 认不出就是 undefined）",
    findTheme([], BUILTIN_DEFAULT_ID),
    undefined
  );
  eq("空 id 也当没这条", findTheme(renamed, ""), undefined);
  eq(
    "取号跳过已用过的",
    nextThemeId([
      { ...good, id: "t1" },
      { ...good, id: "t2" },
    ]),
    "t3"
  );
  eq("草稿不占号", blankTheme().id, "");
  eq("草稿一个名字都没有", blankTheme().name, "");
  eq("草稿用的就是内置那十档", blankTheme().accents, ANGEL_ACCENTS);
}

// ---------------------------------------------------------------- 配置文件里的脏值
{
  const item = (over: Partial<StoredTheme>): StoredTheme => ({
    ...blankTheme(),
    id: "t1",
    name: "n",
    ...over,
  });
  eq(
    "坏色值被丢掉，好的留下",
    sanitizeTheme(item({ accents: ["#111111", "auto", "#ZZZZZZ"] }), "x")?.accents,
    ["#111111"]
  );
  eq("全坏 = 一个色都没有 = 整条丢", sanitizeTheme(item({ accents: ["auto"] }), "x"), undefined);
  eq("名字空 = 整条丢", sanitizeTheme(item({ name: "  " }), "x"), undefined);
  eq(
    "超长名字裁到上限而不是丢掉（用户的命名不该被废掉）",
    sanitizeTheme(item({ name: "x".repeat(THEME_NAME_MAX + 30) }), "x")?.name.length,
    THEME_NAME_MAX
  );
  eq(
    "字号全坏回退实测那 8 档",
    sanitizeTheme(item({ fontSizes: [0, -3, 1e999] }), "x")?.fontSizes,
    EDRAW_FONT_SIZES
  );
  eq(
    "字族空回退内置",
    sanitizeTheme(item({ fontFamily: "   " }), "x")?.fontFamily,
    EDRAW_FONT_FAMILY
  );
  eq("缺 id 用位置补号（手改的配置不至于撞车）", sanitizeTheme(item({ id: "" }), "t7")?.id, "t7");
  eq("非对象不当主题", sanitizeTheme("深海", "t1"), undefined);
  eq(
    "色板比上限还多就整条丢",
    sanitizeTheme(item({ accents: Array(ACCENT_MAX + 1).fill("#111111") }), "t1"),
    undefined
  );

  const mixed = [
    item({ name: "甲" }),
    item({ id: "", name: "乙" }),
    { nope: 1 },
    item({ id: "", name: "甲" }),
  ];
  const clean = sanitizeThemes(mixed);
  eq("脏条丢掉", clean.length, 2);
  eq(
    "同名留第一个，后来那条整条丢掉",
    clean.map((t) => t.name),
    ["甲", "乙"]
  );
  eq(
    "缺 id 的按位置补号",
    clean.map((t) => t.id),
    ["t1", "t2"]
  );
  eq(
    "大小写不同的同名也算同名",
    sanitizeThemes([item({ id: "t1", name: "AB" }), item({ id: "t2", name: "ab" })]).length,
    1
  );
  eq("非数组一律当空库", sanitizeThemes("不是数组"), []);
  eq(
    "超出 THEME_MAX 裁掉",
    sanitizeThemes(
      Array.from({ length: THEME_MAX + 9 }, (_, i) => item({ id: `t${i}`, name: `n${i}` }))
    ).length,
    THEME_MAX
  );
}

// ---------------------------------------------------------------- 同色判定（面板上那两个标签）
{
  const a = defaultPalette();
  eq("逐值相同才算同一套", samePalette(a, defaultPalette()), true);
  eq("差一档色就不算", samePalette(a, { ...a, accents: a.accents.slice(0, 9) }), false);
  eq("字族不同就不算", samePalette(a, { ...a, fontFamily: "楷体" }), false);
  eq("字体档数不同就不算", samePalette(a, { ...a, fontSizes: [14] }), false);
  eq("内置那一套带 Angel 的名字", BUILTIN_DEFAULT.themeName, "Angel");
  eq("内置那一套就是原来的全局色板", paletteOfTheme(BUILTIN_DEFAULT), a);
  eq(
    "paletteOfTheme 交副本：面板把 draft 写脏不该污染库",
    (() => {
      const t = { ...BUILTIN_DEFAULT };
      paletteOfTheme(t).accents[0] = "#000000";
      return t.accents[0];
    })(),
    ANGEL_ACCENTS[0]
  );
}

// ---------------------------------------------------------------- 「设为当前默认」真影响新建文档
{
  const custom: StoredTheme = {
    id: "t1",
    name: "深海",
    accents: ["#0b3d5c", "#1f7a8c"],
    fontSizes: [22, 16],
    fontFamily: "微软雅黑",
  };
  const setDefault = (id: string, list: StoredTheme[]) =>
    useSettings.setState({
      loaded: true,
      settings: {
        ...DEFAULT_SETTINGS,
        format: { ...DEFAULT_SETTINGS.format, defaultThemeId: id },
        themes: { custom: list },
      },
    });

  setDefault("default", []);
  await useDoc.getState().newDoc("默认起手");
  const d1 = activeDoc(useDoc.getState());
  ok("内置那套不种 theme.xml（paletteOf 本来就回退 Angel）", themeRootOf(d1) === undefined);
  eq("内置起手的色板", paletteForDoc(d1!, activePage(d1!)), defaultPalette());

  setDefault("t1", [custom]);
  await useDoc.getState().newDoc("自定义起手");
  const d2 = activeDoc(useDoc.getState());
  eq(
    "新建文档真的按配置里那套起手",
    paletteForDoc(d2!, activePage(d2!)),
    pal(custom.accents, custom.fontSizes, custom.fontFamily)
  );
  const rt = await parseEmmx(await writeEmmx(d2!));
  eq(
    "新建 → 存盘 → 重开，还是那套（不止活在内存里）",
    paletteForDoc(rt.doc, rt.doc.pages[0]),
    pal(custom.accents, custom.fontSizes, custom.fontFamily)
  );

  setDefault("被删掉的那套", []);
  await useDoc.getState().newDoc("脏配置");
  eq(
    "默认指向一个不存在的 id 就退回内置，不报错也不画 NaN",
    themeRootOf(activeDoc(useDoc.getState())),
    undefined
  );
}

done();

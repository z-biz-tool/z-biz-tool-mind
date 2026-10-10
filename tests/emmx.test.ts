/**
 * .emmx 读写往返。用真实亿图文件（163 个 Shape，含 81 条缓存连线）验证。
 *
 * 缺陷形状（这里刻意覆盖的）：
 * 1) 双向父子索引（SubLevel / Super）必须一致，否则删一个子节点会留下幽灵；
 * 2) MMConnector 是布局缓存，不能被当成用户数据；
 * 3) 中文文件名 + deflate 的 ZIP 条目必须能原读原写；
 * 4) 未识别属性不能被保存动作吃掉；
 * 5) 我们不认得的 <Layout V> 数字码不能被降级成认得的那个 —— 别人的文件开一次再存，
 *    布局属性不该发生变化。
 * 6) <StyleMask V> 必须原样读进来再写回去 —— 它记的是"这个主题的颜色是用户自己挑的"，
 *    丢了一位，保存重开之后换主题就会把用户挑的颜色盖掉。
 * 7) 编辑正文会让整份 Shape 节点重新生成 —— 批注、超链接，以及任何我们还没建模的标签，
 *    都不能跟着一起没了。
 * 8) 保存会改 ModifiedDate，"复用原始 document.xml 节点"的快速通道随之失效；重新生成的那一份
 *    必须还是亿图的写法（Version/DocGuid 在 <Document> 上，属性是 <X V/> 子节点）。
 * 9) 分支自由布局（00 §3.3）的位移只存在我们自造的 <BranchOffset> 上：它必须进语义指纹，
 *    否则"拖一整枝"这种只改一个字段的编辑会被判成没动过，原节点原样带回，位移静默丢失。
 * 10) 加粗的落点（01 A-16）：界面那一下要写成 `Character@Style="1"`，重开必须仍然显示粗；
 *    反过来，层级推导出来的粗（中心主题/一级分支）一个字都不许落到盘上。
 *    导入方向同样要成立：亿图标在 Character@Style 上的粗（真样张 24 颗，18 颗在二级以下）
 *    按层级推不出来，只能读回来 —— 读丢的那些开一次就是"字体变细了"。
 * 11) 字号/字族/字色与加粗同一个家（`Character@Size/Family/Color`，01 A-17）。两头都要成立：
 *    文件没写那一位时读回来必须还是"没写过"（补成常数 12 就是替文件撒谎，存盘照着谎言写回去），
 *    而我们新建的主题（模型里什么都不声明）在盘上必须落画布推导的那一份，
 *    不是写死 Verdana/12/#333333 —— 中心主题推出来是 14 号白字，常数那三个都不是。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { done, eq, ok, rejects, skip } from "./_harness.ts";
import { readZip, writeZip, decodeBytes, encodeText } from "../src/engine/emmx/zip.ts";
import { nodeEquals, parseXml, findAll, attr, numVnode, vnode } from "../src/engine/emmx/xparse.ts";
import type { XmlNode } from "../src/engine/emmx/xparse.ts";
import { modelEquals, parseEmmx, writeEmmx } from "../src/engine/emmx/codec.ts";
import {
  insertChild,
  levelOf,
  setTopicBold,
  shiftBranch,
  updateExtras,
  updateStyle,
  updateText,
} from "../src/engine/tree.ts";
import { createDocument } from "../src/model/factory.ts";
import { DEFAULTS } from "../src/model/constants.ts";
import { applyPalette, styleFor } from "../src/engine/style.ts";
import { plainText, usedCharIx } from "../src/types/model.ts";
import type { FontSpec, Page } from "../src/types/model.ts";

const FIXTURE = join(process.cwd(), "_research", "extract", "doc1", "doc.zip");

// ---------------------------------------------------------------- 合成夹具（03 §1.3-2）
// 真亿图文件没入库（345 KB 且是别人的作品），CI 里整份 emmx.test.ts 直接 skip → 0/0，
// 绿得毫无意义。这一段用 factory 现造的文档跑同一批核心承诺，任何环境都会执行。
{
  const base = createDocument("合成往返", "logicRight");
  let page = base.pages[0];
  const kids: string[] = [];
  for (const t of ["分支甲", "分支乙", "分支丙"]) {
    const r = insertChild(page, page.rootId, t);
    page = r.page;
    kids.push(r.id);
  }
  const g = insertChild(page, kids[0], "孙一");
  page = g.page;
  const withPage = (p: Page) => ({
    ...base,
    pages: base.pages.map((x) => (x.id === p.id ? p : x)),
  });
  const pageXml = async (bytes: Uint8Array) =>
    decodeBytes((await readZip(bytes)).find((e) => /page\/page\.xml$/.test(e.name)).data);
  const layoutV = (xml: string) => /<Layout V="(\d+)"/.exec(xml)?.[1];
  const node = (
    tag: string,
    attrs: Record<string, string> = {},
    children: XmlNode[] = []
  ): XmlNode => ({ tag, attrs, children, text: "" });

  // --- 没编辑过的文档：写出去要能原样读回来
  const rt0 = await parseEmmx(await writeEmmx(withPage(page)));
  ok("合成文档解析无告警", rt0.warnings.length === 0, rt0.warnings.join(" | "));
  eq("主题数", Object.keys(rt0.doc.pages[0].shapes).length, 5);
  // 不能直接拿 factory 的文档跟解析结果比：读侧会补默认值（platform=win、bold=false、
  // props.background、maxShapeId、layout.rawCode），factory 造的那几项是 undefined。
  // 比第一次往返和第二次往返 —— 这才是"保存再保存不该变质"的承诺。
  const rt1 = await parseEmmx(await writeEmmx(rt0.doc));
  ok("write→parse 模型等价（往返幂等）", modelEquals(rt0.doc, rt1.doc));
  eq("中心主题仍是 MainIdea", rt0.doc.pages[0].shapes[rt0.doc.pages[0].rootId].type, "MainIdea");
  eq("子索引对得上", rt0.doc.pages[0].shapes[kids[0]].childIds.join(","), g.id);
  eq("正文没丢", plainText(rt0.doc.pages[0].shapes[kids[2]].text), "分支丙");

  // --- 陌生布局码不能被"降级"成我们认得的那个
  // rawCode 只在"这个码映射出来的名字 == 页面现在的 code"时才原样带回，
  // 所以合成页面得是 balanced（6），否则码表里的 8 会先把 7 顶掉。
  const foreign: Page = {
    ...page,
    layout: { ...page.layout, rawCode: 7, code: "balanced" as const },
  };
  const fbytes = await writeEmmx(withPage(foreign));
  eq("陌生码 V=7 原样写回，不降级成 6", layoutV(await pageXml(fbytes)), "7");
  eq("重读时仍记得这个陌生码", (await parseEmmx(fbytes)).doc.pages[0].layout.rawCode, 7);
  const switched: Page = {
    ...foreign,
    layout: { ...foreign.layout, code: "treeRight" as const },
  };
  eq(
    "本地专属的新码不进交换格式，写回退值 6",
    layoutV(await writeEmmx(withPage(switched)).then(pageXml)),
    "6"
  );

  // --- 独立配色与 StyleMask 那一位
  const pinned = kids[1];
  const colored = updateStyle(page, pinned, {
    fill: { type: "Solid", color: { v: "#c00000" } },
    mask: (page.shapes[pinned].style.mask ?? 0) | 1,
  });
  const crt = (await parseEmmx(await writeEmmx(withPage(colored)))).doc.pages[0];
  eq("自定义配色存住了", crt.shapes[pinned].style.fill?.color?.v, "#c00000");
  ok(
    "独立配色那一位存住了",
    ((crt.shapes[pinned].style.mask ?? 0) & 1) !== 0,
    String(crt.shapes[pinned].style.mask)
  );
  const after = applyPalette(crt);
  eq("换主题盖不掉用户自己挑的颜色", after.shapes[pinned].style.fill?.color?.v, "#c00000");
  ok(
    "换主题会重算未独立配色的主题",
    Object.keys(after.shapes).some(
      (id) =>
        ((crt.shapes[id].style.mask ?? 0) & 1) === 0 &&
        after.shapes[id].style.fill?.color?.v !== crt.shapes[id].style.fill?.color?.v
    ),
    ""
  );

  // --- 分支自由布局（00 §3.3）：亿图没有这个字段，节点名是我们自造的，
  //     但"拖开的枝保存再开还在"是这一版唯一的验收口径。
  const dragged = shiftBranch(colored, pinned, 120, -45);
  const dbytes = await writeEmmx(withPage(dragged));
  ok("位移按我们自己的节点写出去了", /<BranchOffset V="120;-45"/.test(await pageXml(dbytes)));
  const dparsed = await parseEmmx(dbytes);
  const dpage = dparsed.doc.pages[0];
  eq("保存再开，位移还是那一份", dpage.shapes[pinned].offset, { x: 120, y: -45 });
  eq(
    "没被拖的枝不长这个节点",
    Object.values(dpage.shapes)
      .filter((s) => s.offset)
      .map((s) => s.id),
    [pinned]
  );
  ok(
    "第二次保存不变质（往返幂等）",
    modelEquals(dparsed.doc, (await parseEmmx(await writeEmmx(dparsed.doc))).doc)
  );
  ok(
    "没位移的文档不会凭空长出一个节点",
    !/<BranchOffset/.test(await pageXml(await writeEmmx(withPage(page))))
  );
  // 语义指纹那条复用通道：从文件读回来的页面"只改位移"必须被认成改过 ——
  // 漏了这一步，原节点整份原样带回，拖开的枝第二次保存就静默回到引擎位置。
  const rawPage = shiftBranch(rt0.doc.pages[0], pinned, -80, 20);
  const rawDoc = {
    ...rt0.doc,
    pages: rt0.doc.pages.map((x) => (x.id === rawPage.id ? rawPage : x)),
  };
  eq(
    "复用通道里只改位移也重写了这个节点",
    (await parseEmmx(await writeEmmx(rawDoc))).doc.pages[0].shapes[pinned].offset,
    { x: -80, y: 20 }
  );

  // --- 加粗的线上落点（01 A-16）：写在 Character@Style 上，实测亿图只写 "1"、不加粗就整个省掉。
  const shapeBlock = (xml: string, id: string): string => {
    const m = new RegExp(`<Shape[^>]*\\bID="${id}"[\\s\\S]*?(?=<Shape\\b|$)`).exec(
      xml.replace(/>\s+</g, "><")
    );
    return m ? m[0] : "";
  };
  const bareXml = await pageXml(await writeEmmx(withPage(colored)));
  eq(
    "层级推导出来的粗绝不落到盘上（不然每次存盘都凭空多出一串 Style）",
    /Style="1"/.test(bareXml),
    false
  );
  const bolded = setTopicBold(colored, g.id, true);
  const bxml = await pageXml(await writeEmmx(withPage(bolded)));
  ok("加粗的那颗写进了 Character@Style", /<Character[^>]*Style="1"/.test(shapeBlock(bxml, g.id)));
  eq("只多这一颗，别的一颗都不长", (bxml.match(/Style="1"/g) ?? []).length, 1);
  const bParsed = await parseEmmx(await writeEmmx(withPage(bolded)));
  const bPage = bParsed.doc.pages[0];
  eq("重开读回 run 级样式", bPage.shapes[g.id].text.characters[0]?.bold, true);
  eq("重开仍显示粗（显示与盘上同源）", styleFor(bPage, bPage.shapes[g.id]).font.bold, true);
  eq(
    "没点加粗的那颗读回的是「文件没写过 Style」，不是 false 这个值（01 A-17：缺位不等于默认值）",
    bPage.shapes[kids[2]].text.characters[0]?.bold,
    undefined
  );
  eq(
    "那颗显示出来是粗，但这个粗是层级推导给的（一级），盘上没有任何记号（03 §1.3-24）",
    styleFor(bPage, bPage.shapes[kids[2]]).font.bold,
    true
  );
  // 二级以下才是"缺位 → 不粗"的地方：一级本来就推导成粗，比不出差异。
  const deep = insertChild(bolded, kids[2], "孙二");
  const dPage = (await parseEmmx(await writeEmmx(withPage(deep.page)))).doc.pages[0];
  eq("新建的二级主题不声明字重", dPage.shapes[deep.id].text.characters[0]?.bold, undefined);
  eq("所以它按层级推导显示成常规", styleFor(dPage, dPage.shapes[deep.id]).font.bold, false);
  eq(
    "取消加粗再存，Style 整条消失（亿图没有 Style=\"0\" 这种写法）",
    /Style="1"/.test(await pageXml(await writeEmmx(withPage(setTopicBold(bolded, g.id, false))))),
    false
  );
  // 工具栏那一下按的是"显示出来的字重"，不是"style 里存没存过"：中心主题显示本来就是粗，
  // 第一下必须落在取消上。按存没存过取反会得到"再粗一次"—— 用户看是空转，盘上还凭空多一条 Style。
  const flip = (p: Page, id: string) => setTopicBold(p, id, !styleFor(p, p.shapes[id]).font.bold);
  const rootFlip = flip(colored, colored.rootId);
  eq(
    "中心主题第一下就是取消（显示字重取反，不是空转）",
    styleFor(rootFlip, rootFlip.shapes[rootFlip.rootId]).font.bold,
    false
  );
  eq(
    "取消推导粗的这一笔不落盘",
    /Style="1"/.test(await pageXml(await writeEmmx(withPage(rootFlip)))),
    false
  );

  // --- 缺位不等于默认值（01 A-17）：亿图没写 Size/Family/Color 的那条，读进来必须还是"文件没说过"。
  // 真样张里被 run 引用的 827 条 Character 这三位的出现率都是 100%，所以这一支只能自己造：
  // 把写出去的那一位剥掉再读。补成常数就是替文件撒一个谎 —— 显示层分不清"文件说的"和"我们自己种的"，
  // 换主题和新主题的推导余地就这么没了。
  const stripCharAttr = (xml: string, id: string, key: string): string =>
    xml.replace(
      new RegExp(`<Shape[^>]*\\bID="${id}"[\\s\\S]*?(?=<Shape\\b|$)`),
      (block) => block.replace(new RegExp(`(<Character\\b[^>]*?)\\b${key}="[^"]*"`), "$1")
    );
  const plainXml = await pageXml(await writeEmmx(withPage(colored)));
  const rootId = colored.rootId;
  ok(
    "夹具确实给中心主题写了 Size（剥不动就是下面几条在空转）",
    /<Character[^>]*\bSize="/.test(shapeBlock(plainXml, rootId)),
    shapeBlock(plainXml, rootId)
  );
  const baseBytes = await writeEmmx(withPage(colored));
  const zip = await readZip(baseBytes);
  const centerWant = styleFor(colored, colored.shapes[rootId]);
  /** 三位都要有区分度：推导出来的值和那三个常数不是一个，否则下面的断言在空转。 */
  ok("推导 ≠ 常数（字号）", centerWant.font.size !== DEFAULTS.fontSize, String(centerWant.font.size));
  ok("推导 ≠ 常数（字族）", centerWant.font.family !== DEFAULTS.fontFamily, centerWant.font.family);
  ok("推导 ≠ 常数（字色：中心主题是白字，常数是深灰）", centerWant.font.color !== DEFAULTS.textColor, centerWant.font.color);
  for (const spec of [
    { key: "Size", get: (f: FontSpec) => f.size, want: centerWant.font.size, constant: DEFAULTS.fontSize },
    { key: "Family", get: (f: FontSpec) => f.family, want: centerWant.font.family, constant: DEFAULTS.fontFamily },
    { key: "Color", get: (f: FontSpec) => f.color, want: centerWant.font.color, constant: DEFAULTS.textColor },
  ]) {
    ok(
      `夹具原本写了 ${spec.key}（剥不动就是这一条在空转）`,
      new RegExp(`<Character[^>]*\\b${spec.key}="`).test(shapeBlock(plainXml, rootId))
    );
    const stripped = await writeZip(
      zip.map((e) =>
        /page\/page\.xml$/.test(e.name)
          ? { ...e, data: encodeText(stripCharAttr(decodeBytes(e.data), rootId, spec.key)) }
          : e
      )
    );
    const p = (await parseEmmx(stripped)).doc.pages[0];
    const shown = styleFor(p, p.shapes[rootId]).font;
    eq(
      `文件没写 ${spec.key} → 模型里就是没写过，不是被补成 ${spec.constant}`,
      spec.get(p.shapes[rootId].text.characters[0] ?? {}),
      undefined
    );
    eq(`显示按层级/主题推导走（${String(spec.want)}）`, spec.get(shown), spec.want);
    ok(
      `剥的时候只碰中心主题那一条，${kids[0]} 的 ${spec.key} 还在`,
      spec.get(p.shapes[kids[0]].text.characters[0] ?? {}) !== undefined
    );
  }

  // --- 模型里什么都不声明的主题（factory 造的、新建的主题）在盘上不许写死那三个常数：
  //     必须落画布算出来的那一份，否则亿图打开就是"深灰字压深色底 + 12 号 Verdana"。
  const centerBlock = shapeBlock(plainXml, rootId);
  eq(
    "Character@Color 落的是画布那个字色",
    /<Character[^>]*\bColor="([^"]+)"/.exec(centerBlock)?.[1],
    centerWant.font.color
  );
  eq(
    "Family 跟主题走，不跟 Verdana 常数走",
    /<Character[^>]*\bFamily="([^"]+)"/.exec(centerBlock)?.[1],
    centerWant.font.family
  );
  eq(
    "Size 同理（中心主题那一档是 14，不是常数 12）",
    /<Character[^>]*\bSize="([^"]+)"/.exec(centerBlock)?.[1],
    String(centerWant.font.size)
  );

  // --- 批注 / 超链接 / 标签
  const noted = updateExtras(
    updateExtras(updateExtras(colored, kids[0], { note: "批注一" }), kids[1], {
      hyperlink: { kind: "web", target: "https://example.com/a?b=1" },
    }),
    kids[2],
    { labels: ["原型", "草稿"] }
  );
  const nrt = (await parseEmmx(await writeEmmx(withPage(noted)))).doc.pages[0];
  eq("批注往返", nrt.shapes[kids[0]].extras.note, "批注一");
  eq("超链接往返", nrt.shapes[kids[1]].extras.hyperlink?.target, "https://example.com/a?b=1");
  eq(
    "标签往返（亿图的尾分号不该多出空项）",
    (nrt.shapes[kids[2]].extras.labels ?? []).join(";"),
    "原型;草稿"
  );
  const dropped = updateExtras(nrt, kids[0], { note: undefined });
  const droppedBack = (await parseEmmx(await writeEmmx(withPage(dropped)))).doc.pages[0];
  eq("界面里删掉的批注不再写回", droppedBack.shapes[kids[0]].extras.note, undefined);

  // --- 编辑正文会让整份 Shape 重新生成，我们没建模的标签不能被顺手抹掉
  const parsed = await parseEmmx(await writeEmmx(withPage(noted)));
  const raw = (parsed.doc.pages[0].rawUnknown as { nodes: Record<string, XmlNode> }).nodes;
  const keyOf = (id: string) => Object.keys(raw).find((k) => k.endsWith(`:${id}`)) ?? "";
  ok("读侧给每个主题存了原节点", keyOf(kids[0]).length > 0, kids[0]);
  const seeded: Page = {
    ...parsed.doc.pages[0],
    rawUnknown: {
      ...(parsed.doc.pages[0].rawUnknown as object),
      nodes: {
        ...raw,
        [keyOf(kids[0])]: {
          ...raw[keyOf(kids[0])],
          children: [...raw[keyOf(kids[0])].children, node("FutureTag", { V: "9" })],
        },
      },
    },
  };
  const touched = updateText(seeded, kids[0], "改了正文");
  const txml = await pageXml(await writeEmmx({ ...parsed.doc, pages: [touched] }));
  ok("重新生成的节点仍带 FutureTag", txml.includes("FutureTag"), txml.slice(0, 120));
  ok("改过的正文写进去了", txml.includes("改了正文"));

  // --- 发号：往返之后新增的主题不能撞上文件里任何已用 ID
  const fileIds = (txml.match(/ID="(\d+)"/g) ?? []).map((s) => s.slice(4, -1));
  const usedIds = new Set([...Object.keys(touched.shapes), ...fileIds]);
  const fresh = insertChild(touched, touched.rootId, "新分支");
  ok("新 ID 未与文件里任何 Shape 重号", !usedIds.has(fresh.id), fresh.id);

  // --- 包里不属于任何 Shape 的东西：中文资源名 + 预览图
  const withMedia = await writeEmmx({
    ...withPage(page),
    media: { "media/图片 1.png": new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) },
  });
  const mNames = (await readZip(withMedia)).map((e) => e.name);
  ok(
    "中文资源名原样回来",
    mNames.some((n) => n === "media/图片 1.png"),
    mNames.join(",")
  );
  const withThumb = await writeZip([
    ...(await readZip(withMedia)),
    { name: "thumbnail.jpeg", data: new Uint8Array([255, 216, 255, 217]) },
  ]);
  const thumbSaved = await readZip(await writeEmmx((await parseEmmx(withThumb)).doc));
  ok(
    "thumbnail 按原字节带回",
    thumbSaved.find((e) => e.name === "thumbnail.jpeg")?.data.length === 4,
    ""
  );

  // --- 坏输入
  await rejects(
    "非 ZIP 报中文错误",
    parseEmmx(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])),
    "不是 ZIP 容器"
  );
  await rejects(
    "ZIP 里缺 page.xml 报错",
    writeZip([{ name: "document.xml", data: new Uint8Array([60, 63, 120]) }]).then(parseEmmx),
    "page/"
  );

  // --- 亿图 V12 的模板/云端容器（01 A-14）：92 份官方样张里 87 份走 mmpage/page.bin，
  // 包里一张 page/*.xml 都没有。我们不逆向那串 varint/TLV 流（猜出来的 reader 会产出
  // "能打开但内容是编的"那种更坏的失败），但报错必须是"能行动的"：
  // 说清这是格式代际差异，并给出下一步 —— 而不是把内部目录结构念给用户听。
  const docXml = encodeText('<?xml version="1.0" encoding="UTF-8"?><Document><Category /></Document>');
  const v12 = await writeZip([
    { name: "document.xml", data: docXml },
    { name: "mmpage/page.bin", data: new Uint8Array([1, 2, 3, 4]) },
    { name: "mm.bkiwi", data: new Uint8Array([9]) },
    { name: "rels/page_formats.xml", data: new Uint8Array([8]) },
  ]);
  const v12Msg = await parseEmmx(v12).then(
    () => "",
    (e: unknown) => (e instanceof Error ? e.message : String(e))
  );
  ok("V12 容器点名 page.bin，而不是只说没有页面", v12Msg.includes("page.bin"), v12Msg);
  ok("V12 文案说是二进制容器与 XML 容器的代际差", v12Msg.includes("二进制页面容器") && v12Msg.includes("XML"), v12Msg);
  ok("V12 文案给了可行动作（在亿图里另存为 .emmx）", v12Msg.includes("另存为"), v12Msg);
  ok("V12 文案给了替代入口（导入别的格式）", v12Msg.includes("导入"), v12Msg);
  // 两种失败不能混在一起说：包里没有 page.bin 时冒认 V12，等于把猜的话当成结论讲。
  const plainMsg = await parseEmmx(await writeZip([{ name: "document.xml", data: docXml }])).then(
    () => "",
    (e: unknown) => (e instanceof Error ? e.message : String(e))
  );
  ok("没有 page.bin 时不许提 V12", !plainMsg.includes("page.bin"), plainMsg);
  ok("空页面那句也说清了什么坏了、下一步做什么", plainMsg.includes("没有可读的页面") && plainMsg.includes("另存"), plainMsg);
}

if (!existsSync(FIXTURE)) {
  skip("emmx 往返", `找不到样本 ${FIXTURE}`);
} else {
  const bytes = new Uint8Array(readFileSync(FIXTURE));

  // --- ZIP
  const entries = await readZip(bytes);
  ok("ZIP 读到 5 类条目", entries.length >= 10, `实际 ${entries.length}`);
  const names = entries.map((e) => e.name);
  ok(
    "ZIP 里有 page/page.xml",
    names.some((n) => /page\/page\.xml$/.test(n)),
    names.join(",")
  );
  ok(
    "ZIP 里保住了中文文件名",
    names.some((n) => /media\/.*\.(png|jpg)/i.test(n) && /[^\x00-\x7f]/.test(n))
  );
  const pageSrc = decodeBytes(entries.find((e) => /page\/page\.xml$/.test(e.name)).data);
  ok("page.xml 体积合理", pageSrc.length > 100_000, String(pageSrc.length));

  // --- XML
  const root = parseXml(pageSrc);
  eq("根标签是 Page", root.tag, "Page");
  eq("页面 ID", attr(root, "ID"), "100");
  const xmlShapes = findAll(root, "Shape");
  eq("Shape 总数与实测一致", xmlShapes.length, 163);
  const connectors = xmlShapes.filter((s) => attr(s, "Type") === "MMConnector");
  eq("缓存连线数量", connectors.length, 81);
  ok("解析器可幂等：再序列化再解析结构等价", nodeEquals(parseXml(pageSrc), root));

  // --- 模型
  const { doc, warnings } = await parseEmmx(bytes);
  const page = doc.pages[0];
  ok("解析无告警", warnings.length === 0, warnings.join(" | "));
  eq("模型里的主题数（去掉缓存连线）", Object.keys(page.shapes).length, 82);
  eq("中心主题类型", page.shapes[page.rootId].type, "MainIdea");
  ok("中心主题有文字", page.shapes[page.rootId].text.paragraphs.length > 0);
  eq("media 资源数", Object.keys(doc.media).length, 7);

  // 双向索引一致性
  let badParent = 0;
  let badChild = 0;
  for (const s of Object.values(page.shapes)) {
    if (s.parentId && !page.shapes[s.parentId]) badParent += 1;
    for (const c of s.childIds) {
      if (!page.shapes[c] || page.shapes[c].parentId !== s.id) badChild += 1;
    }
  }
  eq("所有 parentId 指向存在的节点", badParent, 0);
  eq("所有 childIds 与子的 parentId 对得上", badChild, 0);
  const rootCount = Object.values(page.shapes).filter((s) => s.type === "MainIdea").length;
  eq("只有一个中心主题", rootCount, 1);
  eq("主分支数", page.shapes[page.rootId].childIds.length, 5);

  // --- 亿图原生的加粗看得出来（01 A-16）：那一位写在 Character@Style 上，层级推不出来
  {
    let refBold = 0;
    let deep = 0;
    let missed = 0;
    const ids: string[] = [];
    for (const p of doc.pages)
      for (const s of Object.values(p.shapes)) {
        if (!usedCharIx(s.text).some((ix) => s.text.characters[ix]?.bold === true)) continue;
        refBold++;
        if (levelOf(p, s.id) >= 2) deep++;
        if (!styleFor(p, s).font.bold) {
          missed++;
          if (ids.length < 8) ids.push(`${s.id}@L${levelOf(p, s.id)}`);
        }
      }
    // 这份样张 82 颗主题里 24 颗被亿图标了粗，其中 18 颗是二级以下 ——
    // 那 18 颗正是"按层级推默认字重"覆盖不到的部分，只能从 Character@Style 读。
    eq("真样张里被引用的原生加粗数量", refBold, 24);
    eq("其中层级推导给不出来的那些（二级及以下）", deep, 18);
    ok("导入后一颗都不许看不出来", missed === 0, `算丢 ${missed}：${ids.join(",")}`);
  }

  // --- 亿图给每一颗文字盒都写了中心锚（01 A-18 的底数：锚住在 `<Text><Transform><CX/CY>`）
  //     这条钉的是"居中假设"值不值：居中只能对上一部分，其余那些内缩本来就不对称。
  {
    let boxes = 0;
    let noAnchor = 0;
    let zeroAnchor = 0;
    let centered = 0;
    let worst = 0;
    const offenders: { id: string; pad: number; half: number }[] = [];
    for (const s of xmlShapes) {
      const textNode = findAll(s, "Text")[0];
      if (!textNode) continue;
      const xf = findAll(textNode, "Transform")[0];
      if (!xf) continue;
      boxes += 1;
      const cx = numVnode(xf, "CX", NaN);
      const cy = numVnode(xf, "CY", NaN);
      if (Number.isNaN(cx) || Number.isNaN(cy)) {
        noAnchor += 1;
        continue;
      }
      if (cx === 0 && cy === 0) zeroAnchor += 1;
      const sw = numVnode(findAll(s, "Transform")[0], "Width", NaN);
      const tw = numVnode(xf, "Width", NaN);
      const pad = cx - tw / 2;
      const half = (sw - tw) / 2;
      const gap = Math.abs(pad - half);
      if (gap < 0.001) centered += 1;
      if (gap > worst) worst = gap;
      if (gap > 1) offenders.push({ id: attr(s, "ID") ?? "", pad, half });
    }
    eq("这一份里带文字盒的形状", boxes, 82);
    eq("没有锚点的（亿图不这么写）", noAnchor, 0);
    eq("锚点写成 0 的 —— 那是我们旧写手发明的值，真文件里一个都没有", zeroAnchor, 0);
    // 只有 58/82 恰好居中；20 颗差 ±0.2/±0.8（亿图自己的取整与不对称内缩），
    // 4 颗差到 9.7（文字靠左排、盒子右边留一大截白）。照"形状盒中心"写会把这 24 颗的锚点全改掉 ——
    // 所以这条规则只能"从原节点反推内缩"，不能猜居中。
    eq("按形状盒居中对得上的颗数", centered, 58);
    eq("明显偏离居中的颗数（>1pt）", offenders.length, 4);
    ok(
      "偏离的那几颗全都偏左（pad < 半边），不是随机散布",
      offenders.every((o) => o.pad < o.half),
      offenders.map((o) => `${o.id} pad=${o.pad.toFixed(1)} 居中=${o.half.toFixed(1)}`).join(",")
    );
    eq("最大偏离（pt）", worst.toFixed(1), "9.7");
  }

  // --- 保存：未编辑的文件必须原样回写
  const saved = await writeEmmx(doc);
  const reEntries = await readZip(saved);
  const rePage = reEntries.find((e) => /page\/page\.xml$/.test(e.name));
  ok("保存后仍含 page.xml", Boolean(rePage));
  const a = parseXml(pageSrc);
  const b = parseXml(decodeBytes(rePage.data));
  ok("保存后的 page.xml 与原文件结构等价", nodeEquals(a, b));
  ok(
    "document.xml 也结构等价",
    nodeEquals(
      parseXml(decodeBytes(entries.find((e) => e.name === "document.xml").data)),
      parseXml(decodeBytes(reEntries.find((e) => e.name === "document.xml").data))
    )
  );

  // --- 真按"保存"的语义走一次。app 落盘时会盖 ModifiedDate，上面的"复用原节点"快速通道就此失效，
  //     重新生成的那份必须还是亿图的写法 —— 它读不回去的属性，等于我们把别人的文件改坏了。
  const stamped = {
    ...doc,
    properties: { ...doc.properties, modifiedDate: "2026-01-02 03:04:05" },
  };
  const stEntries = await readZip(await writeEmmx(stamped));
  const stRoot = parseXml(decodeBytes(stEntries.find((e) => e.name === "document.xml").data));
  const stProps = findAll(stRoot, "Properties")[0];
  const stGantt = findAll(stRoot, "GanttOption")[0];
  eq("Version 挂在 <Document> 上", attr(stRoot, "Version"), "7.2");
  eq("DocGuid 挂在 <Document> 上", attr(stRoot, "DocGuid"), doc.properties.docGuid);
  ok(
    "Properties 用的是亿图的子节点 <X V/> 写法",
    stProps.children.length >= 10 && stProps.children.every((c) => c.attrs.V !== undefined),
    `子节点 ${stProps.children.length} 个`
  );
  eq("Platform 保持源写法而不是 Windows", vnode(stProps, "Platform"), "win");
  eq(
    "CreatedDate 没有被写成 CreatedData",
    vnode(stProps, "CreatedDate"),
    doc.properties.createdDate
  );
  eq("ModifiedDate 写的是保存那一刻", vnode(stProps, "ModifiedDate"), "2026-01-02 03:04:05");
  eq("Dpi 按亿图的标签名读回来了", vnode(stProps, "Dpi"), String(doc.properties.dpi));
  ok("没有建模的 ModifyPlatform 原样带回", vnode(stProps, "ModifyPlatform") === "win");
  ok("没有建模的 ChangeMinor 原样带回", vnode(stGantt, "ChangeMinor") === "0");
  const stNames = new Set(stEntries.map((e) => e.name));
  const lost = [...new Set(entries.map((e) => e.name))].filter((n) => !stNames.has(n));
  ok("保存没有丢掉任何一个 entry", lost.length === 0, `丢了 ${lost.join("、")}`);

  // 亿图还会在包里放一张 thumbnail.jpeg 给"打开"对话框做预览。它不属于任何 Shape，
  // 但整条 entry 消失就是消失 —— doc1 恰好没有，只能自己拼一份。
  const withThumb = await writeZip([
    ...entries,
    { name: "thumbnail.jpeg", data: new Uint8Array([255, 216, 255, 217]) },
  ]);
  const thumbSaved = await readZip(await writeEmmx((await parseEmmx(withThumb)).doc));
  const thumbEntry = thumbSaved.find((e) => e.name === "thumbnail.jpeg");
  ok("thumbnail 按原字节带回", thumbEntry?.data.length === 4, String(thumbEntry?.data.length));

  // --- 再解析一次，模型语义等价
  const again = await parseEmmx(saved);
  ok("write→parse 模型等价", modelEquals(doc, again.doc));

  // --- 编辑后只有被改的节点重新生成
  const editedPage = updateText(page, page.shapes[page.rootId].childIds[0], "改过的分支");
  const editedDoc = {
    ...doc,
    pages: doc.pages.map((p) => (p.id === editedPage.id ? editedPage : p)),
  };
  const saved2 = await writeEmmx(editedDoc);
  const re2 = await readZip(saved2);
  const p2 = parseXml(decodeBytes(re2.find((e) => /page\/page\.xml$/.test(e.name)).data));
  const shapes2 = findAll(p2, "Shape");
  eq("编辑后 Shape 数量不变", shapes2.length, 163);
  ok(
    "编辑命中的那个分支文本已更新",
    decodeBytes(re2.find((e) => /page\/page\.xml$/.test(e.name)).data).includes("改过的分支")
  );
  const roundEdited = await parseEmmx(saved2);
  const rp = roundEdited.doc.pages[0];
  eq("编辑结果可再读回", rp.shapes[rp.rootId].childIds[0], page.shapes[page.rootId].childIds[0]);
  const editedBack = Object.values(rp.shapes).find((s) => plainText(s.text) === "改过的分支");
  ok("编辑后的文本在重读时仍在", Boolean(editedBack));

  // --- 发号：亿图把主题与缓存连线交叉编号，新主题不能撞上任何已用 ID
  const usedIds = new Set(xmlShapes.map((s) => attr(s, "ID")));
  const added = insertChild(page, page.rootId, "新分支").page;
  ok("页面记住了连线的 ID 水位", (added.maxShapeId ?? 0) >= 103, String(added.maxShapeId));
  const fresh = Object.keys(added.shapes).filter((i) => !(i in page.shapes));
  eq("只新增一个 Shape", fresh.length, 1);
  ok("新 ID 未与文件里任何 Shape 重号", !usedIds.has(fresh[0]), fresh[0]);

  // --- 布局码：亿图语料里 <Layout V> 出现过 6 / 7 / 8，我们只认 6 和 8。
  //   认不出的码必须原样带回 —— 否则"打开别人的文件再保存一次"就把 7 悄悄改成 6。
  //   只盯 <Layout V="n"/> 这一个元素：文件里另有 <LayoutMemory V="7">，整串 includes 会误判。
  const vOf = (xml: string) => /<Layout V="(\d+)"/.exec(xml)?.[1];
  const origV = vOf(pageSrc);
  ok("样本里确实带 <Layout V>", Boolean(origV));
  eq("未改布局时 <Layout V> 一字不动", vOf(decodeBytes(rePage.data)), origV);
  // 改间距会触发整页重新生成，这时才看得出码有没有被降级。
  const foreignPage = {
    ...updateText(page, page.shapes[page.rootId].childIds[0], "布局码"),
    layout: { ...page.layout, rawCode: 7, hSpacing: page.layout.hSpacing + 1 },
  };
  const withPages = (p: Page) => ({ ...doc, pages: doc.pages.map((x) => (x.id === p.id ? p : x)) });
  const foreignXml = decodeBytes(
    (await readZip(await writeEmmx(withPages(foreignPage)))).find((e) =>
      /page\/page\.xml$/.test(e.name)
    ).data
  );
  eq("陌生码 V=7 原样写回，不降级成 6", vOf(foreignXml), "7");
  eq(
    "重读时仍记得这个陌生码",
    (await parseEmmx(await writeEmmx(withPages(foreignPage)))).doc.pages[0].layout.rawCode,
    7
  );
  // 反过来：用户在界面上真的换过布局，就不能再抱着旧码不放。
  const switchedPage = {
    ...foreignPage,
    layout: { ...foreignPage.layout, code: "logicRight" as const },
  };
  const switchedXml = decodeBytes(
    (await readZip(await writeEmmx(withPages(switchedPage)))).find((e) =>
      /page\/page\.xml$/.test(e.name)
    ).data
  );
  eq("改过布局后按新码写回", vOf(switchedXml), "8");

  // --- StyleMask：实测 doc1 的 82 个主题**每一个**都带 <StyleMask V>（43 个 V=2、39 个 V=3）。
  //   位 0 = 填充是用户自己挑的，换主题不该再动它。
  const maskInFile = new Map<string, number>();
  for (const n of xmlShapes) {
    if (attr(n, "Type") === "MMConnector") continue;
    maskInFile.set(attr(n, "ID"), numVnode(n, "StyleMask", 0));
  }
  eq("样本主题数", maskInFile.size, 82);
  eq(
    "文件里的 <StyleMask> 全部读进模型",
    Object.values(page.shapes).filter((s) => (s.style.mask ?? 0) !== (maskInFile.get(s.id) ?? 0))
      .length,
    0
  );

  const pinnedId = page.shapes[page.rootId].childIds[0];
  const colored = updateStyle(page, pinnedId, {
    fill: { type: "Solid", color: { v: "#c00000" } },
    mask: (page.shapes[pinnedId].style.mask ?? 0) | 1,
  });
  const rt = (await parseEmmx(await writeEmmx(withPages(colored)))).doc.pages[0];
  eq("自定义配色存住了", rt.shapes[pinnedId].style.fill?.color?.v, "#c00000");
  ok(
    "独立配色那一位存住了",
    ((rt.shapes[pinnedId].style.mask ?? 0) & 1) !== 0,
    String(rt.shapes[pinnedId].style.mask)
  );
  const after = applyPalette(rt);
  eq("换主题盖不掉用户自己挑的颜色", after.shapes[pinnedId].style.fill?.color?.v, "#c00000");
  const recolor = Object.keys(after.shapes).filter(
    (id) =>
      ((rt.shapes[id].style.mask ?? 0) & 1) === 0 &&
      after.shapes[id].style.fill?.color?.v !== rt.shapes[id].style.fill?.color?.v
  ).length;
  ok("换主题会重算未独立配色的主题", recolor > 0, String(recolor));

  // --- Shape 上我们不重建的子元素。改一个主题的正文会让整份节点重新生成，
  //     这时批注 / 超链接 / 任何还没建模的标签都不能被顺手抹掉。
  //     真实语料里这三样一个都没有（5 份文档 0 个 Shape 带 Comment），所以按读侧认得的写法造。
  const node = (
    tag: string,
    attrs: Record<string, string> = {},
    children: XmlNode[] = []
  ): XmlNode => ({
    tag,
    attrs,
    children,
    text: "",
  });
  const rawNodes = (p: Page) => (p.rawUnknown as { nodes: Record<string, XmlNode> }).nodes;
  const keyOf = (id: string) => Object.keys(rawNodes(page)).find((k) => k.endsWith(`:${id}`)) ?? "";
  const noteId = page.shapes[page.rootId].childIds[0];
  const linkId = page.shapes[page.rootId].childIds[1];
  const labelId = page.shapes[page.rootId].childIds[2];
  ok("样本里能找到该主题的原节点", keyOf(noteId).length > 0, noteId);
  const withKids = (id: string, ...kids: XmlNode[]) => {
    const src = rawNodes(page)[keyOf(id)];
    return { ...src, children: [...src.children, ...kids] };
  };

  // 模型侧要一起补上 extras：真实情况是"读文件时读侧就把批注/超链接填进了模型"，
  // 只改 raw 不改模型等于凭空造出一个解析不出来的状态，回写时必然对不上值。
  const seeded: Page = (() => {
    const withRaw: Page = {
      ...page,
      rawUnknown: {
        ...(page.rawUnknown as object),
        nodes: {
          ...rawNodes(page),
          [keyOf(noteId)]: withKids(
            noteId,
            node("Comment", {}, [node("Text", { V: "原批注" })]),
            node("FutureTag", { V: "9" })
          ),
          [keyOf(linkId)]: withKids(
            linkId,
            node("HyperLink", {}, [node("Address", { V: "https://example.com/a?b=1" })])
          ),
          // 亿图自己写成 "A;B;"（带尾分号），模型读成 ["A","B"]。值没改过时必须原样带回它自己的写法。
          [keyOf(labelId)]: withKids(labelId, node("Labels", {}, [node("V", { V: "原型;草稿;" })])),
        },
      },
    };
    return updateExtras(
      updateExtras(updateExtras(withRaw, noteId, { note: "原批注" }), linkId, {
        hyperlink: { kind: "web", target: "https://example.com/a?b=1" },
      }),
      labelId,
      { labels: ["原型", "草稿"] }
    );
  })();
  const edited = updateText(updateText(seeded, noteId, "改了正文"), linkId, "也改了正文");
  const editedXml = decodeBytes(
    (await readZip(await writeEmmx(withPages(edited)))).find((e) => /page\/page\.xml$/.test(e.name))
      .data
  );
  ok("没建模的元素原样带回", editedXml.includes("FutureTag"));
  ok("没改过的标签保留亿图的尾分号写法", editedXml.includes('V="原型;草稿;"'));
  const back = (await parseEmmx(await writeEmmx(withPages(edited)))).doc.pages[0];
  eq("编辑正文不该抹掉批注", back.shapes[noteId].extras.note, "原批注");
  eq(
    "编辑正文不该抹掉超链接",
    back.shapes[linkId].extras.hyperlink?.target,
    "https://example.com/a?b=1"
  );
  eq("编辑正文不该抹掉标签", (back.shapes[labelId].extras.labels ?? []).join(";"), "原型;草稿");

  const reNoteed = (
    await parseEmmx(await writeEmmx(withPages(updateExtras(back, noteId, { note: "新批注" }))))
  ).doc.pages[0];
  eq("改过的批注按新值写回", reNoteed.shapes[noteId].extras.note, "新批注");
  const dropped = (
    await parseEmmx(await writeEmmx(withPages(updateExtras(reNoteed, noteId, { note: undefined }))))
  ).doc.pages[0];
  eq("界面里删掉的批注不再写回", dropped.shapes[noteId].extras.note, undefined);

  const relabeled = (
    await parseEmmx(await writeEmmx(withPages(updateExtras(back, labelId, { labels: ["已评审"] }))))
  ).doc.pages[0];
  eq("改过的标签按新值写回", (relabeled.shapes[labelId].extras.labels ?? []).join(";"), "已评审");
  const delabeled = (
    await parseEmmx(await writeEmmx(withPages(updateExtras(relabeled, labelId, { labels: [] }))))
  ).doc.pages[0];
  eq("界面里删掉的标签不再写回", delabeled.shapes[labelId].extras.labels, undefined);
}

// ---------------------------------------------------------------- TaskInfo：看板/甘特的任务字段要能过盘（2026-10-10）
// 修复前 extras.task 根本不进 XML —— 用户排好的期、看板的优先级进度，存一次盘全部蒸发。
// TaskInfo 是自造节点（BranchOffset 先例）：亿图读不懂只会忽略。
{
  const base = createDocument("任务字段", "balanced");
  let page = base.pages[0];
  const a = insertChild(page, page.rootId, "甲");
  page = a.page;
  const b = insertChild(page, page.rootId, "乙");
  page = b.page;
  const withPage = (p: Page) => ({
    ...base,
    pages: base.pages.map((x) => (x.id === p.id ? p : x)),
  });
  const MON = new Date(2026, 9, 5).getTime();
  const FRI = new Date(2026, 9, 20).getTime();
  const tasked = updateExtras(page, a.id, {
    task: {
      assignees: ["张三", "李四"],
      progress: 40,
      priority: "high",
      status: "doing",
      tags: ["红"],
      start: MON,
      finish: FRI,
      duration: 15,
      milestone: false,
      deps: [b.id],
    },
  });
  const rtDoc = (await parseEmmx(await writeEmmx(withPage(tasked)))).doc;
  const rt = rtDoc.pages[0];
  const t = rt.shapes[a.id].extras.task;
  ok("任务字段存盘不丢", Boolean(t), JSON.stringify(t));
  eq("枚举与进度", [t?.priority, t?.status, t?.progress], ["high", "doing", 40]);
  eq("起止毫秒", [t?.start, t?.finish], [MON, FRI]);
  eq("工期", t?.duration, 15);
  eq("成员与标签", [t?.assignees, t?.tags], [["张三", "李四"], ["红"]]);
  eq("前置（deps）原样回来", t?.deps, [b.id]);
  eq("没写的里程碑读回 undefined", t?.milestone, undefined);
  ok("没挂任务的主题不凭空长出任务", !rt.shapes[b.id].extras.task);
  const rt2 = (await parseEmmx(await writeEmmx(rtDoc))).doc;
  ok("TaskInfo 往返幂等", modelEquals(rtDoc, rt2));
}

done();

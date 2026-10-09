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
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { done, eq, ok, rejects, skip } from "./_harness.ts";
import { readZip, writeZip, decodeBytes } from "../src/engine/emmx/zip.ts";
import { nodeEquals, parseXml, findAll, attr, numVnode, vnode } from "../src/engine/emmx/xparse.ts";
import type { XmlNode } from "../src/engine/emmx/xparse.ts";
import { modelEquals, parseEmmx, writeEmmx } from "../src/engine/emmx/codec.ts";
import {
  insertChild,
  shiftBranch,
  updateExtras,
  updateStyle,
  updateText,
} from "../src/engine/tree.ts";
import { createDocument } from "../src/model/factory.ts";
import { applyPalette } from "../src/engine/style.ts";
import { plainText } from "../src/types/model.ts";
import type { Page } from "../src/types/model.ts";

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

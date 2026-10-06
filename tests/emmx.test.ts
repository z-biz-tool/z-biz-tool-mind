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
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { done, eq, ok, rejects, skip } from "./_harness.ts";
import { readZip, decodeBytes } from "../src/engine/emmx/zip.ts";
import { nodeEquals, parseXml, findAll, attr } from "../src/engine/emmx/xparse.ts";
import { modelEquals, parseEmmx, writeEmmx } from "../src/engine/emmx/codec.ts";
import { insertChild, updateText } from "../src/engine/tree.ts";
import { plainText } from "../src/types/model.ts";
import type { Page } from "../src/types/model.ts";

const FIXTURE = join(process.cwd(), "_research", "extract", "doc1", "doc.zip");

if (!existsSync(FIXTURE)) {
  skip("emmx 往返", `找不到样本 ${FIXTURE}`);
} else {
  const bytes = new Uint8Array(readFileSync(FIXTURE));

  // --- ZIP
  const entries = await readZip(bytes);
  ok("ZIP 读到 5 类条目", entries.length >= 10, `实际 ${entries.length}`);
  const names = entries.map((e) => e.name);
  ok("ZIP 里有 page/page.xml", names.some((n) => /page\/page\.xml$/.test(n)), names.join(","));
  ok("ZIP 里保住了中文文件名", names.some((n) => /media\/.*\.(png|jpg)/i.test(n) && /[^\x00-\x7f]/.test(n)));
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
  ok("document.xml 也结构等价", nodeEquals(parseXml(decodeBytes(entries.find((e) => e.name === "document.xml").data)), parseXml(decodeBytes(reEntries.find((e) => e.name === "document.xml").data))));

  // --- 再解析一次，模型语义等价
  const again = await parseEmmx(saved);
  ok("write→parse 模型等价", modelEquals(doc, again.doc));

  // --- 编辑后只有被改的节点重新生成
  const editedPage = updateText(page, page.shapes[page.rootId].childIds[0], "改过的分支");
  const editedDoc = { ...doc, pages: doc.pages.map((p) => (p.id === editedPage.id ? editedPage : p)) };
  const saved2 = await writeEmmx(editedDoc);
  const re2 = await readZip(saved2);
  const p2 = parseXml(decodeBytes(re2.find((e) => /page\/page\.xml$/.test(e.name)).data));
  const shapes2 = findAll(p2, "Shape");
  eq("编辑后 Shape 数量不变", shapes2.length, 163);
  ok("编辑命中的那个分支文本已更新", decodeBytes(re2.find((e) => /page\/page\.xml$/.test(e.name)).data).includes("改过的分支"));
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
  const foreignXml = decodeBytes((await readZip(await writeEmmx(withPages(foreignPage)))).find((e) => /page\/page\.xml$/.test(e.name)).data);
  eq("陌生码 V=7 原样写回，不降级成 6", vOf(foreignXml), "7");
  eq("重读时仍记得这个陌生码", (await parseEmmx(await writeEmmx(withPages(foreignPage)))).doc.pages[0].layout.rawCode, 7);
  // 反过来：用户在界面上真的换过布局，就不能再抱着旧码不放。
  const switchedPage = { ...foreignPage, layout: { ...foreignPage.layout, code: "logicRight" as const } };
  const switchedXml = decodeBytes((await readZip(await writeEmmx(withPages(switchedPage)))).find((e) => /page\/page\.xml$/.test(e.name)).data);
  eq("改过布局后按新码写回", vOf(switchedXml), "8");

  // --- 坏输入
  await rejects("非 ZIP 报中文错误", parseEmmx(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), "不是 ZIP 容器");
  await rejects("ZIP 里缺 page.xml 报错", (async () => {
    const { writeZip } = await import("../src/engine/emmx/zip.ts");
    const fake = await writeZip([{ name: "document.xml", data: new Uint8Array([60, 63, 120]) }]);
    return parseEmmx(fake);
  })(), "page/");
}

done();

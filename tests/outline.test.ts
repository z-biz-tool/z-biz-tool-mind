/**
 * 大纲文本 ⇄ 主题树 的同构（doc/复刻方案/00 §0.3 P-3、§3.6）。
 *
 * 覆盖的缺陷形状：
 * 1) 缩进单位混用（4 空格 / 2 空格 / 制表符）不能改变层级，也不能整行丢；
 * 2) 空行、只有白字符的行、跳层（0 → 3）不能凭空造出父节点；
 * 3) Markdown 的 `- ` `#` `1.` `- [x]` 前缀要剥掉，层级仍由列宽决定；
 * 4) 中文标点（、：（）“”——）与全角空格不能被当成结构字符；
 * 5) 三种插入模式：整棵子树粘贴到某节点之下（appendChildren）、大纲回车（afterSibling）、
 *    编辑态多行粘贴（editPaste：首行替换自身）；
 * 6) dumpOutline → outlineToText → parseOutline 必须是不动点（文本⇄树双向稳定）；
 * 7) Tab / Shift+Tab 多选的顺序敏感性；删一行的连带范围；拖拽落点。
 *
 * 每个分组都用 createPage 现搭一棵树，互不影响（同 tests/tree.test.ts 的写法）。
 */
import { done, eq, ok } from "./_harness.ts";
import { createPage } from "../src/model/factory.ts";
import { insertChild, setCollapsed, setFloating } from "../src/engine/tree.ts";
import {
  dumpOutline,
  indentRange,
  insertOutline,
  moveBetweenLines,
  normalizeLevels,
  outlineToText,
  parseOutline,
  removeSubtree,
  type OutlineLine,
} from "../src/engine/outline.ts";
import { outlineRows } from "../src/engine/projections.ts";
import { plainText } from "../src/types/model.ts";
import type { Page } from "../src/types/model.ts";

const T = "\t";
const S4 = "    ";
const S2 = "  ";
const shape = (lines: OutlineLine[]): string => lines.map((l) => `${l.level}:${l.text}`).join("|");
/** 按 level 铺回带缩进的文本（level 0 不带缩进）。 */
const weave = (lines: OutlineLine[], unit = S4): string => lines.map((l) => unit.repeat(l.level) + l.text).join("\n");

// ---------------------------------------------------------------- 解析：列宽 + 栈
{
  eq("无缩进即同级兄弟", shape(parseOutline("甲\n乙\n丙")), "0:甲|0:乙|0:丙");
  eq("四空格一级", shape(parseOutline(["甲", `${S4}乙`, `${S4}${S4}丙`, `${S4}丁`, "戊"].join("\n"))), "0:甲|1:乙|2:丙|1:丁|0:戊");
  eq("两空格一级", shape(parseOutline(`甲\n${S2}乙\n${S2}${S2}丙`)), "0:甲|1:乙|2:丙");
  eq("CRLF 与单个 CR 都算换行", shape(parseOutline(`甲\r\n${S4}乙\r丙`)), "0:甲|1:乙|0:丙");
  eq("空行与纯白字符行跳过但不丢层级", shape(parseOutline(`甲\n\n${S4}乙\n${T}\n   \n${S4}丙\n丁`)), "0:甲|1:乙|1:丙|0:丁");
  eq("跳层压平（0 → 3 记成 1）", shape(parseOutline(`甲\n${S4}${S4}${S4}乙`)), "0:甲|1:乙");
  // indentColumns 必须同时回"列宽"和"字符数"：只回列宽去 slice 就会把制表符缩进的整行吃掉。
  // 亿图的复制粘贴与 dumpOutline 全用制表符，那一处写错就是 P-3 整条链路失效 —— 锁死。
  eq("制表符缩进的行不能整行丢弃", shape(parseOutline(`中心\n${T}甲\n${T}${T}乙`)), "0:中心|1:甲|2:乙");
  eq("制表符与空格混用要都在", shape(parseOutline(`甲\n${S2}乙\n${T}丙`)), "0:甲|1:乙|2:丙");
  // 缩进吃掉的是行首；行中间的制表符是杂散空白，留在主题里会让画布/SVG/PDF 三条绘制路径各自解释（P-2）。
  eq("行内制表符折成单个空格", parseOutline(`甲\n${T}乙${T}备注${T}${T}(标签)`)[1]?.text, "乙 备注 (标签)");
  eq("折完再走一遍文本⇄树仍是同一个形状", shape(parseOutline(weave(parseOutline(`甲\n${T}乙\t丙`)))), "0:甲|1:乙 丙");
}

// ---------------------------------------------------------------- normalizeLevels
{
  eq("逐级封顶", shape(normalizeLevels([{ level: 0, text: "甲" }, { level: 4, text: "乙" }, { level: 2, text: "丙" }, { level: 0, text: "丁" }])), "0:甲|1:乙|2:丙|0:丁");
  eq("负层级归零", normalizeLevels([{ level: -3, text: "甲" }])[0]?.level, 0);
}

// ---------------------------------------------------------------- Markdown 前缀
{
  eq("`#` 的井号数即层级", shape(parseOutline("# 甲\n## 乙\n### 丙", true)), "0:甲|1:乙|2:丙");
  eq("有序列表编号与勾选框都剥掉", `${parseOutline("3. 第七项", true)[0]?.text}/${parseOutline("- [x] 已完成", true)[0]?.text}`, "第七项/已完成");
  eq("未开 markdown 开关时前缀原样保留", parseOutline("- 甲")[0]?.text, "- 甲");
  eq("Markdown 层级仍由列宽决定", shape(parseOutline(`- 甲\n${S2}- 乙\n${S2}${S2}- 丙`, true)), "0:甲|1:乙|2:丙");
}

// ---------------------------------------------------------------- 中文与标点
{
  eq("中文标点原样保留", parseOutline(`甲、乙（丙）：丁\n${S4}“引号”与——破折号`)[1]?.text, "“引号”与——破折号");
  eq("全角冒号不是结构符", shape(parseOutline(`主题：子\n${S4}值：1`)), "0:主题：子|1:值：1");
  eq("全角空格按普通字符（不算缩进）", parseOutline("　甲")[0]?.text, "　甲");
}

// ---------------------------------------------------------------- appendChildren：整棵子树粘贴到某节点之下
{
  let pg = createPage("粘贴");
  const first = insertChild(pg, pg.rootId, "分支");
  pg = first.page;
  const r = insertOutline(pg, first.id, `甲\n${S4}乙\n${S4}${S4}丙\n${S4}丁`, "appendChildren");
  pg = r.page;
  eq("首行成为目标的子", pg.shapes[first.id].childIds[0], r.ids[0]);
  eq("新增节点数", r.ids.length, 4);
  eq("粘贴后的树形状", shape(dumpOutline(pg)), "0:中心主题|1:分支|2:甲|3:乙|4:丙|3:丁");
  eq("余行按相对层级挂对父", pg.shapes[r.ids[2]]?.parentId, r.ids[1]);
  eq("深层仍是 SubTopic", pg.shapes[r.ids[2]]?.type, "SubTopic");
  eq("大纲投影行数一致", outlineRows(pg).length, dumpOutline(pg).length);
}

// ---------------------------------------------------------------- afterSibling：大纲面板回车
{
  let pg = createPage("回车");
  const b1 = insertChild(pg, pg.rootId, "一");
  pg = b1.page;
  const b2 = insertChild(pg, pg.rootId, "二");
  pg = b2.page;
  const r = insertOutline(pg, b1.id, `新甲\n${S4}新甲子`, "afterSibling");
  pg = r.page;
  eq("插在目标之后而不是之下", pg.shapes[pg.rootId].childIds.indexOf(r.ids[0]), pg.shapes[pg.rootId].childIds.indexOf(b1.id) + 1);
  eq("余行挂到新兄弟下", pg.shapes[r.ids[1]]?.parentId, r.ids[0]);
  eq("大纲形状", shape(dumpOutline(pg)), "0:中心主题|1:一|1:新甲|2:新甲子|1:二");
  const atRoot = insertOutline(pg, pg.rootId, "X", "afterSibling");
  eq("中心主题没有兄弟，afterSibling 退化为追加", atRoot.page.shapes[pg.rootId].childIds[atRoot.page.shapes[pg.rootId].childIds.length - 1], atRoot.ids[0]);
}

// ---------------------------------------------------------------- editPaste：编辑态多行粘贴
{
  let pg = createPage("多行粘贴");
  const b1 = insertChild(pg, pg.rootId, "一");
  pg = b1.page;
  const b2 = insertChild(pg, pg.rootId, "二");
  pg = b2.page;
  const r = insertOutline(pg, b2.id, `改后的二\n${S4}甲\n${S4}${S4}乙\n丙`, "editPaste");
  pg = r.page;
  eq("首行替换目标自身文本", plainText(pg.shapes[b2.id].text), "改后的二");
  eq("返回的第一个 id 就是目标", r.ids[0], b2.id);
  eq("余行不会比目标更浅", pg.shapes[b2.id].childIds.includes(r.ids[1]), true);
  eq("editPaste 形状", shape(dumpOutline(pg)), "0:中心主题|1:一|1:改后的二|2:甲|3:乙|2:丙");
  const single = insertOutline(pg, b1.id, "只有一行", "editPaste");
  eq("单行粘贴只改文本不加节点", Object.keys(single.page.shapes).length, Object.keys(pg.shapes).length);
}

// ---------------------------------------------------------------- 空输入 / 脏目标
{
  const pg = createPage("脏");
  eq("全空白文本是空操作", insertOutline(pg, pg.rootId, "\n   \n\t\n", "appendChildren").ids.length, 0);
  eq("未知目标不新增节点", insertOutline(pg, "99999", "甲", "appendChildren").ids.length, 0);
  ok("未知目标原页返回", insertOutline(pg, "99999", "甲", "appendChildren").page === pg);
}

// ---------------------------------------------------------------- 文本 ⇄ 树 不动点（P-3 正题）
{
  const pg = createPage("往返");
  const text = ["中心主题", `${S4}需求`, `${S4}${S4}PRD 文档`, `${S4}${S4}UI 稿`, `${S4}开发`, "测试"].join("\n");
  const lines = parseOutline(text);
  eq("解析出的行", shape(lines), "0:中心主题|1:需求|2:PRD 文档|2:UI 稿|1:开发|0:测试");
  const body = weave(lines.slice(1));
  const built = insertOutline(pg, pg.rootId, body, "appendChildren").page;
  eq("建出来的树与文本同构", shape(dumpOutline(built)), "0:中心主题|1:需求|2:PRD 文档|2:UI 稿|1:开发|1:测试");
  eq("outlineToText 用空格缩进可还原", outlineToText(built, S4), ["中心主题", `${S4}需求`, `${S4}${S4}PRD 文档`, `${S4}${S4}UI 稿`, `${S4}开发`, `${S4}测试`].join("\n"));
  eq("解析-导出是不动点", shape(parseOutline(outlineToText(built, S4))), shape(dumpOutline(built)));
  eq("默认（制表符）缩进的往返", shape(parseOutline(outlineToText(built))), shape(dumpOutline(built)));
}

// ---------------------------------------------------------------- dumpOutline 的取文与浮动主题
{
  const pg = createPage("取文");
  const one = insertChild(pg, pg.rootId, "甲");
  const q = one.page;
  const chars = q.shapes[one.id].text.characters;
  const twoRun: Page = {
    ...q,
    shapes: {
      ...q.shapes,
      [one.id]: { ...q.shapes[one.id], text: { characters: chars, paragraphs: [{ runs: [{ text: "前半", charIx: 0 }, { text: "后半", charIx: 0 }], align: 1 }] } },
    },
  };
  eq("同段多 run 拼接", dumpOutline(twoRun)[1]?.text, "前半后半");
  const twoPara: Page = {
    ...q,
    shapes: {
      ...q.shapes,
      [one.id]: {
        ...q.shapes[one.id],
        text: { characters: chars, paragraphs: [{ runs: [{ text: "上行", charIx: 0 }], align: 1 }, { runs: [{ text: "下行", charIx: 0 }], align: 1 }] },
      },
    },
  };
  eq("模型里两段 = plainText 带换行", plainText(twoPara.shapes[one.id].text), "上行\n下行");
  // 引擎缺陷：dumpOutline 用 "" 连接多个段落（plainText 用 "\n"），段间换行在大纲文本里被吞掉，
  // 两段主题复制出来变成一行，粘回去就少一个主题（P-3 文本⇄树同构被破坏）
  eq("多段主题的大纲文本要保留段间换行", dumpOutline(twoPara)[1]?.text, "上行\n下行");
  const kid = insertChild(q, one.id, "子");
  const float = setFloating(kid.page, kid.id, 30, 30, true);
  eq("浮动主题从 0 级另起一段", shape(dumpOutline(float)), "0:中心主题|1:甲|0:子");
  const folded = setCollapsed(kid.page, one.id, true);
  eq("折叠后 outlineRows 只剩可见行", outlineRows(folded).length, 2);
  // 引擎缺陷：同一个"大纲"投影有两份实现且结果不同 —— dumpOutline/outlineToText 走 childIds（折叠无效），
  // outlineRows 走 visibleChildren；复制成文本的行数与大纲面板看到的行数不一致（违 P-1 一棵树六个投影）
  eq("大纲文本与大纲投影在折叠下必须一致", dumpOutline(folded).length, outlineRows(folded).length);
}

// ---------------------------------------------------------------- removeSubtree / moveBetweenLines
{
  let pg = createPage("删行");
  const b1 = insertChild(pg, pg.rootId, "一");
  pg = b1.page;
  const k1 = insertChild(pg, b1.id, "k1");
  pg = k1.page;
  const k2 = insertChild(pg, b1.id, "k2");
  pg = k2.page;
  const g1 = insertChild(pg, k1.id, "g1");
  pg = g1.page;
  eq("删一行连子树一起删", shape(dumpOutline(removeSubtree(pg, k1.id))), "0:中心主题|1:一|2:k2");
  eq("删叶子只少一个", Object.keys(removeSubtree(pg, k2.id).shapes).length, Object.keys(pg.shapes).length - 1);
  // 引擎缺陷：removeSubtree 对中心主题同样生效（整页主题被清空），与 tree.removeShape "中心主题不可删"的语义不一致；
  // 大纲面板把第一行删掉 = 整张图消失
  eq("中心主题删不掉（与 removeShape 同语义）", Object.keys(removeSubtree(pg, pg.rootId).shapes).length, Object.keys(pg.shapes).length);
  eq("拖成子级", moveBetweenLines(pg, g1.id, k2.id, true).shapes[g1.id].parentId, k2.id);
  const asSib = moveBetweenLines(pg, g1.id, k2.id, false);
  eq("拖成平级挂到目标的父下", asSib.shapes[g1.id].parentId, b1.id);
  eq("平级插入落在目标行之前", asSib.shapes[b1.id].childIds.indexOf(g1.id), asSib.shapes[b1.id].childIds.indexOf(k2.id) - 1);
  let p3 = createPage("同级拖");
  const h = insertChild(p3, p3.rootId, "一");
  p3 = h.page;
  const a = insertChild(p3, h.id, "A");
  p3 = a.page;
  const b = insertChild(p3, h.id, "B");
  p3 = b.page;
  const c = insertChild(p3, h.id, "C");
  p3 = c.page;
  const fwd = moveBetweenLines(p3, a.id, b.id, false).shapes[h.id].childIds;
  const back = moveBetweenLines(p3, c.id, b.id, false).shapes[h.id].childIds;
  // 引擎缺陷：插入位是按"摘除拖拽节点之前"的 childIds 取的 indexOf(overId)，没有减掉自己 ——
  // 把 A 往后拖到 B 那一行落到 B 之后，把 C 往前拖到同一行却落到 B 之前，同一个落点两种结果
  eq("向前/向后拖到同一行应落在目标的同一侧", fwd.indexOf(a.id) < fwd.indexOf(b.id), back.indexOf(c.id) < back.indexOf(b.id));
}

// ---------------------------------------------------------------- indentRange：Tab / Shift+Tab 多选
{
  let pg = createPage("缩进");
  const kids: string[] = [];
  for (const t of ["k1", "k2", "k3"]) {
    const r = insertChild(pg, pg.rootId, t);
    pg = r.page;
    kids.push(r.id);
  }
  const down = indentRange(pg, [kids[1], kids[2]], 1);
  eq("Tab 多选无跳过", down.skipped, 0);
  eq("Tab 后形状", shape(dumpOutline(down.page)), "0:中心主题|1:k1|2:k2|2:k3");
  eq("Tab 后类型重算为 SubTopic", down.page.shapes[kids[1]].type, "SubTopic");
  const up = indentRange(down.page, [kids[1], kids[2]], -1);
  eq("Shift+Tab 自动倒序处理，相对顺序不变", up.page.shapes[pg.rootId].childIds, [kids[0], kids[1], kids[2]]);
  eq("选中顺序传反就会被反着处理（契约：调用方给升序）", indentRange(down.page, [kids[2], kids[1]], -1).page.shapes[pg.rootId].childIds, [kids[0], kids[2], kids[1]]);
  eq("升完是 MainTopic", up.page.shapes[kids[1]].type, "MainTopic");
  eq("第一个兄弟无处降级", indentRange(pg, [kids[0]], 1).skipped, 1);
}

done();

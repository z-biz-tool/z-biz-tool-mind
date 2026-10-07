/**
 * 方案文件的导出与加载（doc/复刻方案/00 §3.17：右键菜单方案、快捷键整套键位）。
 *
 * 覆盖的缺陷形状：
 * 1) 往返必须等价 —— 导出的那份加载回来应当还是那份，否则"换台机器用我的方案"就退化成
 *    "换台机器再手改一遍"；
 * 2) 空菜单列表 = 全部显示。这条约定不能被文件里的一串 Action 顶掉，也不能反过来被读成空菜单；
 * 3) 加载不许抢键。撞车的表看起来就是"我导入了方案，Ctrl+S 却还在开别的"，而真正生效的那一条
 *    取决于表里谁后建 —— 这种故障在配置文件里看不出任何痕迹。成对调换是合法改动，得加载得进来；
 * 4) 换机器多半等于换版本：认不出的动作键、认不出的命令、写坏的键串都只能跳过，并且要说清跳过了什么；
 * 5) 走错分页的文件、根节点不对的文件要报错，不能当成"空方案"默默加载进去。
 */
import { done, eq, ok, throws } from "./_harness.ts";
import { MENU_ACTION_GROUPS } from "../src/canvas/menuActions.ts";
import {
  keymapProfileXml,
  menuProfileXml,
  parseProfile,
  type Profile,
} from "../src/services/profileIO.ts";
import { SHORTCUT_COMMANDS, defaultChordOf } from "../src/utils/shortcuts.ts";

const COMMANDS = SHORTCUT_COMMANDS.map((c) => c.cmd);

const menuOf = (p: Profile) => (p.kind === "rightMenu" ? p.enabled : null);
const keysOf = (p: Profile) => (p.kind === "shortcut" ? p.custom : null);
const skipped = (p: Profile) => p.skipped;
const mapText = (m: Record<string, string> | null) =>
  Object.entries(m ?? {})
    .sort()
    .map(([k, v]) => `${k}=${v}`)
    .join(",");

/**
 * 主键位表里有没有两条命令撞上同一个键。
 * 别名（Ctrl+Y）不查：rebuildLookup 先写别名再写主键，新主人一定压得过它，那不是故障。
 */
function collided(custom: Record<string, string>): string[] {
  const owners = new Map<string, string[]>();
  for (const cmd of COMMANDS) {
    const chord = custom[cmd] ?? defaultChordOf(cmd);
    if (!chord) continue;
    owners.set(chord, [...(owners.get(chord) ?? []), cmd]);
  }
  return [...owners].filter(([, v]) => v.length > 1).map(([c, v]) => `${c}:${v.join("/")}`);
}

const MENU_XML_SHAPE = /k="([^"]+)"/g;

// ---------- 右键菜单：空 = 全部显示，顺序按菜单 ----------
const allXml = menuProfileXml([]);
ok('空列表写成 mode="all"', allXml.includes('mode="all"'));
ok("全给的文件不列 12 条 Action", !allXml.includes("<Action"));
ok("文件头带着版本号", allXml.includes('version="1"'));
eq("全给加载回来还是空列表（= 全部显示）", menuOf(parseProfile(allXml)), []);
eq("全给的文件没有跳过项", skipped(parseProfile(allXml)), []);

const scrambled = ["edit", "del", "note"];
const subsetXml = menuProfileXml(scrambled);
eq(
  "文件里的顺序是菜单顺序，不是勾选顺序",
  [...subsetXml.matchAll(MENU_XML_SHAPE)].map((m) => m[1]).join(","),
  "del,note,edit"
);
eq("子集往返", menuOf(parseProfile(subsetXml)), ["del", "note", "edit"]);
eq("BOM 开头的文件也读得进来", menuOf(parseProfile(`﻿${subsetXml}`)), ["del", "note", "edit"]);

// 导出方勾选的动作在加载方机器上不存在（版本不同）时：认得的照做，生面孔报一句。
const stale = parseProfile(
  '<ZMindProfile kind="rightMenu" mode="some"><Action k="del"/><Action k="teleport"/></ZMindProfile>'
);
eq("认得的动作照样加载", menuOf(stale), ["del"]);
eq("认不出的动作给一句跳过", skipped(stale).length, 1);
ok("跳过里点名是哪个动作", skipped(stale)[0].includes("teleport"));
throws(
  "整份都是生面孔就报错，不许静默变成空菜单",
  () =>
    parseProfile(
      '<ZMindProfile kind="rightMenu" mode="some"><Action k="teleport"/></ZMindProfile>'
    ),
  "加载了等于清空"
);
throws(
  "没写 mode 又没动作也报错",
  () => parseProfile('<ZMindProfile kind="rightMenu"><Action k=""/></ZMindProfile>'),
  "没写 mode"
);

// ---------- 文件本身对不对 ----------
throws("根节点不是 ZMindProfile 就报错", () => parseProfile("<MindMaster/>"), "根节点不是");
throws(
  "认不出的方案类型就报错",
  () => parseProfile('<ZMindProfile kind="theme"/>'),
  "认不出的方案类型"
);
throws("缺文件的 kind 也报错", () => parseProfile("<ZMindProfile/>"), "没写 kind");

// ---------- 键位：只写改过的，禁用是没有 chord 的那一条 ----------
ok("整套没改过就不写条目", !keymapProfileXml({}).includes("<Key"));
eq("空文件加载回来是空表（= 全用默认键位）", keysOf(parseProfile(keymapProfileXml({}))), {});
const offXml = keymapProfileXml({ search: "" });
ok("禁用写成没有 chord 的那一条", offXml.includes('<Key cmd="search"/>'));
eq("禁用往返", mapText(keysOf(parseProfile(offXml))), mapText({ search: "" }));
eq(
  "值等于默认键的那条不写进文件",
  keymapProfileXml({ save: defaultChordOf("save") }).includes("<Key"),
  false
);

for (const r of [
  { custom: {}, want: {} },
  { custom: { save: "ctrl+alt+s" }, want: { save: "ctrl+alt+s" } },
  // 成对调换：保存挪走，另存为接走 Ctrl+S。这是方案文件里最常见的一类"整套"改动。
  {
    custom: { save: "ctrl+alt+s", saveAs: "ctrl+s" },
    want: { save: "ctrl+alt+s", saveAs: "ctrl+s" },
  },
  { custom: { search: "", print: "ctrl+shift+p" }, want: { search: "", print: "ctrl+shift+p" } },
  // Ctrl+Y 不是 redo 的默认键而是别名，写过一次就得钉住（别名会跟着主键一起消失）。
  { custom: { redo: "ctrl+y" }, want: { redo: "ctrl+y" } },
  // 写回默认键的那条在文件里不该留痕：它等于"这条没改过"。
  {
    custom: { options: "f2", undo: "", redo: defaultChordOf("redo") },
    want: { options: "f2", undo: "" },
  },
]) {
  const back = parseProfile(keymapProfileXml(r.custom));
  eq(`往返 ${mapText(r.want)}`, mapText(keysOf(back)), mapText(r.want));
  eq(`往返 ${mapText(r.want)} 不该有跳过`, skipped(back).length, 0);
  ok(`往返 ${mapText(r.want)} 之后没有撞车`, collided(r.want).length === 0);
}

// ---------- 不抢键 ----------
const steal = parseProfile(
  '<ZMindProfile kind="shortcut"><Key cmd="save" chord="ctrl+o"/></ZMindProfile>'
);
eq("抢别人正在用的键就不加载", mapText(keysOf(steal)), mapText({}));
eq("抢键要给一句说明", skipped(steal).length, 1);
ok("说明要点名还占着这个键的那条命令", skipped(steal)[0].includes("打开"));

const freed = parseProfile(
  '<ZMindProfile kind="shortcut"><Key cmd="open" chord=""/><Key cmd="save" chord="ctrl+o"/></ZMindProfile>'
);
eq(
  "对方在这份方案里被禁用了，位置才是真的空出来",
  mapText(keysOf(freed)),
  mapText({ open: "", save: "ctrl+o" })
);
eq("先禁用再占用不产生撞车", collided(keysOf(freed) ?? {}), []);

const aliasSwap = parseProfile(
  '<ZMindProfile kind="shortcut"><Key cmd="redo" chord=""/><Key cmd="search" chord="ctrl+y"/></ZMindProfile>'
);
eq(
  "禁掉重做之后 Ctrl+Y 可以让给搜索",
  mapText(keysOf(aliasSwap)),
  mapText({ redo: "", search: "ctrl+y" })
);

const clash = parseProfile(
  '<ZMindProfile kind="shortcut"><Key cmd="save" chord="ctrl+shift+s"/><Key cmd="saveAs" chord="ctrl+s"/></ZMindProfile>'
);
eq("互相换位的两条都进不来（宁可不动，也不留撞车）", mapText(keysOf(clash)), mapText({}));
eq("这种情况给两句说明", skipped(clash).length, 2);
ok("撞车加载之后仍然没有撞车", collided(keysOf(clash) ?? {}).length === 0);

// ---------- 生面孔与坏写法 ----------
const badChord = parseProfile(
  '<ZMindProfile kind="shortcut"><Key cmd="save" chord="Ctrl-Shift-S"/><Key cmd="print" chord="ctrl+shift+p"/></ZMindProfile>'
);
eq("不成组合键的那条跳过，好的照做", mapText(keysOf(badChord)), mapText({ print: "ctrl+shift+p" }));
ok(
  "说明里写清是哪条命令、原样是什么",
  skipped(badChord)[0].includes("保存") && skipped(badChord)[0].includes("Ctrl-Shift-S")
);

const foreign = parseProfile(
  '<ZMindProfile kind="shortcut"><Key cmd="zoomIn" chord="ctrl+plus"/></ZMindProfile>'
);
eq("这台机器没有这条命令就跳过", mapText(keysOf(foreign)), mapText({}));
ok("跳过的话说的是命令名", skipped(foreign)[0].includes("zoomIn"));

const dup = parseProfile(
  '<ZMindProfile kind="shortcut"><Key cmd="save" chord="ctrl+alt+s"/><Key cmd="save" chord="ctrl+alt+d"/></ZMindProfile>'
);
eq("同一条命令写两遍只认第一遍", mapText(keysOf(dup)), mapText({ save: "ctrl+alt+s" }));

done();

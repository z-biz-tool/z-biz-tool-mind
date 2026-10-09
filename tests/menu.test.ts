/**
 * 右键菜单的功能集合（doc/复刻方案/00 §293）。
 *
 * 面板和画布共用 menuActions.ts 这一份目录，所以这里盯三件事：
 * 1) 目录本身的完整性 —— 键不能重复（重复会让一个勾裁掉两项），预设里的键必须在目录里；
 * 2) 空 = 全部显示这条约定：config.rs 的默认值就是 { enabled: [] }，老配置缺这一节时
 *    merge_defaults 补出来的也是空，两条路都必须等于"菜单照旧给全套"；
 * 3) 裁剪只减不增、保持顺序：菜单的顺序是 actionsFor 排出来的，面板不该打乱它。
 */
import { done, eq, ok } from "./_harness.ts";
import { MENU_ACTION_GROUPS, MENU_PRESETS, keepActions } from "../src/canvas/menuActions.ts";

const KEYS = MENU_ACTION_GROUPS.map((g) => g.k);

// ---- 目录：键唯一，标签非空
eq("动作目录条数", KEYS.length, 13);
eq("动作键不重复", new Set(KEYS).size, KEYS.length);
ok(
  "每条都有中文标签",
  MENU_ACTION_GROUPS.every((g) => g.label.trim().length > 0)
);
// 画布 actionsFor 实际 push 的那些键（快捷条和菜单同源），一个都不能从目录里漏掉：
// 漏了就是面板上没格子可勾，而菜单里却出现一条去不掉的项。
for (const k of [
  "child",
  "sibling",
  "fold",
  "branch",
  "del",
  "note",
  "edit",
  "callout",
  "boundary",
  "summary",
  "rel",
  "float",
  "fit",
]) {
  ok(`画布用到的动作 ${k} 在目录里`, KEYS.includes(k));
}

// ---- 预设：只能用目录里存在的键
for (const p of MENU_PRESETS) {
  for (const k of p.keys) ok(`预设「${p.label}」的 ${k} 在目录里`, KEYS.includes(k));
  eq(`预设「${p.label}」的键不重复`, new Set(p.keys).size, p.keys.length);
}
eq("预设条数", MENU_PRESETS.length, 2);
ok("默认预设就是空列表（= 全部显示）", MENU_PRESETS[0].keys.length === 0);

// ---- keepActions
const items = MENU_ACTION_GROUPS;

// 空 = 不裁剪：必须是内容相同的新数组，不能把目录本身交出去让人改。
const all = keepActions(items, []);
eq("空白名单给满 13 条", all.length, 13);
ok(
  "空白名单不改原目录",
  items.every((g, i) => all[i] === g)
);
ok("返回的是副本", all !== items);

// 子集裁剪保持传入顺序，而不是白名单里的顺序。
const picked = keepActions(items, ["fit", "child", "del"]);
eq("裁剪后条数", picked.length, 3);
eq("裁剪后顺序 = 菜单顺序", picked.map((g) => g.k).join(","), "child,del,fit");

// 白名单里目录中没有的键只能让菜单变短，不会凭空多出动作。
eq("未知键只会缩小", keepActions(items, ["child", "不存在的键"]).length, 1);
eq("全部是不认识的键则菜单为空", keepActions(items, ["x", "y"]).length, 0);
eq("重复的白名单键不复制条目", keepActions(items, ["child", "child"]).length, 1);

// 极简预设落到画布上应该还剩这几条。
const minimal = MENU_PRESETS[1].keys;
eq(
  "极简预设保留的动作",
  keepActions(items, minimal)
    .map((g) => g.k)
    .join(","),
  minimal
    .slice()
    .sort((a, b) => KEYS.indexOf(a) - KEYS.indexOf(b))
    .join(",")
);

done();

/**
 * 快捷键自定义（doc/复刻方案/00 §3.17「全量可自定义、可禁用、可恢复默认」）。
 *
 * 这一层的坑都在"键串对不上"上：配置文件里写的、面板录到的、监听器算出的必须是同一种形式，
 * 所以断言盯着归一化和查表，而不是盯着 DOM。
 * 1) normalizeChord：大小写、修饰键顺序、裸键、非法修饰键；
 * 2) 覆盖表：改键、禁用、恢复默认、坏值回落默认；
 * 3) 别名 Ctrl+Y 只在重做没被改键时存在，改了就让位给新主人；
 * 4) shortcutLabel 的说法要跟着当前键位走，禁用了不能说还按 Ctrl+S。
 */
import { done, eq, ok } from "./_harness.ts";
import {
  SHORTCUT_COMMANDS,
  aliasChords,
  chordLabel,
  chordOfCommand,
  commandOfChord,
  defaultChordOf,
  effectiveChords,
  normalizeChord,
  setShortcutOverrides,
  shortcutLabel,
} from "../src/utils/shortcuts.ts";

// ---- normalizeChord
eq("大写归小写", normalizeChord("Ctrl+S"), "ctrl+s");
eq("空格不影响", normalizeChord(" ctrl + S "), "ctrl+s");
eq("修饰键按 ctrl→shift→alt 归位", normalizeChord("shift+ctrl+s"), "ctrl+shift+s");
eq("alt 排最后", normalizeChord("alt+shift+x"), "shift+alt+x");
eq("功能键可以不带修饰", normalizeChord("F1"), "f1");
eq("Esc 可以不带修饰", normalizeChord("Esc"), "esc");
eq("escape 归成 esc（和 chordOf 同一种写法）", normalizeChord("ctrl+Escape"), "ctrl+esc");
eq("裸字母不算键位", normalizeChord("A"), null);
eq("裸数字不算键位", normalizeChord("7"), null);
eq("写成 space 绑不了（chordOf 只认那个空白字符键）", normalizeChord("ctrl+space"), null);
eq("不认识的修饰键不行", normalizeChord("ctrl+shift+alt+win+s"), null);
eq("重复修饰键不行", normalizeChord("ctrl+ctrl+s"), null);
eq("只有修饰键不行", normalizeChord("ctrl+shift"), null);
eq("空串不行", normalizeChord(""), null);
eq("数字键可以", normalizeChord("ctrl+1"), "ctrl+1");

// ---- 默认表
eq("列出的命令条数", SHORTCUT_COMMANDS.length, 11);
eq("命令不重复", new Set(SHORTCUT_COMMANDS.map((c) => c.cmd)).size, SHORTCUT_COMMANDS.length);
for (const c of SHORTCUT_COMMANDS) {
  ok(`${c.cmd} 的默认键合规`, normalizeChord(defaultChordOf(c.cmd)) === defaultChordOf(c.cmd));
  ok(`${c.cmd} 有中文名`, c.label.trim().length > 0);
}
eq("默认键位下 Ctrl+S 归保存", commandOfChord("ctrl+s"), "save");
eq("默认键位下 Ctrl+Y 归重做", commandOfChord("ctrl+y"), "redo");
eq("没占用的键返回 null", commandOfChord("ctrl+k"), null);

// ---- 覆盖：改键
setShortcutOverrides({ search: "ctrl+alt+f" });
eq("搜索换成 Ctrl+Alt+F", chordOfCommand("search"), "ctrl+alt+f");
eq("旧键 Ctrl+F 空出来了", commandOfChord("ctrl+f"), null);
eq("新键归搜索", commandOfChord("ctrl+alt+f"), "search");
eq("标签跟着改", shortcutLabel("search"), "Ctrl+Alt+F");
eq("改了别的键不牵连重做的别名", aliasChords("redo").join(","), "ctrl+y");

// ---- 覆盖：改过的命令别名让位
setShortcutOverrides({ redo: "ctrl+y" });
eq("重做按用户按下的那个键", chordOfCommand("redo"), "ctrl+y");
eq("改键之后不再有别名", aliasChords("redo").length, 0);
eq("原来的 Ctrl+Shift+Z 不再发命令", commandOfChord("ctrl+shift+z"), null);
eq("Ctrl+Y 归重做", commandOfChord("ctrl+y"), "redo");

// ---- 覆盖：禁用
setShortcutOverrides({ print: "" });
eq("禁用后没有键", chordOfCommand("print"), null);
eq("禁用标签要说清楚", shortcutLabel("print"), "（已禁用）");
eq("禁用后 Ctrl+P 谁的都不是", commandOfChord("ctrl+p"), null);
ok("禁用不影响其它命令", commandOfChord("ctrl+s") === "save" && commandOfChord("f1") === "options");

// ---- 坏值回落默认：手改配置文件不能把一条命令废掉
setShortcutOverrides({ save: "Ctrl-Minus-S" });
eq("不合规的配置值回落到默认", chordOfCommand("save"), "ctrl+s");
setShortcutOverrides({ save: "ctrl+S" });
eq("大小写写错的配置值归一后照用", chordOfCommand("save"), "ctrl+s");

// ---- 恢复默认 = 把这条从表里摘掉
setShortcutOverrides({});
eq("清空覆盖后搜索回到默认", chordOfCommand("search"), "ctrl+f");
eq("清空覆盖后重做回到默认", chordOfCommand("redo"), "ctrl+shift+z");
eq("清空覆盖后 Ctrl+Y 别名又在了", aliasChords("redo").join(","), "ctrl+y");
eq("恢复默认之后 Ctrl+P 归打印", commandOfChord("ctrl+p"), "print");

// ---- effectiveChords：面板和测试都靠它看全表
const all = effectiveChords();
eq("快照覆盖全部命令", Object.keys(all).length, SHORTCUT_COMMANDS.length);
eq("快照里的值都是合规键串", Object.values(all).filter((v) => v === "").length, 0);
ok(
  "快照与逐条查询一致",
  SHORTCUT_COMMANDS.every((c) => all[c.cmd] === defaultChordOf(c.cmd))
);
setShortcutOverrides({ undo: "" });
eq("快照里禁用记成空串", effectiveChords().undo, "");
setShortcutOverrides({});

// ---- 标签的平台写法（node 里没有 mac 的 platform，这里只断言非 mac 那一路）
eq("Ctrl+Shift+S 的写法", chordLabel("ctrl+shift+s"), "Ctrl+Shift+S");
eq("单功能键不加修饰", chordLabel("f1"), "F1");
eq("esc 显示成 Esc", chordLabel("esc"), "Esc");
eq("不认识的命令原样返回", shortcutLabel("没这条命令"), "没这条命令");

done();

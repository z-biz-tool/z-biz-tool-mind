/**
 * 方案文件的导出与加载（§3.17：右键菜单"配置可导出为 xml 并加载"、快捷键整套键位）。
 *
 * 用 XML 是照亿图来的：换机器时这份文件得先能用人眼读，其次才是给程序读。
 * 解析复用 engine/emmx/xparse 而不是 DOMParser —— 后者是浏览器 API，测试跑在 node 里，
 * 用它的结果是"浏览器里好使、测试全红"那种假故障。
 *
 * 三条约定要记着，它们都是从配置语义来的：
 * - 右键菜单的**空列表 = 全部显示**（config.rs 的默认值就是 `{enabled:[]}`），所以"全给"
 *   写成 mode="all" 而不是列 12 条；否则加载一次方案就把"恢复默认"的状态弄丢了。
 * - 键位文件只写**改过的**那条，所以一份空文件就是"全用默认键位"。禁用写成没有 chord 的
 *   `<Key cmd="…"/>`（el() 会丢掉空属性，正好是自闭合写法），读回来就是空串。
 * - 加载不抢键：一条键位要动的位置如果还被别的命令占着，就跳过这一条并把话说清，
 *   跟选项面板里手动录制同一个口径（OptionsView 的 rebindShortcut）。
 */
import { MENU_ACTION_GROUPS } from "../canvas/menuActions.ts";
import { attr, el, findAll, parseXml, serializeXml, type XmlNode } from "../engine/emmx/xparse.ts";
import {
  ALIASES,
  SHORTCUT_COMMANDS,
  chordLabel,
  defaultChordOf,
  normalizeChord,
  type ShortcutCommand,
} from "../utils/shortcuts.ts";
import { native, pickOpenPath, pickSavePath } from "./native.ts";

const ROOT = "ZMindProfile";
const VERSION = "1";

export type ProfileKind = "rightMenu" | "shortcut";

export interface RightMenuProfile {
  kind: "rightMenu";
  enabled: string[];
  skipped: string[];
}

export interface ShortcutProfile {
  kind: "shortcut";
  custom: Record<string, string>;
  skipped: string[];
}

export type Profile = RightMenuProfile | ShortcutProfile;

const MENU_KEYS = MENU_ACTION_GROUPS.map((g) => g.k);
const COMMANDS = SHORTCUT_COMMANDS.map((c) => c.cmd);
const LABELS: Record<string, string> = Object.fromEntries(
  SHORTCUT_COMMANDS.map((c) => [c.cmd, c.label])
);

const KIND_TEXT: Record<ProfileKind, string> = {
  rightMenu: "右键菜单",
  shortcut: "快捷键",
};

const FILTER = [{ name: "方案文件（XML）", extensions: ["xml"] }];

function labelOf(cmd: string): string {
  return LABELS[cmd] ?? cmd;
}

/** 文件头上的时间只作注释用，不参与判等，所以写成读得懂的本地时间就够了。 */
function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes()
  )}`;
}

function root(kind: ProfileKind, extra: Record<string, string>, children: XmlNode[]): XmlNode {
  return el(ROOT, { kind, version: VERSION, exported: stamp(), ...extra }, children);
}

/** 菜单方案：按菜单顺序写，读的人看到的次序和右键时一致。 */
export function menuProfileXml(enabled: readonly string[]): string {
  const all = enabled.length === 0;
  const kept = all ? [] : MENU_KEYS.filter((k) => enabled.includes(k));
  return serializeXml(
    root(
      "rightMenu",
      { mode: all ? "all" : "some" },
      kept.map((k) => el("Action", { k }))
    ),
    "  "
  );
}

/** 键位方案：只写动过的键；值等于默认键的那条当没改过，别把它钉成"用户动过"。 */
export function keymapProfileXml(custom: Record<string, string>): string {
  const touched = COMMANDS.filter((cmd) => {
    const chord = custom[cmd];
    return chord !== undefined && chord !== defaultChordOf(cmd);
  });
  return serializeXml(
    root(
      "shortcut",
      {},
      touched.map((cmd) => el("Key", { cmd, chord: custom[cmd] }))
    ),
    "  "
  );
}

function mustRoot(text: string): XmlNode {
  let doc: XmlNode;
  try {
    doc = parseXml(text);
  } catch (e) {
    throw new Error(`读不出这份文件：${e instanceof Error ? e.message : String(e)}`);
  }
  // parseXml 在只有一棵树时直接返回那一个元素，有多棵才返回 #document：两种形状都要认。
  const r = doc.tag === ROOT ? doc : doc.children.find((c) => c.tag === ROOT);
  if (!r) throw new Error(`这不是本应用导出的方案文件：根节点不是 ${ROOT}`);
  return r;
}

export function parseProfile(text: string): Profile {
  const r = mustRoot(text);
  const kind = attr(r, "kind");
  if (kind === "rightMenu") return parseMenu(r, attr(r, "mode"));
  if (kind === "shortcut") return parseKeys(r);
  throw new Error(`认不出的方案类型：${kind || "（文件里没写 kind）"}`);
}

function parseMenu(node: XmlNode, mode: string): Profile {
  if (mode === "all") return { kind: "rightMenu", enabled: [], skipped: [] };
  const skipped: string[] = [];
  const enabled: string[] = [];
  for (const a of findAll(node, "Action")) {
    const k = attr(a, "k");
    if (!k) continue;
    if (!MENU_KEYS.includes(k)) {
      skipped.push(`这台机器没有这个菜单动作：${k}`);
      continue;
    }
    if (!enabled.includes(k)) enabled.push(k);
  }
  if (!enabled.length) {
    throw new Error(
      mode === "some"
        ? "这份方案里没有任何本机认得的菜单动作，加载了等于清空。"
        : "这份方案没写 mode，也没有可加载的动作。"
    );
  }
  return { kind: "rightMenu", enabled, skipped };
}

/**
 * 键位方案的合并：按文件里的出现顺序逐条认，谁先占到键就归谁。
 *
 * 占位表（taken）从**当前默认**起步，包括 Ctrl+Y 那个别名；一条命令成功挪走之后才释放它
 * 原来的键，所以"保存挪到 Ctrl+Alt+S、另存为接走 Ctrl+S"这种成对改动加载得进来，
 * 而"两条命令抢同一个键"只会跳过后一条并说清是谁还占着 —— 绝不能让一份文件把某个命令
 * 静默挤掉，那副症状是"我明明导入了方案，Ctrl+S 却还在开别的"。
 */
function parseKeys(node: XmlNode): Profile {
  const skipped: string[] = [];
  const entries: { cmd: ShortcutCommand; chord: string }[] = [];
  for (const k of findAll(node, "Key")) {
    const cmd = attr(k, "cmd") as ShortcutCommand;
    if (!COMMANDS.includes(cmd)) {
      skipped.push(`这台机器没有这条命令：${cmd || "（没写 cmd）"}`);
      continue;
    }
    if (entries.some((e) => e.cmd === cmd)) continue; // 同一条命令写了两遍，只认第一遍
    const raw = attr(k, "chord");
    if (!raw) {
      entries.push({ cmd, chord: "" });
      continue;
    }
    const chord = normalizeChord(raw);
    if (!chord) {
      skipped.push(`这条键位不成组合键，已跳过：${labelOf(cmd)} = ${raw}`);
      continue;
    }
    entries.push({ cmd, chord });
  }

  const taken = new Map<string, ShortcutCommand>();
  // 别名先占位，和 rebuildLookup 同一个顺序：Ctrl+Y 这类第二个键也连着主人一起让位，别只查默认键。
  for (const a of ALIASES) taken.set(a.chord, a.cmd);
  for (const cmd of COMMANDS) taken.set(defaultChordOf(cmd), cmd);

  const custom: Record<string, string> = {};
  for (const { cmd, chord } of entries) {
    if (!chord) {
      custom[cmd] = "";
      releaseHeld(taken, cmd);
      continue;
    }
    const owner = taken.get(chord);
    if (owner && owner !== cmd) {
      skipped.push(
        `${labelOf(cmd)}想要的 ${chordLabel(chord)} 还归「${labelOf(owner)}」，这一条没加载。`
      );
      continue;
    }
    // 先把自己占着的键放掉，再认领新的：成对调换（保存挪走、另存为接走 Ctrl+S）才走得通。
    releaseHeld(taken, cmd);
    taken.set(chord, cmd);
    // 写回默认键的那条不落进 custom，但上面两行照常执行 —— 它可能正是要腾开别名（Ctrl+Y）的那种改动。
    if (chord !== defaultChordOf(cmd)) custom[cmd] = chord;
  }
  return { kind: "shortcut", custom, skipped };
}

/** 一条命令挪走（或被禁用）之后，它原本占着的默认键和别名就空出来了。 */
function releaseHeld(taken: Map<string, ShortcutCommand>, cmd: ShortcutCommand): void {
  for (const [chord, owner] of [...taken]) if (owner === cmd) taken.delete(chord);
}

/**
 * 导出：选位置 → 写成 UTF-8 文本，返回落到的路径；用户取消返回 null。
 * 浏览器模式没有可写句柄时，native.fileWriteBytes 自己退化成下载。
 * 文件名带上中文那一档：导出去找的人只会按"右键菜单"这种说法找文件。
 */
export async function exportProfile(kind: ProfileKind, xml: string): Promise<string | null> {
  const target = await pickSavePath({
    title: `导出${KIND_TEXT[kind]}方案`,
    defaultPath: `z-mind-${KIND_TEXT[kind]}.xml`,
    filters: FILTER,
  });
  if (!target) return null;
  await native.fileWriteBytes(target, new TextEncoder().encode(xml), true);
  return target;
}

/**
 * 加载：选文件 → 解析，并挡住"走错分页"的那种文件（菜单方案拿到快捷键页、反之亦然）。
 * 用户取消返回 null；文件不是方案、kind 对不上都抛错，由调用方原样显示。
 * 分成两个入口而不是一个带参数的：调用方拿到的类型就该是窄的那一种，不必自己判 kind。
 */
export const importMenuProfile = () => pickAndParse("rightMenu");
export const importKeymapProfile = () => pickAndParse("shortcut");

type ProfileOf<K extends ProfileKind> = K extends "rightMenu" ? RightMenuProfile : ShortcutProfile;

async function pickAndParse<K extends ProfileKind>(
  expect: K
): Promise<{ profile: ProfileOf<K>; path: string } | null> {
  const path = await pickOpenPath({ title: `加载${KIND_TEXT[expect]}方案`, filters: FILTER });
  if (!path) return null;
  const bytes = await native.fileReadBytes(path);
  const profile = parseProfile(new TextDecoder("utf-8").decode(bytes));
  if (profile.kind !== expect) {
    throw new Error(
      `这份文件是${KIND_TEXT[profile.kind]}方案，不是${KIND_TEXT[expect]}方案：请到对应那一页加载它。`
    );
  }
  // 上面那道 kind 判断过了才走得到这里，所以这次断言是安全的（联合类型收窄到不了嵌套属性）。
  return { profile: profile as ProfileOf<K>, path };
}

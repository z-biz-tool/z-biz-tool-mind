/**
 * 应用级快捷键（doc/复刻方案/00 §3.1：键盘是第一公民）。
 *
 * 只做"整窗那一份 keydown"和"键 → 命令"的翻译，不碰任何业务：
 * 真正的动作由 Shell 通过 registerShortcuts 注册进来。为什么要这层注册表而不是把回调
 * 一路 prop 下去 —— 快捷键属于整个应用，画布、面板、对话框都只是恰好活着的那一个处理者。
 * 注册表按注册序倒序派发，所以对话框能盖住画布对同一个键的处理。
 */
import { useEffect } from "react";

type ShortcutCommand =
  | "newDoc"
  | "open"
  | "save"
  | "saveAs"
  | "search"
  | "undo"
  | "redo"
  | "export"
  | "print"
  | "options"
  | "closeDialog";

export type { ShortcutCommand };

/** 选项面板的快捷键分页要逐行列出来，顺序就是这张表的顺序。 */
export const SHORTCUT_COMMANDS: readonly { cmd: ShortcutCommand; label: string; group: string }[] =
  [
    { cmd: "newDoc", label: "新建文档", group: "文件" },
    { cmd: "open", label: "打开 .emmx", group: "文件" },
    { cmd: "save", label: "保存", group: "文件" },
    { cmd: "saveAs", label: "另存为", group: "文件" },
    { cmd: "export", label: "导出", group: "文件" },
    { cmd: "print", label: "打印", group: "文件" },
    { cmd: "undo", label: "撤销", group: "编辑" },
    { cmd: "redo", label: "重做", group: "编辑" },
    { cmd: "search", label: "搜索", group: "视图" },
    { cmd: "options", label: "选项", group: "视图" },
    { cmd: "closeDialog", label: "关闭对话框 / 菜单", group: "视图" },
  ];

export interface ShortcutHandlers {
  [k: string]: (() => void) | undefined;
  newDoc?: () => void;
  open?: () => void;
  save?: () => void;
  saveAs?: () => void;
  search?: () => void;
  undo?: () => void;
  redo?: () => void;
  export?: () => void;
  print?: () => void;
  options?: () => void;
  closeDialog?: () => void;
}

/**
 * 默认键位表（§3.17「快捷键 · 全量可自定义、可禁用、可恢复默认」）。
 *
 * ctrl 在 mac 上由 meta(Cmd) 触发，chordOf 里已经把两者归一成 ctrl，所以这里只写 ctrl。
 * 键串一律用 normalizeChord 认得的那种形式（小写、ctrl→shift→alt 的顺序），
 * 因为自定义值是从配置文件里读进来的，两种写法对不上就会出现"改了却没生效"。
 */
const DEFAULT_CHORDS: Record<ShortcutCommand, string> = {
  newDoc: "ctrl+n",
  open: "ctrl+o",
  save: "ctrl+s",
  saveAs: "ctrl+shift+s",
  search: "ctrl+f",
  undo: "ctrl+z",
  redo: "ctrl+shift+z",
  export: "ctrl+e",
  print: "ctrl+p",
  options: "f1",
  closeDialog: "esc",
};

/** `ctrl+y` 是亿图给重做的第二个键，保留它比只认 Ctrl+Shift+Z 更贴近用户肌肉记忆。 */
export const ALIASES: readonly { chord: string; cmd: ShortcutCommand }[] = [
  { chord: "ctrl+y", cmd: "redo" },
];

const MODS = {
  ctrl: { win: "Ctrl", mac: "⌘", rank: 1 },
  shift: { win: "Shift", mac: "⇧", rank: 0 },
  alt: { win: "Alt", mac: "⌥", rank: 2 },
} as const;

const MOD_ORDER = ["ctrl", "shift", "alt"] as const;

const IGNORED_KEYS = new Set([
  "control",
  "shift",
  "alt",
  "meta",
  "tab",
  "enter",
  " ",
  "process",
  "dead",
]);

/**
 * 正在打字时仍然要生效的命令。
 * 判"在输入就不拦截"是为了 Ctrl+A 别把整张画布选上、Ctrl+Z 别把撤销打到画布上；
 * 但保存/导出这类动作针对的是文档而不是光标 —— 新建标注会立刻进入文字编辑态，
 * 那时按 Ctrl+S 存不下东西，用户只会以为软件没反应。
 */
const TYPING_SAFE = new Set<ShortcutCommand>(["save", "saveAs", "export", "print", "options"]);

const registry: Partial<ShortcutHandlers>[] = [];

/**
 * 焦点落在输入区时一律不拦截 —— 这类代码最常见的 bug 就是忘记这一层守卫：
 * 在主题改名框里按 Ctrl+A 想全选文字，结果触发了"全选主题"；在搜索框里按 Esc 想清空，
 * 结果整个对话框被关掉。而且就地编辑用的是 div[contenteditable] 而不是 <input>，
 * 只判 tagName 会漏掉画布上最高频的那一个输入场景。
 */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  // closest 兜住"contenteditable 在外面、事件目标是最内层 <span>"的结构（antd 富文本、段落子节点）。
  return target.closest("[contenteditable]") !== null;
}

/** 归一化后的组合键串，如 "ctrl+shift+s"；纯修饰键与输入无关的键返回 null。 */
function chordOf(e: KeyboardEvent): string | null {
  const key = e.key.toLowerCase();
  if (IGNORED_KEYS.has(key)) return null;
  const parts: string[] = [];
  // Cmd 与 Ctrl 归一：应用级快捷键在两个平台上是同一个语义，键位表不该为 mac 再写一份。
  if (e.ctrlKey || e.metaKey) parts.push("ctrl");
  if (e.shiftKey) parts.push("shift");
  if (e.altKey) parts.push("alt");
  // 没有修饰键时只放行功能键（F1 / Esc），否则单按一个字母就会把命令触发掉。
  if (!parts.length && key !== "escape" && !/^f\d{1,2}$/.test(key)) return null;
  parts.push(key === "escape" ? "esc" : key);
  return parts.join("+");
}

/** 选项面板录制键位用的同一个归一化：面板拿到的串和监听器算出的串必须是一种东西。 */
export function chordFromEvent(e: KeyboardEvent): string | null {
  return chordOf(e);
}

/**
 * 校验并归一化配置文件 / 面板里的一条键串。
 *
 * 不合规就返回 null，而不是"原样收下"：存进配置的键若是 `Ctrl-Shift-S` 这种写法，
 * 监听器永远匹配不上，用户看到的是"改完快捷键就失灵了"，而这最难复现 —— 因为配置文件里
 * 明明写着东西。归一化顺手把修饰键按 ctrl→shift→alt 排好，重复的修饰键视为不合规。
 */
export function normalizeChord(raw: string): string | null {
  const parts = raw
    .toLowerCase()
    .split("+")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (!parts.length) return null;
  const rawKey = parts[parts.length - 1];
  const key = rawKey === "escape" ? "esc" : rawKey;
  const mods = parts.slice(0, -1);
  if (mods.some((m) => !(m in MODS))) return null;
  if (new Set(mods).size !== mods.length) return null;
  const sorted = MOD_ORDER.filter((m) => mods.includes(m));
  const fn = key === "esc" || /^f\d{1,2}$/.test(key);
  // 裸键只放行功能键，和 chordOf 同一个口径：单按一个字母就发命令的话，
  // 在改名框里打第一个字就把命令打出来了。
  if (!sorted.length) return fn ? key : null;
  // 带修饰键时收单个可见字符（空格除外：chordOf 把 " " 归入忽略键，绑了也永远不触发）。
  return fn || /^[!-~]$/.test(key) ? [...sorted, key].join("+") : null;
}

/** cmd → 键串；空串表示"这条被禁用了"。缺键 = 用默认。 */
let overrides: Partial<Record<ShortcutCommand, string>> = {};
let lookup = new Map<string, ShortcutCommand>();

function rebuildLookup(): void {
  const next = new Map<string, ShortcutCommand>();
  // 别名先写：命令一旦改过自己的键，Ctrl+Y 就该让位给新主人，而不是继续抢在 redo 上。
  for (const a of ALIASES) if (overrides[a.cmd] === undefined) next.set(a.chord, a.cmd);
  for (const cmd of Object.keys(DEFAULT_CHORDS) as ShortcutCommand[]) {
    const chord = overrides[cmd] ?? DEFAULT_CHORDS[cmd];
    if (chord) next.set(chord, cmd);
  }
  lookup = next;
}

// 装载就建一次表：Shell 的 useEffect 要把配置里的自定义键位推进来，但在那之前
// （以及任何没调 setShortcutOverrides 的环境里）默认键位也得能用。
rebuildLookup();

/** 由 settings.shortcut.custom 调用：整表替换，改一次键不用重启。 */
export function setShortcutOverrides(custom: Record<string, string>): void {
  const next: Partial<Record<ShortcutCommand, string>> = {};
  for (const cmd of Object.keys(DEFAULT_CHORDS) as ShortcutCommand[]) {
    const raw = custom[cmd];
    if (raw === undefined) continue;
    // 配置里的值可能是手改坏的：认不得就回落到默认，别让一个坏串把整条命令废掉。
    next[cmd] = raw === "" ? "" : (normalizeChord(raw) ?? DEFAULT_CHORDS[cmd]);
  }
  overrides = next;
  rebuildLookup();
}

/** 这条命令现在认哪条键；null = 已禁用。 */
export function chordOfCommand(cmd: ShortcutCommand): string | null {
  const chord = overrides[cmd] ?? DEFAULT_CHORDS[cmd];
  return chord || null;
}

export function defaultChordOf(cmd: ShortcutCommand): string {
  return DEFAULT_CHORDS[cmd];
}

/** 这个键当前归谁（用来挡冲突）；没人用返回 null。 */
export function commandOfChord(chord: string): ShortcutCommand | null {
  return lookup.get(chord) ?? null;
}

/** 这条命令除了主键之外还认哪些键（亿图的 Ctrl+Y）。改过主键之后别名就没了。 */
export function aliasChords(cmd: ShortcutCommand): string[] {
  if (overrides[cmd] !== undefined) return [];
  return ALIASES.filter((a) => a.cmd === cmd).map((a) => a.chord);
}

/** 全部命令的当前键位快照：给测试和面板判断"这一格是不是默认的"。 */
export function effectiveChords(): Record<ShortcutCommand, string> {
  const out = {} as Record<ShortcutCommand, string>;
  for (const cmd of Object.keys(DEFAULT_CHORDS) as ShortcutCommand[])
    out[cmd] = chordOfCommand(cmd) ?? "";
  return out;
}

function dispatch(cmd: ShortcutCommand): boolean {
  for (let i = registry.length - 1; i >= 0; i -= 1) {
    const fn = registry[i][cmd];
    if (!fn) continue;
    fn();
    return true;
  }
  return false;
}

export function registerShortcuts(h: Partial<ShortcutHandlers>): () => void {
  registry.push(h);
  return () => {
    const ix = registry.lastIndexOf(h);
    if (ix >= 0) registry.splice(ix, 1);
  };
}

let listener: ((e: KeyboardEvent) => void) | null = null;
let bound = 0;

/**
 * 引用计数而不是每次挂载都 addEventListener：Shell 和各个面板都会调这个 hook，
 * 绑两份监听器就会让 Ctrl+S 存两遍、Esc 关掉两层对话框。
 *
 * 监听在冒泡阶段：组件自己已经处理掉的键（例如 Modal 内部的 Esc）不该被我们再执行一次。
 */
export function useGlobalShortcuts(): void {
  useEffect(() => {
    if (!listener) {
      listener = (e: KeyboardEvent) => {
        if (e.defaultPrevented) return;
        const chord = chordOf(e);
        if (!chord) return;
        const cmd = lookup.get(chord);
        if (!cmd) return;
        if ((isTyping(e.target) || isTyping(document.activeElement)) && !TYPING_SAFE.has(cmd))
          return;
        if (dispatch(cmd)) e.preventDefault();
      };
      window.addEventListener("keydown", listener);
    }
    bound += 1;
    return () => {
      bound -= 1;
      if (bound === 0 && listener) {
        window.removeEventListener("keydown", listener);
        listener = null;
      }
    };
  }, []);
}

function isMac(): boolean {
  // 只用 navigator.platform 决定"键名怎么显示"，不参与拦截判定：判错的后果是把 ⌘S 写成 Ctrl+S，
  // 而判对的代价是引入 UA 嗅探。无 navigator 的环境（测试、SSR）按 Windows 布局。
  if (typeof navigator === "undefined") return false;
  return /mac|iphone|ipad/i.test(navigator.platform ?? "");
}

/** 一条键串的显示形式：mac 是 "⇧⌘S"，其它平台是 "Ctrl+Shift+S"。 */
export function chordLabel(chord: string): string {
  const parts = chord.split("+");
  const raw = parts[parts.length - 1];
  const key = raw === "esc" ? "Esc" : raw.toUpperCase();
  const mods = parts
    .slice(0, -1)
    .map((m) => MODS[m as keyof typeof MODS])
    .filter(Boolean);
  if (!isMac()) return [...mods.map((m) => m.win), key].join("+");
  // mac 的书写顺序是 ⇧⌘⌥，与事件里的判定顺序无关，按 rank 排一次。
  const sorted = [...mods].sort((a, b) => a.rank - b.rank).map((m) => m.mac);
  return `${sorted.join("")}${key}`;
}

/** 菜单/提示里给用户的键名：mac 是 "⌘S"，其它平台是 "Ctrl+S"；被禁用的那条直说。 */
export function shortcutLabel(cmd: string): string {
  if (!(cmd in DEFAULT_CHORDS)) return cmd;
  const chord = chordOfCommand(cmd as ShortcutCommand);
  return chord ? chordLabel(chord) : "（已禁用）";
}

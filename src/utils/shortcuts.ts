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
  | "options"
  | "closeDialog";

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
  options?: () => void;
  closeDialog?: () => void;
}

/**
 * 键位表。ctrl 在 mac 上由 meta(Cmd) 触发，chordOf 里已经把两者归一成 ctrl，
 * 所以这里只写 ctrl。`ctrl+y` 是亿图给重做的第二个键，保留它比只认 Ctrl+Shift+Z 更贴近用户肌肉记忆。
 */
const CHORDS: Record<string, ShortcutCommand> = {
  "ctrl+n": "newDoc",
  "ctrl+o": "open",
  "ctrl+s": "save",
  "ctrl+shift+s": "saveAs",
  "ctrl+f": "search",
  "ctrl+z": "undo",
  "ctrl+shift+z": "redo",
  "ctrl+y": "redo",
  "ctrl+e": "export",
  f1: "options",
  esc: "closeDialog",
};

const MODS = {
  ctrl: { win: "Ctrl", mac: "⌘", rank: 1 },
  shift: { win: "Shift", mac: "⇧", rank: 0 },
  alt: { win: "Alt", mac: "⌥", rank: 2 },
} as const;

const IGNORED_KEYS = new Set(["control", "shift", "alt", "meta", "tab", "enter", " ", "process", "dead"]);

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
        if (isTyping(e.target) || isTyping(document.activeElement)) return;
        if (e.defaultPrevented) return;
        const chord = chordOf(e);
        if (!chord) return;
        const cmd = CHORDS[chord];
        if (!cmd) return;
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

/** 菜单/提示里给用户的键名：mac 是 "⌘S"，其它平台是 "Ctrl+S"。 */
export function shortcutLabel(cmd: string): string {
  const chord = Object.keys(CHORDS).find((k) => CHORDS[k] === cmd);
  if (!chord) return cmd;
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

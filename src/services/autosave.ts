/**
 * 自动保存（doc/复刻方案/00 §3.14 三层保险的第一层，间隔默认 5 分钟 = 300 s）。
 *
 * 与"保存"的分工：save() 是用户意志（写回原路径 + 进历史版本），自动保存是兜命
 * —— 快照只落在原生层的 autosave 目录，永远不改用户的路径，也不动撤销栈。
 * 因此这里的失败一律不打扰用户：正在打字的人不需要一个弹窗告诉他临时目录满了。
 */
import type { DocumentModel } from "../types/model.ts";
import { writeEmmx } from "../engine/emmx/codec.ts";
import { activeDoc, dirtyOf, useDoc } from "../stores/docStore.ts";
import { useSettings } from "../stores/settingsStore.ts";
import { native, type AutosaveItem } from "./native.ts";
import { humanSize, timestampName } from "../utils/id.ts";

/**
 * 没存过盘的文档也得有个身份，否则快照无处可归。
 *
 * 用"建文档那一刻 + GUID 前缀"而不是当前时刻或标题：
 * Rust 侧按这个 key 建子目录，key 每跳一次就换一个目录，"文件恢复"中心会被同一篇文档
 * 散落的几十份快照淹掉；而标题跟着中心主题的文字变（deriveTitle 就是这么算的），更不能用。
 * 冒号要换掉：它是 ILLEGAL_TITLE_CHARS 里的字符，Windows 文件名不允许。
 */
function unsavedKey(doc: DocumentModel): string {
  const stamp = doc.properties.createdDate.replace(/[^0-9A-Za-z._-]/g, "-");
  const guid = doc.properties.docGuid.replace(/[{}]/g, "").slice(0, 8);
  return `未命名-${stamp}-${guid}`;
}

async function snapshot(): Promise<void> {
  const state = useDoc.getState();
  const doc = activeDoc(state);
  if (!doc) return; // 没有打开的文档是常态（启动页、全部关闭），不是错误，不能抛
  if (!dirtyOf(state)) return; // 和盘上一样就别再写一份，autosave 目录里只装真的还没存的东西
  const path = state.path ?? unsavedKey(doc);
  try {
    await native.autosaveWrite(path, await writeEmmx(doc));
  } catch {
    /* 快照写失败留给备份中心的列表去显示，编辑路径上不打断用户 */
  }
}

/** 开启自动保存；返回的函数停掉定时器与订阅（在组件卸载时调用）。 */
export function startAutosave(): () => void {
  let timer: ReturnType<typeof setInterval> | undefined;
  let periodMs = 0;

  /**
   * 只在"开关变了 / 间隔变了 / 换了文件"时重建定时器。
   * 如果每次编辑都重计时，一直在打字的用户永远不会触发自动保存 —— 而那正是最需要它的时候。
   */
  const arm = () => {
    const save = useSettings.getState().settings.save;
    // 间隔下限 1 分钟：填 0 会变成 busy loop，每几毫秒把整篇文档压一遍 zip。
    const next = Math.max(1, Math.round(save.autoSaveIntervalMin) || 1) * 60_000;
    if (!save.autoSave) {
      if (timer) clearInterval(timer);
      timer = undefined;
      periodMs = 0;
      return;
    }
    if (timer && periodMs === next) return;
    if (timer) clearInterval(timer);
    periodMs = next;
    timer = setInterval(() => void snapshot(), next);
  };

  arm();
  const offDoc = useDoc.subscribe((s, prev) => {
    // 首次存盘 / 另存为 / 换文档：重新计时一次，别把上一个文档的倒计时套到新文档上。
    if (s.path !== prev.path) arm();
  });
  const offSettings = useSettings.subscribe((s, prev) => {
    if (s.settings.save !== prev.settings.save) arm();
  });

  return () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    offDoc();
    offSettings();
  };
}

/**
 * 启动时问一句"有没有没存下来的东西"：返回最新的那一份快照，没有可恢复项就返回 null。
 *
 * 判定条件是快照时间 **晚于** 文件落盘时刻：早于它的快照已经被真正的保存覆盖，
 * 恢复那种东西只会把用户往回带。原生层没有 stat，store 的 savedAt 就是"上一次写盘"的时刻，
 * 等价、且不用跨进程问 Rust。
 *
 * 返回条目而不是句子：外壳拿到它才知道"恢复"该去读哪个路径 —— 只回一句文案的提示框，
 * 用户点了确定之后还得再列一次表。
 */
export async function newestPendingAutosave(): Promise<AutosaveItem | null> {
  let items: AutosaveItem[];
  try {
    items = await native.autosaveList();
  } catch {
    return null; // 列表都拿不到，就没有"可恢复"可宣告
  }
  const state = useDoc.getState();
  const baseline = state.path ? state.savedAt : 0;
  return items.filter((i) => i.modifiedAt > baseline).sort((a, b) => b.modifiedAt - a.modifiedAt)[0] ?? null;
}

/** 可直接 show 的中文句子：时间和大小在这里格式化，别让外壳各写一份。 */
export function autosaveNote(item: AutosaveItem): string {
  return `发现 ${timestampName(new Date(item.modifiedAt))} 的自动保存快照「${docNameOf(item.path)}」（${humanSize(item.size)}），其中有尚未写入文件的修改，可以恢复。`;
}

/**
 * 快照路径在两端形状不同：Rust 是 <autosave>/<文档名>/<时间戳>.emmx，
 * 浏览器是直接拿我们传进去的 key 当键。所以文档名可能在倒数第二段。
 */
function docNameOf(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  const stem = (parts[parts.length - 1] ?? "").replace(/\.emmx$/i, "");
  if (/^\d{8}_\d{6}_\d{3}$/.test(stem)) return parts[parts.length - 2] ?? stem;
  return stem || "未命名";
}

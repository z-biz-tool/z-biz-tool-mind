/**
 * 工作台侧的数据：最近文件、历史版本、回收站、自动保存快照。
 * 都是"列表 + 刷新"的同一种东西，所以放一个 store；
 * 每一项都单独 refreshX，因为它们的失效时机不同（保存只影响历史版本，删除只影响回收站）。
 */
import { create } from "zustand";
import { native, listen, type AutosaveItem, type BackupEntry, type RecentItem } from "../services/native.ts";
import { useDoc } from "./docStore.ts";
import { useQuota } from "./quotaStore.ts";

interface RecentStore {
  recent: RecentItem[];
  backups: BackupEntry[];
  trash: BackupEntry[];
  autosave: AutosaveItem[];
  loading: boolean;
  error: string | null;
  refreshAll: () => Promise<void>;
  refreshRecent: () => Promise<void>;
  refreshBackups: (path?: string) => Promise<void>;
  refreshTrash: () => Promise<void>;
  refreshAutosave: () => Promise<void>;
  removeRecent: (path: string) => Promise<boolean>;
  /** 删除文档本身（进回收站），并把这条记录从最近列表摘掉。 */
  deleteFile: (path: string) => Promise<boolean>;
  togglePin: (path: string) => Promise<boolean>;
  clearRecent: () => Promise<boolean>;
  deleteBackup: (id: string) => Promise<void>;
  purgeBackup: (days: number) => Promise<void>;
  restoreTrash: (id: string) => Promise<string | null>;
  purgeTrash: (id: string) => Promise<void>;
  clearAutosave: () => Promise<void>;
}

function fail(set: (p: Partial<RecentStore>) => void, e: unknown) {
  set({ error: e instanceof Error ? e.message : String(e), loading: false });
}

export const useRecent = create<RecentStore>((set, get) => ({
  recent: [],
  backups: [],
  trash: [],
  autosave: [],
  loading: false,
  error: null,

  async refreshAll() {
    set({ loading: true, error: null });
    // 配额账本跟着列表一起刷：它不在 recent 里（那张表能调容量、能一键清空），
    // 但它的失效时机和这几张表是同一批。
    void useQuota.getState().refresh();
    try {
      const [recent, trash, autosave] = await Promise.all([
        native.recentList(),
        native.trashList(),
        native.autosaveList(),
      ]);
      set({ recent, trash, autosave, loading: false });
    } catch (e) {
      fail(set, e);
    }
  },

  async refreshRecent() {
    try {
      set({ recent: await native.recentList(), error: null });
    } catch (e) {
      fail(set, e);
    }
  },

  async refreshBackups(path) {
    try {
      set({ backups: await native.backupList(path), error: null });
    } catch (e) {
      fail(set, e);
    }
  },

  async refreshTrash() {
    try {
      set({ trash: await native.trashList(), error: null });
    } catch (e) {
      fail(set, e);
    }
  },

  async refreshAutosave() {
    try {
      set({ autosave: await native.autosaveList(), error: null });
    } catch (e) {
      fail(set, e);
    }
  },

  async removeRecent(path) {
    try {
      set({ recent: await native.recentRemove(path) });
      return true;
    } catch (e) {
      fail(set, e);
      return false;
    }
  },

  // 顺序不能反：先删文件再摘列表。反过来一旦删除失败，列表里那条已经没了，
  // 磁盘上的文件却还留着 —— 用户看到"已移除"，实际什么都没删掉。
  // 回收站条目由 Rust 侧 to_trash 生成，这里只负责删完把列表刷回来。
  async deleteFile(path) {
    try {
      await native.fileRemove(path);
      set({ recent: await native.recentRemove(path) });
      await get().refreshTrash();
      // Rust 的 file_remove 顺手还了一格保存名额，这里回读，别让闸门继续按旧的记账拦人。
      void useQuota.getState().refresh();
      return true;
    } catch (e) {
      fail(set, e);
      return false;
    }
  },

  // 固定/取消固定：后端返回整份重排过的列表（固定项在前），这里直接采用，
  // 不在前端再排一次，否则两边的排序规则会分叉。
  async togglePin(path) {
    const target = get().recent.find((r) => r.path === path);
    if (!target) return false;
    try {
      set({ recent: await native.recentSetPinned(path, !target.pinned) });
      return true;
    } catch (e) {
      fail(set, e);
      return false;
    }
  },

  async clearRecent() {
    try {
      await native.recentClear();
      set({ recent: [] });
      return true;
    } catch (e) {
      fail(set, e);
      return false;
    }
  },

  async deleteBackup(id) {
    try {
      await native.backupDelete(id);
      set({ backups: get().backups.filter((b) => b.id !== id) });
    } catch (e) {
      fail(set, e);
    }
  },

  async purgeBackup(days) {
    try {
      await native.backupPurge(days);
      await get().refreshBackups();
    } catch (e) {
      fail(set, e);
    }
  },

  async restoreTrash(id) {
    try {
      const p = await native.trashRestore(id);
      await get().refreshTrash();
      void get().refreshRecent();
      // 回收站放回 = 这份文档又回到盘上，Rust 侧重新占了一格名额。
      if (p) void useQuota.getState().refresh();
      return p;
    } catch (e) {
      fail(set, e);
      return null;
    }
  },

  async purgeTrash(id) {
    try {
      await native.trashPurge(id);
      set({ trash: get().trash.filter((t) => t.id !== id) });
    } catch (e) {
      fail(set, e);
    }
  },

  async clearAutosave() {
    try {
      await native.autosaveClear();
      set({ autosave: [] });
    } catch (e) {
      fail(set, e);
    }
  },
}));

/**
 * 订阅 Rust 侧的两条落盘事件，把列表顶新。
 *
 * 面板只在挂载和换文档时查一次：Ctrl+S 之后"历史版本"的条数不动，自动保存页签更是一个字都不变，
 * 用户只能靠关掉再打开面板来确认自己没白存。订阅放在 store 而不是面板里，
 * 这样面板没打开时列表也已经是新的，再进去就直接是准的。
 * 浏览器模式没有事件源，listen 返回空退订，这里等于什么都不做。
 */
export function startRecentListeners(): () => void {
  const unsubs: (() => void)[] = [];
  let stopped = false;
  const pairs: [string, () => Promise<void>][] = [
    ["autosave-fired", () => useRecent.getState().refreshAutosave()],
    // 存盘事件跟着当前文档走：面板上显示的就是这一份文件的历史，别把它刷成全部。
    [
      "emmx-saved",
      () => useRecent.getState().refreshBackups(useDoc.getState().path ?? undefined),
    ],
  ];
  void (async () => {
    for (const [name, handler] of pairs) {
      const un = await listen(name, () => void handler());
      if (stopped) {
        un();
        continue;
      }
      unsubs.push(un);
    }
  })();
  return () => {
    stopped = true;
    for (const un of unsubs) un();
    unsubs.length = 0;
  };
}

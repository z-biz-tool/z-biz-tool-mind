/**
 * 工作台侧的数据：最近文件、历史版本、回收站、自动保存快照。
 * 都是"列表 + 刷新"的同一种东西，所以放一个 store；
 * 每一项都单独 refreshX，因为它们的失效时机不同（保存只影响历史版本，删除只影响回收站）。
 */
import { create } from "zustand";
import { native, type AutosaveItem, type BackupEntry, type RecentItem } from "../services/native.ts";

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
  removeRecent: (path: string) => Promise<void>;
  clearRecent: () => Promise<void>;
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
    } catch (e) {
      fail(set, e);
    }
  },

  async clearRecent() {
    try {
      await native.recentClear();
      set({ recent: [] });
    } catch (e) {
      fail(set, e);
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

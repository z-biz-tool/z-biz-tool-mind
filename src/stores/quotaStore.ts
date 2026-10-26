/**
 * 免费档「已保存文件数」的前端镜像（01 A-13）。
 *
 * 真相在 Rust 的 saved.json 里，这里只是它的缓存：保存闸门是同步判的，
 * 不能在一次点击里等 IPC 回来，所以只能"动作之后回读"。
 * 回读而不是本地加一笔 —— Windows 上同一份文件有两种大小写写法，后端认得、前端认不得，
 * 本地累加会把名额算多，用户会在一个都没存满时被闸门拦下。
 */
import { create } from "zustand";
import { native } from "../services/native.ts";

interface QuotaStore {
  saved: string[];
  refresh: () => Promise<void>;
  /** 落盘成功之后记一笔再回读。记账失败不改判：闸门宁松勿紧，不能因为记不上账就不让人存。 */
  markSaved: (path: string) => Promise<void>;
}

export const useQuota = create<QuotaStore>((set, get) => ({
  saved: [],

  async refresh() {
    try {
      set({ saved: await native.quotaSavedList() });
    } catch (e) {
      // 读不到账本就按"没占名额"处理：把它当成满额会让人一个文件都存不了。
      console.warn("配额账本读取失败，本次按未占名额处理：", e);
    }
  },

  async markSaved(path) {
    try {
      await native.quotaMarkSaved(path);
    } catch (e) {
      console.warn("保存名额没记上，闸门会暂时偏松：", e);
      return;
    }
    await get().refresh();
  },
}));

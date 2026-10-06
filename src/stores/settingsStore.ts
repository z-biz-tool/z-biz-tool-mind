/**
 * 选项与配额。分节严格对齐 Rust config.rs 的 defaults()：
 * 前端只写自己认识的节，缺字段由 Rust 的 merge_defaults 补齐，
 * 所以这里的类型是"我们保证存在的键"，而不是整份配置文件。
 */
import { create } from "zustand";
import { native } from "../services/native.ts";
import { QUOTA } from "../model/constants.ts";

export interface Settings {
  general: {
    theme: "light" | "dark" | "system";
    language: string;
    restoreLastSession: boolean;
    showQuickBar: boolean;
    canvasDragButton: "left" | "right";
    wheelZoom: "cursor" | "center";
  };
  format: {
    defaultLayout: string;
    defaultThemeId: string;
    autoFitOnOpen: boolean;
    topicWidthMode: "auto" | "fixed";
  };
  save: {
    autoSave: boolean;
    autoSaveIntervalMin: number;
    historyCount: number;
    backupOnSave: boolean;
    backupDir: string;
    backupKeepDays: number;
  };
  network: { proxyMode: string; proxyHost: string; proxyPort: number; timeoutSec: number };
  advanced: { autoUpdate: boolean; crashReport: boolean; logLevel: string; aiEndpoint: string; aiModel: string };
  recent: { maxCount: number };
  quota: { aiPoints: number; aiUsed: number };
}

export const DEFAULT_SETTINGS: Settings = {
  general: { theme: "system", language: "zh-CN", restoreLastSession: true, showQuickBar: true, canvasDragButton: "right", wheelZoom: "cursor" },
  format: { defaultLayout: "balanced", defaultThemeId: "default", autoFitOnOpen: true, topicWidthMode: "auto" },
  save: { autoSave: true, autoSaveIntervalMin: 5, historyCount: QUOTA.historyMax, backupOnSave: true, backupDir: "", backupKeepDays: QUOTA.trashKeepDays },
  network: { proxyMode: "system", proxyHost: "", proxyPort: 0, timeoutSec: 20 },
  advanced: { autoUpdate: true, crashReport: false, logLevel: "info", aiEndpoint: "", aiModel: "" },
  recent: { maxCount: QUOTA.recentMax },
  quota: { aiPoints: 0, aiUsed: 0 },
};

type Section = keyof Settings;

interface SettingsStore {
  settings: Settings;
  loaded: boolean;
  saving: boolean;
  error: string | null;
  load: () => Promise<void>;
  /** 局部改一节；返回后 settings 已是新值，界面立刻生效。 */
  patch: <K extends Section>(section: K, patch: Partial<Settings[K]>) => Promise<void>;
  resetSection: (section: Section) => Promise<void>;
  /** 免费版点数用完后要限流的 AI 额度。 */
  spendAiPoints: (chars: number) => Promise<boolean>;
}

export const useSettings = create<SettingsStore>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  saving: false,
  error: null,

  async load() {
    try {
      const raw = (await native.configGet()) as Partial<Settings>;
      // 逐节合并：老文件缺哪一节就用默认值补哪一节。
      // 用 Record 中转而不是 merged[key] = {...}：key 是联合类型时 TS 要求写入的是各节类型的**交集**，
      // 直接赋值只会逼出一串 as。
      const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
      for (const key of Object.keys(DEFAULT_SETTINGS) as Section[]) {
        merged[key] = { ...DEFAULT_SETTINGS[key], ...((raw[key] as object | undefined) ?? {}) };
      }
      set({ settings: merged as unknown as Settings, loaded: true, error: null });
    } catch (e) {
      set({ loaded: true, error: e instanceof Error ? e.message : String(e) });
    }
  },

  async patch(section, value) {
    const next: Settings = { ...get().settings, [section]: { ...get().settings[section], ...value } };
    set({ settings: next, saving: true });
    try {
      await native.configSet(section, value as Record<string, unknown>);
      set({ saving: false, error: null });
    } catch (e) {
      set({ saving: false, error: e instanceof Error ? e.message : String(e) });
    }
  },

  async resetSection(section) {
    set({ settings: { ...get().settings, [section]: DEFAULT_SETTINGS[section] } });
    try {
      await native.configResetPage(section);
      await get().load();
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  async spendAiPoints(chars) {
    const need = Math.ceil(chars / QUOTA.aiCharsPerPoint);
    const q = get().settings.quota;
    // 点数是"约 10 个汉字 1 点"，向上取整让用户看到的是整数点而不是小数。
    if (q.aiPoints - q.aiUsed < need) return false;
    await get().patch("quota", { aiUsed: q.aiUsed + need });
    return true;
  },
}));

/**
 * Tauri 命令的唯一出入口。
 *
 * 两件事决定这里的形状：
 * 1) Rust 侧命令一律 `Result<T, String>`，错误是完整中文句子，前端可以直接 show 出来，
 *    所以这里不再包一层错误类型 —— 再包一次只会把"读取文件失败: xxx"切成两半。
 * 2) 界面必须被真实点过一遍才算验证，而 `vite dev` 在浏览器里跑时没有 IPC。
 *    于是每个命令都有一份 Web 端实现：配置/最近文件落 localStorage，备份与自动保存落内存，
 *    字节读写走 File System Access API（不支持时退到 <input type=file> + <a download>）。
 *    浏览器分支不是"假装成功"：它真的能读 .emmx、真的能存盘，只是历史版本关在标签页里。
 */
export interface AppInfo {
  version: string;
  configDir: string;
  tempDir: string;
  os: string;
  arch: string;
}

export interface WriteResult {
  path: string;
  bytes: number;
  replaced: boolean;
}

export interface RecentItem {
  path: string;
  title: string;
  kind: string;
  openedAt: number;
  pinned: boolean;
}

export interface BackupEntry {
  id: string;
  docPath: string;
  title: string;
  size: number;
  createdAt: number;
  reason: string;
}

export interface AutosaveItem {
  path: string;
  size: number;
  modifiedAt: number;
}

export interface RestoreResult {
  entry: BackupEntry;
  writtenTo?: string;
  contentBase64?: string;
}

/** 「选项 → 高级」的日志面板要的这些数，正好对应 Rust log.rs 的 LogInfo。 */
export interface LogInfo {
  dir: string;
  file: string;
  level: string;
  levels: string[];
  files: number;
  bytes: number;
  today: boolean;
}

export interface ProxyStatus {
  /** 真正附加给 WebView2 的启动参数；null = 跟随系统。 */
  arg: string | null;
  /** 这个设置在当前平台上是否真的起作用（macOS 的手动代理就不起作用）。 */
  active: boolean;
  message: string;
}

/** 「选项 → 高级」的崩溃记录面板，字段与 Rust crash.rs 的 CrashInfo 一一对应。 */
export interface CrashInfo {
  dir: string;
  files: number;
  bytes: number;
  /** 开关的**实际**生效值：界面据此判断"我刚点的到底存进去没有"。 */
  enabled: boolean;
  latest: string;
}

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri) throw new Error(`桌面功能 "${cmd}" 在浏览器里不可用`);
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

// ---------- 二进制 <-> base64（Rust 侧用 base64 传字节，见 commands.rs 头部注释） ----------

function toBase64(bytes: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

function fromBase64(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------- 浏览器后备 ----------

const LS_CONFIG = "z-mind:config";
const LS_RECENT = "z-mind:recent";

// 与 Rust 侧 recent.rs 的默认 max_count 对齐；QUOTA.recentMax 是"用户能调到多少"，
// 这里是"没调过时的容量"，两者不是一回事，别拿 UI 那个数当后备。
const RECENT_MAX = 20;

/** 浏览器后备要与 Rust 同规格：固定项排最前、其余按打开时间倒序。 */
function sortRecent(list: RecentItem[]): RecentItem[] {
  return [...list].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.openedAt - a.openedAt);
}

/** 淘汰只裁未固定的，固定的不因容量被挤掉（照 recent.rs 的 trim）。 */
function trimRecent(list: RecentItem[], max: number): RecentItem[] {
  const pinned = list.filter((r) => r.pinned);
  const others = list.filter((r) => !r.pinned);
  return [...pinned, ...others.slice(0, Math.max(0, max - pinned.length))];
}

/** 会话内的历史版本：浏览器关了就没了，但至少"覆盖前留一份"的语义是真的。 */
const memBackups: BackupEntry[] = [];
const memBackupBlobs = new Map<string, Uint8Array>();
const memAutosave = new Map<string, { bytes: Uint8Array; at: number }>();
/** File System Access 给的句柄没有可信路径，用它当 key 前缀，至少能区分不同文件。 */
const handles = new Map<string, FileSystemFileHandle>();

function lsGet<T>(key: string, dflt: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : dflt;
  } catch {
    return dflt;
  }
}

function lsSet(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 隐私模式写不进去：配置只影响默认值，不阻断编辑 */
  }
}

function browserInfo(): AppInfo {
  return {
    version: "browser",
    configDir: "localStorage",
    tempDir: "memory",
    os: navigator.platform || "web",
    arch: "wasm",
  };
}

function browserWrite(path: string, bytes: Uint8Array, overwrite: boolean): WriteResult {
  const existed = handles.has(path);
  if (existed && !overwrite) throw new Error(`文件已存在，未指定覆盖: ${path}`);
  const a = document.createElement("a");
  const blob = new Blob([bytes as unknown as BlobPart], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = path.split(/[\\/]/).pop() || "document.emmx";
  a.click();
  URL.revokeObjectURL(url);
  return { path, bytes: bytes.length, replaced: existed };
}

// ---------- 命令 ----------

export const native = {
  available: isTauri,

  async appInfo(): Promise<AppInfo> {
    if (!isTauri) return browserInfo();
    return call<AppInfo>("app_info");
  },

  async configGet(): Promise<Record<string, unknown>> {
    if (!isTauri) return lsGet<Record<string, unknown>>(LS_CONFIG, {});
    return call<Record<string, unknown>>("config_get");
  },

  async configSet(page: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!isTauri) {
      const all = lsGet<Record<string, unknown>>(LS_CONFIG, {});
      all[page] = { ...(all[page] as object), ...patch };
      lsSet(LS_CONFIG, all);
      return all;
    }
    return call<Record<string, unknown>>("config_set", { page, patch });
  },

  async configResetPage(page: string): Promise<Record<string, unknown>> {
    if (!isTauri) {
      const all = lsGet<Record<string, unknown>>(LS_CONFIG, {});
      delete all[page];
      lsSet(LS_CONFIG, all);
      return all;
    }
    return call<Record<string, unknown>>("config_reset_page", { page });
  },

  async recentList(): Promise<RecentItem[]> {
    if (!isTauri) return sortRecent(lsGet<RecentItem[]>(LS_RECENT, []));
    return call<RecentItem[]>("recent_list");
  },

  async recentTouch(path: string, title: string, kind: string): Promise<RecentItem[]> {
    if (!isTauri) {
      const prev = lsGet<RecentItem[]>(LS_RECENT, []);
      // 重复打开只刷新时间，固定状态要跟着那条记录走，不能默默被清掉。
      const pinned = prev.find((r) => r.path === path)?.pinned ?? false;
      const list = [
        { path, title, kind, openedAt: Date.now(), pinned },
        ...prev.filter((r) => r.path !== path),
      ];
      const capped = trimRecent(list, RECENT_MAX);
      lsSet(LS_RECENT, capped);
      return sortRecent(capped);
    }
    return call<RecentItem[]>("recent_touch", { path, title, kind });
  },

  async recentRemove(path: string): Promise<RecentItem[]> {
    if (!isTauri) {
      const list = lsGet<RecentItem[]>(LS_RECENT, []).filter((r) => r.path !== path);
      lsSet(LS_RECENT, list);
      return list;
    }
    return call<RecentItem[]>("recent_remove", { path });
  },

  async recentClear(): Promise<void> {
    if (!isTauri) {
      lsSet(LS_RECENT, []);
      return;
    }
    await call<void>("recent_clear");
  },

  async recentSetCapacity(maxCount: number): Promise<RecentItem[]> {
    if (!isTauri) {
      const list = trimRecent(lsGet<RecentItem[]>(LS_RECENT, []), maxCount);
      lsSet(LS_RECENT, list);
      return list;
    }
    return call<RecentItem[]>("recent_set_capacity", { maxCount });
  },

  async recentSetPinned(path: string, pinned: boolean): Promise<RecentItem[]> {
    if (!isTauri) {
      const list = lsGet<RecentItem[]>(LS_RECENT, []).map((r) =>
        r.path === path ? { ...r, pinned } : r
      );
      lsSet(LS_RECENT, list);
      return sortRecent(list);
    }
    return call<RecentItem[]>("recent_set_pinned", { path, pinned });
  },

  /**
   * 读一个 .emmx 的字节。浏览器里 showOpenFilePicker 选到的句柄会记进 handles，
   * 这样"保存"能原地覆盖而不是又另存一份。
   */
  async fileReadBytes(path: string): Promise<Uint8Array> {
    if (!isTauri) {
      const viaHandle = await readHandle(path);
      if (viaHandle) return viaHandle;
      const hit = memAutosave.get(path);
      if (hit) return hit.bytes;
      throw new Error("浏览器里请先通过“打开”选择文件，再使用该路径");
    }
    return fromBase64(await call<string>("file_read_bytes", { path }));
  },

  /** 与 Rust 侧一致的写入入口；浏览器模式优先写回句柄，拿不到句柄才退化成下载。 */
  async fileWriteBytes(path: string, bytes: Uint8Array, overwrite: boolean): Promise<WriteResult> {
    if (!isTauri) {
      if (await writeHandle(path, bytes)) return { path, bytes: bytes.length, replaced: true };
      return browserWrite(path, bytes, overwrite);
    }
    return call<WriteResult>("file_write_bytes", {
      path,
      contentBase64: toBase64(bytes),
      overwrite,
    });
  },

  async fileExists(path: string): Promise<boolean> {
    if (!isTauri) return handles.has(path) || memAutosave.has(path);
    return call<boolean>("file_exists", { path });
  },

  async fileSize(path: string): Promise<number> {
    if (!isTauri) return memAutosave.get(path)?.bytes.length ?? 0;
    return call<number>("file_size", { path });
  },

  async fileRemove(path: string): Promise<string> {
    if (!isTauri) {
      const bytes = memAutosave.get(path)?.bytes ?? new Uint8Array();
      const id = `trash-${Date.now()}`;
      memBackupBlobs.set(id, bytes);
      memBackups.unshift({
        id,
        docPath: path,
        title: path,
        size: bytes.length,
        createdAt: Date.now(),
        reason: "trash",
      });
      memAutosave.delete(path);
      handles.delete(path);
      return path;
    }
    return call<string>("file_remove", { path });
  },

  async autosaveWrite(path: string, bytes: Uint8Array): Promise<string> {
    if (!isTauri) {
      memAutosave.set(path, { bytes, at: Date.now() });
      return path;
    }
    return call<string>("autosave_write", { path, contentBase64: toBase64(bytes) });
  },

  async autosaveList(): Promise<AutosaveItem[]> {
    if (!isTauri) {
      return [...memAutosave.entries()].map(([p, v]) => ({
        path: p,
        size: v.bytes.length,
        modifiedAt: v.at,
      }));
    }
    return call<AutosaveItem[]>("autosave_list");
  },

  async autosaveClear(): Promise<number> {
    if (!isTauri) {
      const n = memAutosave.size;
      memAutosave.clear();
      return n;
    }
    return call<number>("autosave_clear");
  },

  async backupNow(
    path: string,
    title: string,
    reason: string,
    bytes: Uint8Array
  ): Promise<BackupEntry> {
    if (!isTauri) {
      const entry: BackupEntry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        docPath: path,
        title,
        size: bytes.length,
        createdAt: Date.now(),
        reason,
      };
      memBackupBlobs.set(entry.id, bytes);
      memBackups.unshift(entry);
      // 与 Rust 侧同样的配额：只留最新 10 份，多的丢掉，避免会话越长越吃内存。
      while (memBackups.length > 10) {
        const gone = memBackups.pop();
        if (gone) memBackupBlobs.delete(gone.id);
      }
      return entry;
    }
    return call<BackupEntry>("backup_now", { path, title, reason, contentBase64: toBase64(bytes) });
  },

  async backupList(path?: string): Promise<BackupEntry[]> {
    if (!isTauri) return path ? memBackups.filter((b) => b.docPath === path) : [...memBackups];
    return call<BackupEntry[]>("backup_list", { path: path ?? null });
  },

  async backupRestore(id: string, target?: string): Promise<RestoreResult> {
    if (!isTauri) {
      const entry = memBackups.find((b) => b.id === id);
      if (!entry) throw new Error(`找不到历史版本: ${id}`);
      const bytes = memBackupBlobs.get(id);
      if (!bytes) throw new Error("浏览器里的历史版本已随标签页关闭");
      if (target) return { entry, writtenTo: browserWrite(target, bytes, true).path };
      return { entry, contentBase64: toBase64(bytes) };
    }
    return call<RestoreResult>("backup_restore", { id, target: target ?? null });
  },

  async backupDelete(id: string): Promise<void> {
    if (!isTauri) {
      const ix = memBackups.findIndex((b) => b.id === id);
      if (ix >= 0) memBackups.splice(ix, 1);
      memBackupBlobs.delete(id);
      return;
    }
    await call<void>("backup_delete", { id });
  },

  async backupPurge(days: number): Promise<number> {
    if (!isTauri) {
      const cut = Date.now() - days * 86_400_000;
      const keep = memBackups.filter((b) => b.createdAt >= cut);
      const n = memBackups.length - keep.length;
      memBackups.length = 0;
      memBackups.push(...keep);
      return n;
    }
    return call<number>("backup_purge", { days });
  },

  async historyList(path: string): Promise<BackupEntry[]> {
    if (!isTauri) return this.backupList(path);
    return call<BackupEntry[]>("history_list", { path });
  },

  async trashList(): Promise<BackupEntry[]> {
    if (!isTauri) return memBackups.filter((b) => b.reason === "trash");
    return call<BackupEntry[]>("trash_list");
  },

  async trashRestore(id: string): Promise<string> {
    if (!isTauri) {
      const b = memBackups.find((x) => x.id === id);
      if (!b) throw new Error(`回收站里没有这一项: ${id}`);
      return b.docPath;
    }
    return call<string>("trash_restore", { id });
  },

  async trashPurge(id: string): Promise<boolean> {
    if (!isTauri) {
      const ix = memBackups.findIndex((b) => b.id === id);
      if (ix >= 0) memBackups.splice(ix, 1);
      return ix >= 0;
    }
    return call<boolean>("trash_purge", { id });
  },

  async trashPurgeOlderThan(days: number): Promise<number> {
    if (!isTauri) {
      const cut = Date.now() - days * 86_400_000;
      const keep = memBackups.filter((b) => !(b.reason === "trash" && b.createdAt < cut));
      const n = memBackups.length - keep.length;
      memBackups.length = 0;
      memBackups.push(...keep);
      return n;
    }
    return call<number>("trash_purge_older_than", { days });
  },

  async secretStore(name: string, value: string): Promise<boolean> {
    if (!isTauri) {
      // 明文留在 localStorage 是不诚实的：浏览器模式只保存到当前标签页内存。
      memSecrets.set(name, value);
      return true;
    }
    return call<boolean>("secret_store", { name, value });
  },

  async secretReveal(name: string): Promise<string | null> {
    if (!isTauri) return memSecrets.get(name) ?? null;
    return call<string | null>("secret_reveal", { name });
  },

  async secretDrop(name: string): Promise<boolean> {
    if (!isTauri) return memSecrets.delete(name);
    return call<boolean>("secret_drop", { name });
  },

  async secretExists(name: string): Promise<boolean> {
    if (!isTauri) return memSecrets.has(name);
    return call<boolean>("secret_exists", { name });
  },

  async revealInFolder(path: string): Promise<void> {
    if (!isTauri) throw new Error("浏览器模式打不开所在目录，请在桌面版里使用");
    await call<void>("reveal_in_folder", { path });
  },

  /**
   * 取走"待打开路径"（双击 .emmx 交给我们的）。
   *
   * 出队即清空，所以启动取一次、收到 open-path 信号再取一次，同一份文件不会被开两遍。
   * 浏览器模式没有命令行参数这条路，返回空数组就是真的空，不是假装成功。
   */
  async takeOpenPaths(): Promise<string[]> {
    if (!isTauri) return [];
    return call<string[]>("open_take_pending");
  },

  // ---------- 运行日志 ----------
  //
  // 这些方法存在的意义只有一个：让"我这边点一下没反应"能被一张日志截图说清楚。
  // 因此**任何凭据都不能进参数** —— 日志文件是用户会直接发给别人看的文本。
  // 浏览器模式不落盘：只往控制台复述一份，logInfo 如实报 dir:""。

  async logWrite(level: string, message: string, target = "web"): Promise<void> {
    if (!isTauri) {
      if (rankOf(level) > rankOf(webLogLevel)) return;
      const kind = level === "error" ? "error" : level === "warn" ? "warn" : "log";
      (console[kind] as (...a: unknown[]) => void)(`[${target}] ${message}`);
      return;
    }
    await call<void>("log_write", { level, message, target });
  },

  async logInfo(): Promise<LogInfo> {
    if (!isTauri) {
      return {
        dir: "",
        file: "",
        level: webLogLevel,
        levels: [...LOG_LEVELS],
        files: 0,
        bytes: 0,
        today: false,
      };
    }
    return call<LogInfo>("log_info");
  },

  /** 改级别：桌面版立即生效（不用重启）；浏览器模式只是把控制台过滤档位记下来。 */
  async logSetLevel(level: string): Promise<string> {
    if (!isTauri) {
      if (rankOf(level) < 0) throw new Error(`未知的日志级别: ${level}`);
      webLogLevel = level;
      return level;
    }
    return call<string>("log_set_level", { level });
  },

  async logOpenDir(): Promise<string> {
    if (!isTauri) throw new Error("浏览器模式不落盘日志，请在桌面版里打开日志目录");
    return call<string>("log_open_dir");
  },

  /** 代理当前的真实状态：active=false 时界面要老实说"这一档在本机不起作用"。 */
  async proxyStatus(): Promise<ProxyStatus> {
    if (!isTauri) {
      return {
        arg: null,
        active: false,
        message: "浏览器模式由浏览器自己决定代理，这里的手动设置不参与。",
      };
    }
    return call<ProxyStatus>("proxy_status");
  },

  // ---------- 崩溃记录 ----------
  //
  // 与 Rust 侧一致：只写本机，一个字节都不上传。桌面版的开关在 Rust 里同步
  // （关着时 panic 也不会落盘），浏览器版的开关由调用方读设置决定，
  // 所以这里的浏览器分支只负责"这一份记在哪儿"，不再判断开关。

  /** 返回落盘路径；关着或浏览器模式没有路径可给时返回 null —— 那不是失败。 */
  async crashReport(kind: string, message: string, detail = ""): Promise<string | null> {
    if (!isTauri) {
      memCrash.push({ at: Date.now(), kind, message, detail });
      while (memCrash.length > CRASH_KEEP) memCrash.shift();
      return null;
    }
    return call<string | null>("crash_report", { kind, message, detail });
  },

  async crashInfo(): Promise<CrashInfo> {
    if (!isTauri) {
      const cfg = lsGet<Record<string, unknown>>(LS_CONFIG, {}) as {
        advanced?: { crashReport?: boolean };
      };
      return {
        dir: "",
        files: memCrash.length,
        bytes: memCrash.reduce((s, r) => s + r.kind.length + r.message.length + r.detail.length, 0),
        enabled: cfg.advanced?.crashReport === true,
        latest: memCrash.length ? `本次会话共 ${memCrash.length} 次` : "",
      };
    }
    return call<CrashInfo>("crash_info");
  },

  async crashOpenDir(): Promise<string> {
    if (!isTauri) throw new Error("浏览器模式不落盘崩溃记录，请在桌面版里打开记录目录");
    return call<string>("crash_open_dir");
  },
};

/** <input> 兜底路径没有 createWritable，写回失败就交回调用方下载。 */
export async function writeHandleSafe(path: string, bytes: Uint8Array): Promise<boolean> {
  try {
    return await writeHandle(path, bytes);
  } catch {
    return false;
  }
}

const memSecrets = new Map<string, string>();

/** 与 Rust crash.rs 的 KEEP_FILES 同规格：浏览器里随标签页消失，但淘汰规则要一样。 */
const CRASH_KEEP = 20;
const memCrash: { at: number; kind: string; message: string; detail: string }[] = [];

/**
 * 日志档位，顺序即阈值（与 Rust log.rs 的 RANKS 同一份语义：数组下标 = 级别秩）。
 * 浏览器模式没有落盘那一段，控制台至少按这个档位过滤，两边行为才分得出对错。
 */
const LOG_LEVELS = ["off", "error", "warn", "info", "debug"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
let webLogLevel: string = "info";

/** 认不出来的级别返回 -1：调用方要么拒绝，要么按 info 处理，不能默默当成 0。 */
function rankOf(level: string): number {
  return LOG_LEVELS.indexOf(level as LogLevel);
}

// ---------- 原生选择框 / 事件（浏览器模式各自退化） ----------

export interface PickOptions {
  title?: string;
  defaultPath?: string;
  filters: { name: string; extensions: string[] }[];
}

export async function pickOpenPath(opts: PickOptions): Promise<string | null> {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const r = await open({
      title: opts.title,
      defaultPath: opts.defaultPath,
      filters: opts.filters,
    });
    return typeof r === "string" ? r : null;
  }
  const w = window as unknown as {
    showOpenFilePicker?: (o: unknown) => Promise<FileSystemFileHandle[]>;
  };
  if (w.showOpenFilePicker) {
    try {
      const [h] = await w.showOpenFilePicker({
        multiple: false,
        types: opts.filters.map((f) => ({
          description: f.name,
          accept: { "application/octet-stream": f.extensions.map((e) => `.${e}`) },
        })),
      });
      remember(h);
      return h.name;
    } catch {
      return null; // 用户按了取消
    }
  }
  return pickByInput(opts.filters);
}

export async function pickSavePath(opts: PickOptions): Promise<string | null> {
  if (isTauri) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const r = await save({
      title: opts.title,
      defaultPath: opts.defaultPath,
      filters: opts.filters,
    });
    return r ?? null;
  }
  const w = window as unknown as {
    showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle>;
  };
  if (w.showSaveFilePicker) {
    try {
      const h = await w.showSaveFilePicker({
        suggestedName: opts.defaultPath?.split(/[\\/]/).pop(),
        types: opts.filters.map((f) => ({
          description: f.name,
          accept: { "application/octet-stream": f.extensions.map((e) => `.${e}`) },
        })),
      });
      remember(h);
      return h.name;
    } catch {
      return null;
    }
  }
  return opts.defaultPath?.split(/[\\/]/).pop() ?? null;
}

/** 没有 File System Access 时（Firefox / Safari）的最后一档：隐藏 input 取文件。 */
async function pickByInput(filters: PickOptions["filters"]): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = filters
      .flatMap((f) => f.extensions)
      .map((e) => `.${e}`)
      .join(",");
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      handles.set(f.name, syntheticHandle(f));
      resolve(f.name);
    };
    input.click();
  });
}

function remember(h: FileSystemFileHandle): void {
  handles.set(h.name, h);
}

/** 把 <input> 选到的 File 伪装成句柄，读得到字节；写盘仍只能退化成下载。 */
function syntheticHandle(file: File): FileSystemFileHandle {
  return {
    name: file.name,
    async getFile() {
      return file;
    },
  } as unknown as FileSystemFileHandle;
}

/** 浏览器模式下把字节真正写回句柄；没有句柄时返回 false，调用方改走下载。 */
export async function writeHandle(path: string, bytes: Uint8Array): Promise<boolean> {
  const h = handles.get(path);
  if (!h) return false;
  const w = await h.createWritable();
  await w.write(bytes as unknown as BlobPart);
  await w.close();
  return true;
}

export async function readHandle(path: string): Promise<Uint8Array | null> {
  const h = handles.get(path);
  if (!h) return null;
  const f = await h.getFile();
  return new Uint8Array(await f.arrayBuffer());
}

/** 与 Rust 的 emit 对齐：前端也发同名事件，浏览器模式自己用。 */
export async function listen(name: string, fn: (payload: unknown) => void): Promise<() => void> {
  if (!isTauri) return () => {};
  const { listen: tauriListen } = await import("@tauri-apps/api/event");
  const un = await tauriListen(name, (e) => fn(e.payload));
  return un;
}

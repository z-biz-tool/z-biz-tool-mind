/**
 * 崩溃记录的前端入口：只写本机，不上传。
 *
 * 为什么不并进 _shared/ErrorBoundary：崩溃有三个来源 —— 视图渲染抛错、window 上没人接的
 * error、Promise 没 catch 的 rejection。三条都要过同一个开关，而错误边界只盖得住第一条。
 *
 * 这里绝不抛错：调用点大多本身就在 catch 或 componentDidCatch 里，
 * 上报失败要是再把异常抛回去，一次故障就变成两次。
 */
import { native } from "./native.ts";
import { useSettings } from "../stores/settingsStore.ts";

/**
 * 同一处故障只留一份。
 *
 * 一个每帧都抛错的渲染循环能在几秒里塞满 requestAnimationFrame 次上报，
 * 而 Rust 那边只留最新 20 份 —— 最先那次、也就是最有用的那份会被后面刷屏的顶掉。
 */
const seen = new Set<string>();

/**
 * 开关的判定顺序：先看已加载的设置，没加载完就交给外壳去判。
 *
 * 桌面端这样才对：Rust 在启动时就把 crashReport 读进了自己的阈值，
 * 前端此刻还没拉回配置不代表用户没开过它。浏览器端没有 Rust，落不了盘也就无所谓。
 */
function switchOn(): boolean {
  const s = useSettings.getState();
  if (!s.loaded) return true;
  return s.settings.advanced.crashReport;
}

export async function reportCrash(kind: string, message: string, detail = ""): Promise<void> {
  if (!switchOn()) return;
  const key = `${kind}|${message.slice(0, 200)}`;
  if (seen.has(key)) return;
  // 记满了就重新起一轮：这是个防刷屏的临时集合，不是要留的账本。
  if (seen.size >= 200) seen.clear();
  seen.add(key);
  try {
    await native.crashReport(kind, message, detail);
  } catch {
    /* 记录崩溃这件事本身失败了，就只到这里为止 */
  }
}

/**
 * 挂上 window 的两条兜底监听。返回卸载函数，给 StrictMode 的双挂载用。
 *
 * unhandledrejection 单独记一类：Promise 里漏 catch 在浏览器控制台只是一行黄字，
 * 用户那边是"点了按钮什么也没发生"，没有这一条就只能靠猜。
 */
export function installCrashWatch(): () => void {
  const onError = (e: ErrorEvent) => {
    void reportCrash(
      "window-error",
      e.message || "未捕获错误（无消息）",
      e.error instanceof Error ? (e.error.stack ?? "") : ""
    );
  };
  const onRejection = (e: PromiseRejectionEvent) => {
    const r = e.reason;
    void reportCrash(
      "unhandled-rejection",
      r instanceof Error ? r.message : String(r),
      r instanceof Error ? (r.stack ?? "") : ""
    );
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}

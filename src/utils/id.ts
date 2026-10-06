/**
 * 标识符与"给人看的串"。
 *
 * 这三个函数放一个文件是因为它们都不碰文档模型，只把 Date / 字节数 / 随机数变成展示层文本，
 * 所以任何层都能引它 —— 反过来（让 model 或 engine 依赖 UI）是不允许的。
 */

/**
 * UUID v4。优先用 WebCrypto：Tauri 与浏览器都有，且它给的才是真随机；
 * Math.random 那条后备只在本机拿不到 crypto 时走（新文档的 GUID 要进 .emmx 的 DocID，
 * 两份文件同名不同内容时全靠它区分历史版本）。
 */
export function newDocGuid(): string {
  const rnd = globalThis.crypto?.randomUUID?.();
  if (rnd) return rnd;
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** "2026-10-06 15:04" —— 到分钟：自动保存与快照列表按分钟粒度就够读了。 */
export function timestampName(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** "1.2 MB"。一位小数是刻意的：用户判断"这文件大不大"看的是量级不是精度。 */
export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let ix = 0;
  while (v >= 1024 && ix < units.length - 1) {
    v /= 1024;
    ix += 1;
  }
  // 整数位就不带 ".0"（512 KB 比 512.0 KB 更像人话），字节档不出现小数。
  const text = ix === 0 ? String(Math.round(v)) : v >= 100 ? String(Math.round(v)) : v.toFixed(1);
  return `${text} ${units[ix]}`;
}

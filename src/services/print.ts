/**
 * 把打印文档交给系统的打印框（§3.11 的"预览 + 打印"那一步）。
 *
 * 为什么是隐藏 iframe 而不是 `window.print()`：主文档就是应用本身，
 * 直接打主文档会把工具栏、侧栏、对话框一起打到纸上。iframe 里只装那一叠页面，
 * 打印框拿到的也就是它 —— 这也让"浏览器模式"下（没有 Tauri 宿主）同一条路能走通。
 *
 * 唯一的失败口径是"这个 WebView 根本没有 print"：那给的是中文原因和替代动作
 * （改用"打印到文件"），不是默默转完圈什么都不发生。
 */

export function printSupported(): boolean {
  return typeof document !== "undefined" && typeof window !== "undefined" && "print" in window;
}

/** iframe 装载 → 打印 → 收手。打印框是同步阻塞的，所以移除要等 afterprint，不能立刻 remove。 */
export function printHtmlDocument(html: string, keepMs = 120_000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!printSupported()) {
      reject(new Error("当前环境不支持打印，请改用「打印到文件」"));
      return;
    }
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("title", "打印内容");
    // 不能 display:none：那样 WebView 不给它排版，打出来是空白页。
    frame.style.cssText =
      "position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none";
    let settled = false;
    const drop = () => {
      if (frame.parentNode) frame.parentNode.removeChild(frame);
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      window.setTimeout(drop, 1_000);
      fn();
    };
    frame.onload = () => {
      const w = frame.contentWindow;
      if (!w || typeof w.print !== "function") {
        finish(() =>
          reject(new Error("打印框打不开（当前 WebView 未提供 print），请改用「打印到文件」"))
        );
        return;
      }
      try {
        w.focus();
        w.print();
        finish(resolve);
      } catch (e) {
        finish(() => reject(e instanceof Error ? e : new Error(String(e))));
      }
    };
    frame.onerror = () => finish(() => reject(new Error("打印文档装载失败，请重试")));
    window.setTimeout(
      () => finish(() => reject(new Error("打印超时：系统没有响应，请改用「打印到文件」"))),
      keepMs
    );
    frame.srcdoc = html;
    document.body.appendChild(frame);
  });
}

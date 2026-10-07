/**
 * 主题：把设置里的 light/dark/system 变成 antd 的 token，并同步到 <html data-theme>。
 * CSS 变量走 data-theme 而不是 JS 内联样式，是因为 shared-style.css 里有一批
 * 画布与面板共用的颜色；两边不一致时，界面会"半深半浅"，这类 bug 只能从唯一真相源避免。
 */
import { ConfigProvider, theme as antdTheme } from "antd";
import zhCN from "antd/locale/zh_CN";
import { useEffect, useState, type ReactNode } from "react";
import { useSettings } from "../stores/settingsStore.ts";
import { useUi } from "../stores/uiStore.ts";
import type { ThemeMode } from "../model/constants.ts";

export type { ThemeMode };

function prefersDark(): boolean {
  return (
    typeof window !== "undefined" && !!window.matchMedia?.("(prefers-color-scheme: dark)").matches
  );
}

/** 系统模式下订阅媒体查询，用户在 OS 里切主题时不需要重启应用；其它模式不挂监听。 */
function useSystemDark(mode: ThemeMode): boolean | null {
  const [dark, setDark] = useState<boolean | null>(
    mode === "system" ? (prefersDark() ? true : false) : null
  );
  useEffect(() => {
    if (mode !== "system") {
      setDark(null);
      return;
    }
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    setDark(mq.matches);
    const apply = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [mode]);
  return dark;
}

export function useTheme(): { mode: ThemeMode; actual: "light" | "dark" } {
  const mode = useSettings((s) => s.settings.general.theme);
  const systemDark = useSystemDark(mode);
  return { mode, actual: mode === "system" ? (systemDark ? "dark" : "light") : mode };
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const { actual } = useTheme();
  // 缩放档位挂在 CSS 变量上：画布与字体比例一起走，不会出现字号没变的"假缩放"。
  const zoom = useUi((s) => s.zoom);
  useEffect(() => {
    document.documentElement.dataset.theme = actual;
    document.documentElement.style.setProperty("--zm-zoom", String(zoom));
  }, [actual, zoom]);

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: actual === "dark" ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: { fontSize: 13, borderRadius: 4, colorPrimary: "#3a7afe" },
      }}
    >
      {children}
    </ConfigProvider>
  );
}

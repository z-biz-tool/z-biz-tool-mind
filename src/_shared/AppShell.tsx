import type { ReactNode } from "react";

/**
 * 应用外框：标题栏 + 工具条 + 主体 + 状态栏。
 *
 * 只负责摆放和滚动区域，不认识任何业务：六个投影、导出对话框都往 children 里塞，
 * 这样"哪个投影在场"永远不会反过来影响外壳的尺寸计算（外壳一旦出现第二个
 * 布局分支，折叠面板和画布的滚动条就会在不同投影下表现不一致）。
 */
export function AppShell({
  title,
  dirty,
  toolbar,
  tabs,
  status,
  aside,
  children,
}: {
  title: ReactNode;
  dirty?: boolean;
  toolbar?: ReactNode;
  tabs?: ReactNode;
  status?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="zm-shell">
      <header className="zm-header">
        <div className="zm-title">
          <span className="zm-title-text">{title}</span>
          {dirty && <span className="zm-dot" title="有未保存的修改" />}
        </div>
        <div className="zm-toolbar">{toolbar}</div>
      </header>
      {tabs && <div className="zm-tabs">{tabs}</div>}
      <main className="zm-body">
        <div className="zm-main">{children}</div>
        {aside && <aside className="zm-aside">{aside}</aside>}
      </main>
      <footer className="zm-footer">{status}</footer>
    </div>
  );
}

export function ToolGroup({ children }: { children: ReactNode }) {
  return <div className="zm-toolgroup">{children}</div>;
}

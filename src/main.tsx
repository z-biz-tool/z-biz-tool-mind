/**
 * 挂载点。
 *
 * 除了 createRoot 什么都不做：provider 栈在 App.tsx 里（对齐 _ref-terminal 的分层），
 * 这里只负责找到 #root 并把全局样式接上。
 *
 * StrictMode 保留：注册快捷键、起自动保存定时器、启动时查快照这三件事都写了 cleanup，
 * dev 下的双挂载正好是它们的回归测试 —— 摘掉 StrictMode 只是把这类 bug 推迟到用户身上。
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

const host = document.getElementById("root");
if (!host) throw new Error("index.html 里没有 #root，页面无法挂载");

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

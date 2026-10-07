/**
 * 崩溃记录的前端一侧：开关判定、防刷屏、监听装卸。
 *
 * 覆盖的缺陷形状：
 * 1) 开关关着时一次都不许写 —— 这是界面对用户许下的话，不是"尽量少写"；
 * 2) 设置还没读回来时不能默默当成关：桌面侧的阈值才是裁判（Rust 启动时就同步过）；
 * 3) 同一处故障只留一份。一个每帧抛错的循环会把最新 20 份的额度刷满，
 *    把最有用的第一次挤掉；
 * 4) window 的 error 与 unhandledrejection 都要接得住，reason 不是 Error 也不能炸；
 * 5) 卸载函数真的要摘掉监听（StrictMode 双挂载下这里漏了就是双份记录）；
 * 6) 上报这条路自己失败时不许把异常抛回调用方 —— 调用方本来就在 catch 里。
 */
import { done, eq, ok, rejects } from "./_harness.ts";
import { native } from "../src/services/native.ts";
import { installCrashWatch, reportCrash } from "../src/services/crash.ts";
import { DEFAULT_SETTINGS, useSettings } from "../src/stores/settingsStore.ts";

/** 把 store 摆成某种状态：node 里没有 localStorage，浏览器模式的 crashReport 只能由这里说话。 */
function setSwitch(on: boolean, loaded = true): void {
  useSettings.setState({
    loaded,
    settings: {
      ...DEFAULT_SETTINGS,
      advanced: { ...DEFAULT_SETTINGS.advanced, crashReport: on },
    },
  });
}

async function files(): Promise<number> {
  return (await native.crashInfo()).files;
}

/** 等一轮宏任务：reportCrash 是 void 调用，测试不能假设它同步走完。 */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

const listeners = new Map<string, (e: never) => void>();
(globalThis as unknown as { window: unknown }).window = {
  addEventListener: (name: string, fn: (e: never) => void) => listeners.set(name, fn),
  removeEventListener: (name: string) => void listeners.delete(name),
};

async function main(): Promise<void> {
  const start = await files();
  eq("起始没有记录", start, 0);

  setSwitch(false);
  await reportCrash("render:关着", "这条不该落盘", "stack");
  await flush();
  eq("开关关着时一个字节都不写", await files(), start);

  setSwitch(true);
  await reportCrash("render:投影「思维导图」", "布局炸了", "at layout");
  await flush();
  eq("开着时记一份", await files(), start + 1);

  await reportCrash("render:投影「思维导图」", "布局炸了", "at layout");
  await flush();
  eq("同一处故障只留一份", await files(), start + 1);

  await reportCrash("render:投影「思维导图」", "布局又炸了", "at layout");
  await flush();
  eq("换了消息就另记一份", await files(), start + 2);

  await reportCrash("window-error", "循环里炸了", "");
  await flush();
  eq("另一类来源也算一份", await files(), start + 3);

  // 设置还没读回来：不能当成"关"，交给外壳判断（桌面侧启动时已按磁盘上的开关同步过）。
  const pendingStart = await files();
  setSwitch(false, false);
  await reportCrash("window-error", "读回来之前就崩了", "stack");
  await flush();
  eq("未加载完时不静默丢掉", await files(), pendingStart + 1);

  const off = installCrashWatch();
  ok("挂上了 error 监听", listeners.has("error"));
  ok("挂上了 unhandledrejection 监听", listeners.has("unhandledrejection"));

  setSwitch(true);
  const watchStart = await files();
  const onError = listeners.get("error");
  onError?.({ message: "顶层没接的错误", error: new Error("顶层没接的错误") } as never);
  await flush();
  eq("window error 会落一份", await files(), watchStart + 1);

  const onRejection = listeners.get("unhandledrejection");
  onRejection?.({ reason: "后端返回 500" } as never);
  await flush();
  eq("reason 不是 Error 也记下来", await files(), watchStart + 2);

  onRejection?.({ reason: new Error("Promise 里漏了 catch") } as never);
  await flush();
  eq("Error 形态的 reason 记消息", await files(), watchStart + 3);

  onError?.({ message: "", error: null } as never);
  await flush();
  eq("没有消息的错误也要有一句", await files(), watchStart + 4);

  off();
  ok("卸载后摘掉了 error", !listeners.has("error"));
  ok("卸载后摘掉了 rejection", !listeners.has("unhandledrejection"));

  // 浏览器模式不落盘：dir 为空，面板据此显示"（浏览器模式不落盘）"。
  const info = await native.crashInfo();
  eq("浏览器模式没有目录", info.dir, "");
  eq("浏览器模式份数仍在会话里", info.files, watchStart + 4);
  await rejects("浏览器模式打开目录会报错", native.crashOpenDir(), "浏览器模式");

  done();
}

void main();

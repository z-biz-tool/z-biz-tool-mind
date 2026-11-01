/**
 * ctc 统一 SSO（ctc 侧）的 mind 适配层。
 *
 * ## 分工（**别把协议逻辑搬到这里**）
 *
 * - 协议流程：`z-biz-tool-shared/src/sso/oauth.ts`（能被 node 单测覆盖）
 * - IO 胶水：`src-tauri/src/sso.rs`（cap-sso：回环服务器 / 开浏览器 / 密钥库）
 * - **Tauri 适配**：`z-biz-tool-shared/src/sso/tauriAdapter.ts`（家族共用）
 * - 本文件：mind 特有的两件事 —— **ctc 端点配置** 与 **会员态衔接**
 *
 * ## 为什么 mind 的配置是编译期常量，而 remote 是从服务端拉
 *
 * remote 有服务端，`GET /api/sso/config` 可以下发 ctc 端点。
 * mind 是**纯本地桌面应用**，没有服务端 —— 端点只能烧进二进制。
 *
 * 这有一个真实代价：ctc 换域名 / 换 client_id 时，mind 要发一次版。
 * 接受这个代价的理由是：
 * - 家族 14 个纯本地仓都是这个形态，再建一套「配置分发服务」是另一条产品线；
 * - ctc 端点极少变（域名与 client_id 是年度级变更，不是日常运维）。
 *
 * ## 「未配置」是常态，不是错误
 *
 * ctc 侧参数（client_id / 端点 / redirect_uri 登记）**至今未定**。
 * 所以这里把「没配置」做成**一等状态**：
 * - 配置不全 ⇒ `ssoConfigured()` 返回 false ⇒ **界面上根本不出现 SSO 入口**；
 * - 用户不会看到一个点了必失败的按钮。
 *
 * 这与 remote 服务端「没配就返 204」是同一条原则：
 * **半套配置比没有配置更糟**。
 */
import {
  createTauriSsoEnvironment,
  createTauriSsoSessionStore,
  secureStoreAvailable,
  startSsoLogin,
  type SsoServerConfig,
} from "z-biz-tool-shared/sso/tauri";
import type { SsoResult, SsoSession } from "z-biz-tool-shared/sso";
import { call } from "./native.ts";

/**
 * 本仓用到的 SSO 命令 —— 显式列一遍。
 *
 * ## 为什么要显式列，而不是直接把 `invoke` 塞给共享层
 *
 * 共享层的适配器把命令名当**运行时字面量**用（`invoke("sso_start_callback")`），
 * 那个文件在 shared 仓里，mind 的 ipcContract 门禁扫不到它。
 * 于是「Rust 注册了命令 ⇒ 前端必须调得到」这条契约就断了 ——
 * 门禁会报「命令实现了、注册了，却既没有界面入口、也没登记为预留」。
 *
 * 所以这里把**每个命令的真实调用点**写在 mind 仓里：既是门禁能扫到的证据，
 * 也是「这个仓到底用了哪几个 SSO 命令」的一份可读清单。
 *
 * ## 为什么走 `native.ts` 的 `call` 而不是直接 import `invoke`
 *
 * - mind 的 IPC 出口只有 `native.ts` 那一个。直接 import `invoke` 会绕过
 *   浏览器后备分支 —— 浏览器模式下 `invoke` 抛的是 IPC 层的怪错误，
 *   `call` 抛的是一句人话；
 * - 仓内的 ipcContract 门禁扫的是 `call("…")` 字面量，走别的出口它认不出来。
 *
 * 下面的 `invokeByName` 让共享层复用这些调用点 —— 不是各写一遍。
 */
export const ssoCommands = {
  startCallback: () => call<number>("sso_start_callback"),
  waitCallback: () => call<string>("sso_wait_callback"),
  cancelCallback: () => call<void>("sso_cancel_callback"),
  openBrowser: (url: string) => call<void>("sso_open_browser", { url }),
  setTokens: (value: string) => call<void>("sso_set_tokens", { value }),
  getTokens: () => call<string | null>("sso_get_tokens"),
  clearTokens: () => call<void>("sso_clear_tokens"),
  secureStoreAvailable: () => call<boolean>("sso_secure_store_available"),
};

/**
 * 把共享层适配器要的 `invoke` 接上本仓的命令清单。
 *
 * 共享层是按**命令名**调 invoke 的，所以这里按名字分发 ——
 * 好处是「命令名拼错」会在本仓立刻变成一个显式的 undefined，
 * 而不是悄悄发一个不存在的命令给 Rust。
 */
const invokeByName = async <T = unknown>(
  cmd: string,
  args?: Record<string, unknown>
): Promise<T> => {
  switch (cmd) {
    case "sso_start_callback":
      return (await ssoCommands.startCallback()) as T;
    case "sso_wait_callback":
      return (await ssoCommands.waitCallback()) as T;
    case "sso_cancel_callback":
      return (await ssoCommands.cancelCallback()) as T;
    case "sso_open_browser":
      return (await ssoCommands.openBrowser(String(args?.url ?? ""))) as T;
    case "sso_set_tokens":
      return (await ssoCommands.setTokens(String(args?.value ?? ""))) as T;
    case "sso_get_tokens":
      return (await ssoCommands.getTokens()) as T;
    case "sso_clear_tokens":
      return (await ssoCommands.clearTokens()) as T;
    case "sso_secure_store_available":
      return (await ssoCommands.secureStoreAvailable()) as T;
    default:
      throw new Error(`未登记的 SSO 命令：${cmd}`);
  }
};

/**
 * ctc 侧的接入参数（2026-11-01 起有真值 —— ctc 侧 OAuth 授权服务器已上生产，
 * 见 z-ctc `c20882c` + `e22d209`；client `z-biz-tool-mind` 已在生产 ConfigMap
 * 预登记，redirect 白名单为 loopback 任意端口形态，127.0.0.1 任意端口 + /callback 路径）。
 *
 * 端点是**公网边缘路由真值**（2026-11-01 实测 200/400 正常）：
 *   https://opc.zopc.top/kapi/z-ctc/api/ctc/oauth/{authorize|token|userinfo}
 */
export const CTC_CONFIG = {
  authorizeUrl: "https://opc.zopc.top/kapi/z-ctc/api/ctc/oauth/authorize",
  tokenUrl: "https://opc.zopc.top/kapi/z-ctc/api/ctc/oauth/token",
  userInfoUrl: "https://opc.zopc.top/kapi/z-ctc/api/ctc/oauth/userinfo",
  clientId: "z-biz-tool-mind",
  scope: "openid profile email",
};


/**
 * SSO 配置是否齐全。
 *
 * **判据只有这一份**，UI 与登录流程都问它 ——
 * 界面按 `ssoConfigured()` 决定要不要显示入口，流程按它决定要不要启动。
 * 两处各判一次必然漂移：某天加了一个必填项，UI 还显示入口而流程拒绝启动。
 */
export function ssoConfigured(): boolean {
  return Boolean(
    CTC_CONFIG.authorizeUrl &&
      CTC_CONFIG.tokenUrl &&
      CTC_CONFIG.clientId &&
      CTC_CONFIG.scope
  );
}

/** SSO 会话存储（token 进 OS 密钥库，展示信息进 localStorage）。 */
export const ssoSessionStore = createTauriSsoSessionStore(invokeByName);

/** 探测密钥库是否可用。不可用时不该显示 SSO 入口。 */
export async function ssoSecureStoreAvailable(): Promise<boolean> {
  return await secureStoreAvailable(invokeByName);
}

/**
 * 起一轮登录。
 *
 * 未配置时直接返回失败 —— **不是抛异常**：调用方据结果决定提示文案，
 * 而「SSO 没启用」是个正常状态，不该炸出调用栈。
 */
export async function login(): Promise<SsoResult<SsoSession>> {
  if (!ssoConfigured()) {
    return {
      ok: false,
      code: "config",
      reason: "本应用尚未接入统一登录。",
    };
  }
  const config: SsoServerConfig = {
    authorizeUrl: CTC_CONFIG.authorizeUrl,
    tokenUrl: CTC_CONFIG.tokenUrl,
    userInfoUrl: CTC_CONFIG.userInfoUrl || undefined,
    clientId: CTC_CONFIG.clientId,
    scope: CTC_CONFIG.scope,
  };
  const result = await startSsoLogin(config, invokeByName);
  if (result.ok) {
    // 登录成功必须落盘 —— 否则重启即丢登录态，而启动时的
    // 「上次是谁登录的」永远读到 null。失败不阻断登录结果：
    // 会话已在内存里，这次登录仍然算成功，只是下次启动要重登。
    await ssoSessionStore
      .save({
        accessToken: result.value.accessToken,
        refreshToken: result.value.refreshToken,
        expiresAt: result.value.expiresAt,
        tokenType: result.value.tokenType,
        user: result.value.user,
      })
      .catch(() => undefined);
  }
  return result;
}

/** 退出登录：清掉密钥库里的会话。 */
export async function logout(): Promise<void> {
  await ssoSessionStore.clear();
}

/** 读回已保存的会话（用于「上次是谁登录的」）。 */
export async function loadSession(): Promise<{ tokens: unknown; profile: unknown } | null> {
  return await ssoSessionStore.load();
}

/**
 * 造一个跑在 Tauri 里的 SSO 环境（供测试与将来的「静默登录」用）。
 *
 * 单独导出来是因为它带 `redirectUri` —— 那是拼出来的、随实际端口变的东西，
 * 调用方有时需要单独拿它（比如拼一个「授权失败」的提示链接）。
 */
export { createTauriSsoEnvironment };

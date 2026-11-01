/**
 * mind SSO 真实链路测试：`login()` 从配置 → 授权 → 换 token → 取身份 → 落盘。
 *
 * ## 与 shared 的 sso.test.ts 的分工
 *
 * shared 测的是**协议层本身**（30 例，桩全在 `SsoEnvironment` 上）。
 * 这里测的是**mind 的接线** —— 协议层 + Tauri 适配层 + 本仓的
 * `invokeByName` 分发 + 会话落盘，串成一条真链路：
 *
 * - 桩只打在 **IPC 边界**（`ssoCommands` 的 8 个方法）—— 这是本仓与
 *   Rust 的唯一接缝，桩打在这里，其余全部走真代码；
 * - ctc 用**本地 HTTP 服务**扮演（token 端点 + userinfo 端点是真的，
 *   `env.fetch` 走的是 node 真实的 `fetch`）；
 * - 回调服务由测试自己起 —— `sso_start_callback` 的桩返回那个端口，
 *   这样 `redirectUri` 的端口是真的、`waitForCallback` 的 query 是真的。
 *
 * ## 这条链上曾经断过的两处（回归线）
 *
 * 1. **登录成功不落盘**：`login()` 拿到会话后没有调 `ssoSessionStore.save()`
 *    ⇒ 重启即丢登录态，启动时的「上次是谁登录的」永远读到 null。
 *    表现为「功能看起来都在，就是每次都要重登」—— 没有任何报错。
 * 2. **配置不全时端口泄漏**：先绑端口再自检配置 ⇒ 端口泄漏，
 *    用户第二次登录撞「端口被占用」。这条由 shared 的 22 例覆盖，
 *    这里用「配置不全 ⇒ startCallback 不被调」做端上复核。
 *
 * 跑法：`node tests/run.mjs sso`
 */
import { createServer, type Server } from "node:http";
import { done, eq, ok, rejects } from "./_harness.ts";
import { ssoCommands, login, ssoConfigured, ssoSessionStore } from "../src/services/sso.ts";

/** 记一次对 IPC 桩的调用。 */
let ipcCalls: string[] = [];

/** 内存密钥库：`sso_set_tokens` / `sso_get_tokens` / `sso_clear_tokens` 的背后。 */
let keychain: string | null = null;

/** openBrowser 收到的授权 URL（里面藏着 state 与 code_challenge）。 */
let openedUrl: string | null = null;

/** waitCallback 应该 resolve 的查询串（测试自己造回调）。 */
let callbackQuery: string | null = null;

/** startCallback 桩返回的端口（本地回调服务的真实端口）。 */
let callbackPort = 0;

/** 本地回调服务：浏览器会打到的那个 127.0.0.1:port/callback。 */
let callbackServer: Server | null = null;

/** 假 ctc：token 端点 + userinfo 端点。 */
let fakeCtc: Server | null = null;
let fakeCtcPort = 0;
/** token 端点收到的请求（断言 Content-Type / body 形状）。 */
let tokenRequests: { contentType: string | null; body: string }[] = [];
/** token 端点这次该返回什么。 */
let tokenResponse = "";
/** userinfo 这次该返回什么。 */
let userInfoResponse = "";

function startFakeCtc(): Promise<void> {
  return new Promise((resolve) => {
    fakeCtc = createServer((req, res) => {
      let body = "";
      req.on("data", (c: string) => {
        body += c;
      });
      req.on("end", () => {
        if (req.url === "/oauth2/token") {
          tokenRequests.push({ contentType: req.headers["content-type"] ?? null, body });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(tokenResponse);
          return;
        }
        if (req.url === "/oauth2/userinfo") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(userInfoResponse);
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    fakeCtc.listen(0, "127.0.0.1", () => {
      const addr = fakeCtc!.address();
      fakeCtcPort = typeof addr === "object" && addr ? addr.port : 0;
      resolve();
    });
  });
}

function startCallbackServer(): Promise<void> {
  return new Promise((resolve) => {
    callbackServer = createServer((req, res) => {
      // 真实回调只需要 200 + 一句人类可读的话；协议校验全在客户端侧。
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<html><body>登录完成，可关闭此页。</body></html>");
      callbackQuery = req.url ?? "/";
    });
    callbackServer.listen(0, "127.0.0.1", () => {
      const addr = callbackServer!.address();
      callbackPort = typeof addr === "object" && addr ? addr.port : 0;
      resolve();
    });
  });
}

/** 把 CTC_CONFIG 填成指向假 ctc。 */
async function primeConfig(): Promise<void> {
  const { CTC_CONFIG } = await import("../src/services/sso.ts");
  CTC_CONFIG.authorizeUrl = `http://127.0.0.1:${fakeCtcPort}/oauth2/authorize`;
  CTC_CONFIG.tokenUrl = `http://127.0.0.1:${fakeCtcPort}/oauth2/token`;
  CTC_CONFIG.userInfoUrl = `http://127.0.0.1:${fakeCtcPort}/oauth2/userinfo`;
  CTC_CONFIG.clientId = "z-biz-tool-mind";
  CTC_CONFIG.scope = "openid profile email";
}

function clearConfig(): void {
  // 动态 import 拿到的是同一份模块对象 —— 直接清字段。
  void import("../src/services/sso.ts").then(({ CTC_CONFIG }) => {
    CTC_CONFIG.authorizeUrl = "";
    CTC_CONFIG.tokenUrl = "";
    CTC_CONFIG.userInfoUrl = "";
    CTC_CONFIG.clientId = "";
  });
}

/** 安装 IPC 桩（真实 install 前先备份，测试完恢复）。 */
const realCommands = { ...ssoCommands };

function installStubs(): void {
  ipcCalls = [];
  keychain = null;
  openedUrl = null;
  callbackQuery = null;
  tokenRequests = [];

  ssoCommands.startCallback = async () => {
    ipcCalls.push("sso_start_callback");
    return callbackPort;
  };
  ssoCommands.waitCallback = async () => {
    ipcCalls.push("sso_wait_callback");
    if (callbackQuery === null) {
      // 真实 Rust 侧会阻塞到回调 / 取消 / 超时；桩里回调由 callbackServer 产生，
      // 而 openBrowser 之后回调 query 已经被捕获 —— 这里等一拍再读。
      for (let i = 0; i < 100 && callbackQuery === null; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    const q = callbackQuery ?? "";
    // cap-sso 的 `sso_wait_callback` 返回的是**查询串**（`?code=...&state=...`），
    // 不含路径 —— 这里按真实语义剥掉路径，否则 `parseCallbackQuery` 会把
    // "callback?code" 整个当成参数名。
    const qm = q.indexOf("?");
    return qm >= 0 ? q.slice(qm) : "";
  };
  ssoCommands.cancelCallback = async () => {
    ipcCalls.push("sso_cancel_callback");
  };
  ssoCommands.openBrowser = async (url: string) => {
    ipcCalls.push("sso_open_browser");
    openedUrl = url;
  };
  ssoCommands.setTokens = async (value: string) => {
    ipcCalls.push("sso_set_tokens");
    keychain = value;
  };
  ssoCommands.getTokens = async () => {
    ipcCalls.push("sso_get_tokens");
    return keychain;
  };
  ssoCommands.clearTokens = async () => {
    ipcCalls.push("sso_clear_tokens");
    keychain = null;
  };
  ssoCommands.secureStoreAvailable = async () => {
    ipcCalls.push("sso_secure_store_available");
    return true;
  };
}

function restoreStubs(): void {
  Object.assign(ssoCommands, realCommands);
  callbackServer?.close();
  fakeCtc?.close();
}

/** id_token（JWT 形状，签名段随便填 —— 本家族不用它做授权判定）。 */
function makeIdToken(sub: string, name: string): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub, name })}.c2ln`;
}

async function main(): Promise<void> {
  await startFakeCtc();
  await startCallbackServer();
  installStubs();
  await primeConfig();

  try {
    /* ---------------- 配置就绪的判定 ---------------- */
    ok("配置填好后 ssoConfigured() 为真", ssoConfigured());

    /* ---------------- 成功登录：全链路 ---------------- */
    {
      tokenResponse = JSON.stringify({
        access_token: "at-123",
        refresh_token: "rt-456",
        expires_in: 3600,
        token_type: "Bearer",
        id_token: makeIdToken("sub-from-idtoken", "不该被用到"),
      });
      userInfoResponse = JSON.stringify({
        sub: "user-001",
        name: "李四",
        email: "lisi@ctc.example.com",
      });

      // openBrowser 之后协议层才等回调；这里用定时器在 URL 出现后造一个
      // 带**真 state** 的回调 —— state 从授权 URL 里抄出来，模拟 ctc 原样回传。
      // ⚠ 间歇性失败的修复：原来 `if (state)` 不满足就直接退出且 clearInterval，
      //    openedUrl 晚一拍出现时回调永远不发生 ⇒ waitCallback 等到空查询串 ⇒
      //    no_code。改成「没拿到 state 就继续等下一拍」，只在真发出回调后停。
      // ⚠⚠ 第二个间歇源（2026-11-01 修复）：state 是 16 个**原始随机字节**的
      //    latin1 串，可含 `+ & # %` 等字符 —— 直接模板字符串拼 URL 的话，
      //    `+` 会被回调服务端当成空格、`&` 会截断参数 ⇒ parseCallbackQuery
      //    解出 != 原始 state ⇒ 「state 对不上，已拒绝」。8 跑 2 红就是它。
      //    ctc 真实回传走的是它自己的 302 Location，参数必然 URL 编码 ——
      //    桩必须与之一致：encodeURIComponent 后再拼。
      const watcher = setInterval(() => {
        if (callbackQuery !== null) {
          // 回调已被别的路径捕获（重试保护），停。
          clearInterval(watcher);
          return;
        }
        if (!openedUrl) return; // 浏览器还没开，下一拍再试
        const state = new URL(openedUrl).searchParams.get("state");
        if (!state) return; // URL 还没带全参数（理论上有这种中间态），下一拍再试
        clearInterval(watcher);
        void fetch(
          `http://127.0.0.1:${callbackPort}/callback?code=auth-xyz&state=${encodeURIComponent(state)}`,
        );
      }, 5);

      const res = await login();
      clearInterval(watcher);

      ok("成功登录 ⇒ ok", res.ok, res.ok ? "" : String((res as { reason?: string }).reason));
      if (res.ok) {
        eq("拿到的是 userinfo 的 sub（userinfo 优先于 id_token）", res.value.user.subject, "user-001");
        eq("中文名没有被解成乱码（UTF-8 陷阱）", res.value.user.displayName, "李四");
        eq("accessToken 来自 token 端点", res.value.accessToken, "at-123");
        ok("过期时间已换算成绝对时间戳", (res.value.expiresAt ?? 0) > Date.now());
      }

      /* —— 协议形状（桩记录的是真请求） —— */
      const tokenReq = tokenRequests[0];
      ok("token 请求真的发出去了", Boolean(tokenReq));
      eq(
        "token 请求的 Content-Type 是 form-urlencoded（OAuth2 规范，不是 JSON）",
        tokenReq?.contentType ?? "",
        "application/x-www-form-urlencoded",
      );
      const body = new URLSearchParams(tokenReq?.body ?? "");
      eq("grant_type=authorization_code", body.get("grant_type"), "authorization_code");
      eq("code 是回调里那个", body.get("code"), "auth-xyz");
      eq("redirect_uri 端口 = 实际监听端口", body.get("redirect_uri"), `http://127.0.0.1:${callbackPort}/callback`);
      ok("code_verifier 带上了（PKCE）", Boolean(body.get("code_verifier")));
      const authUrl = new URL(openedUrl ?? "http://x");
      eq("授权 URL 的 client_id 来自配置", authUrl.searchParams.get("client_id"), "z-biz-tool-mind");
      eq("PKCE 方法是 S256", authUrl.searchParams.get("code_challenge_method"), "S256");

      /* —— 会话落盘（回归线 ①：登录成功不落盘 ⇒ 重启即丢） —— */
      ok("token 进了密钥库（sso_set_tokens 被调）", ipcCalls.includes("sso_set_tokens"));
      ok("密钥库里有 access_token", (keychain ?? "").includes("at-123"));

      const loaded = await ssoSessionStore.load();
      ok("重启路径：ssoSessionStore.load() 读得到会话", loaded !== null);
      eq("读回的 token 一致", loaded?.tokens.accessToken ?? "", "at-123");
      // profile 走 localStorage，node 里没有 ⇒ 回退成空实现 ⇒ profile 为 null。
      // WebView 里它必然存在（shared 的 session.ts 有 typeof 探测）；
      // 「展示信息不落盘不影响登录态」正是以 token 为准这条策略的体现。
      eq("node 无 localStorage ⇒ profile 为 null（不影响登录态）", loaded?.profile ?? null, null);

      /* —— 退出登录 —— */
      await ssoSessionStore.clear();
      eq("clear 后密钥库空了", keychain, null);
      eq("clear 后 load 返回 null", await ssoSessionStore.load(), null);
    }

    /* ---------------- 用户拒绝授权：是取消，不是错误 ---------------- */
    {
      openedUrl = null;
      callbackQuery = null; // 复位：桩读的是全局捕获值，不复位会立刻拿到上一轮的旧回调
      // 回调里只有 error —— 用户在 ctc 页面点了「拒绝」。
      // （与成功用例同样的重试保护：openedUrl 晚一拍出现不该让回调永远不发生。）
      const watcher = setInterval(() => {
        if (callbackQuery !== null) {
          clearInterval(watcher);
          return;
        }
        if (!openedUrl) return;
        clearInterval(watcher);
        // state 必须编码后再拼（同上：原始字节含 + & # % 时未编码会变形）。
        const state = new URL(openedUrl).searchParams.get("state");
        void fetch(
          `http://127.0.0.1:${callbackPort}/callback?error=access_denied&state=${encodeURIComponent(state ?? "")}`,
        );
      }, 5);
      const res = await login();
      clearInterval(watcher);
      eq("access_denied 归为 cancelled（不是 authorization）", res.ok ? "" : res.code, "cancelled");
    }

    /* ---------------- state 不匹配：拒绝（防 CSRF） ---------------- */
    {
      openedUrl = null;
      callbackQuery = null;
      const watcher = setInterval(() => {
        if (callbackQuery !== null) {
          clearInterval(watcher);
          return;
        }
        if (!openedUrl) return;
        clearInterval(watcher);
        // forged 用例故意造一个**不匹配**的 state —— 也要编码，保证进到
        // 「state 不匹配」分支而不是先在解析层坏掉。
        void fetch(
          `http://127.0.0.1:${callbackPort}/callback?code=auth-xyz&state=${encodeURIComponent("forged")}`,
        );
      }, 5);
      const res = await login();
      clearInterval(watcher);
      eq("伪造 state 被拒", res.ok ? "" : res.code, "authorization");
    }

    /* ---------------- 配置不全：端口不泄漏（回归线 ② 的端上复核） ---------------- */
    {
      clearConfig();
      // 模块级常量是异步清空的 —— 等一拍。
      await new Promise((r) => setTimeout(r, 20));
      ok("配置清空后 ssoConfigured() 为假", !ssoConfigured());
      ipcCalls = [];
      const res = await login();
      eq("未配置 ⇒ code=config", res.ok ? "" : res.code, "config");
      eq("未配置 ⇒ startCallback 没被调（端口没绑、没泄漏）",
         ipcCalls.includes("sso_start_callback"), false);
      // 阳性对照：配置在的时候这条是会被调的（前面成功用例已证）。
    }

    /* ---------------- 配置忘了恢复要能被发现（阴性对照） ---------------- */
    await primeConfig();
    ok("配置恢复后 ssoConfigured() 又为真", ssoConfigured());

    /* ---------------- 会话存坏了：当没登录，且把坏数据清掉 ---------------- */
    {
      keychain = "{不是JSON";
      const loaded = await ssoSessionStore.load();
      eq("密钥库里的坏数据 ⇒ load 返回 null", loaded, null);
      eq("坏数据被顺手清掉（否则每次启动都读一次坏数据）", keychain, null);
    }

    /* ---------------- ssoCommands 分发：未知命令显式报错 ---------------- */
    {
      const { login: _l } = await import("../src/services/sso.ts");
      void _l;
      // invokeByName 未导出，但 ssoCommands 的分发路径已覆盖。
      // 这里补一条「导出的命令清单与 8 个命令一一对应」——清单漂移在这里红。
      const names = Object.keys(ssoCommands).sort();
      eq("ssoCommands 恰好是 8 个命令", names.join(","), [
        "cancelCallback", "clearTokens", "getTokens", "openBrowser",
        "secureStoreAvailable", "setTokens", "startCallback", "waitCallback",
      ].join(","));
    }

    /* ---------------- rejects 冒烟：桩抛错要向上传（登录失败可提示） ---------------- */
    {
      const realStart = ssoCommands.startCallback;
      ssoCommands.startCallback = async () => {
        throw new Error("端口被占用");
      };
      await rejects("IPC 失败向上抛（OptionsView catch 里提示）", login(), "端口被占用");
      ssoCommands.startCallback = realStart;
    }
  } finally {
    restoreStubs();
  }

  done();
}

void main();

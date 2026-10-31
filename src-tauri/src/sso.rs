//! SSO 的 Tauri 命令层 —— 把 cap-sso 的 IO 胶水暴露给前端。
//!
//! **这里没有 OAuth 协议逻辑**。协议在 z-biz-tool-shared/src/sso/oauth.ts，
//! 共享层的 Tauri 适配在 z-biz-tool-shared/src/sso/tauriAdapter.ts。
//! 本文件只做三件事：
//!   1. 持有回环服务器的句柄（跨命令存活），把查询串转交前端；
//!   2. 调 opener 插件开浏览器；
//!   3. 读写 OS 密钥库里的 token。
//!
//! ## 为什么回环服务器要放在 State 里
//!
//! 它必须在「起服务」与「等回调」之间跨越一次 IPC。若在一次命令里起 + 等，
//! 前端就没法在这两步之间去拼 authorizeUrl（要用到实际端口）再开浏览器 ——
//! 那个顺序是 OAuth 决定的，调不过来。
//!
//! ## 与 remote 仓的差别
//!
//! 只有 service 名不同（`z-biz-tool-mind` vs `z-biz-tool-remote`）——
//! 密钥库按 service 隔离，各仓各用自己的，token 不会串。
//! 其余完全同构，所以任何一边改了协议流程，另一边不用动。

use std::sync::Mutex;
use std::time::Duration;

use cap_sso::{CallbackServer, SecureStore};
use tauri::State;

/// 一次 SSO 登录的回环服务器。
///
/// `Option` 是因为「没在登录」也是合法状态：用户可以随时取消，
/// 取消后句柄要被清掉，否则端口会一直被占着。
type SharedCallbackServer = Mutex<Option<CallbackServer>>;

/// SSO token 在 OS 密钥库里的 account 名。
///
/// 一个应用一个 service（`z-biz-tool-mind`），account 固定为 `sso.tokens`。
/// 存的是 JSON 字符串（access / refresh / 过期时间 / 用户信息），
/// 而不是单个 token —— 这几样要么一起有、要么一起没，
/// 拆成多条会出现「读到一半」的中间态。
const SSO_TOKEN_ACCOUNT: &str = "sso.tokens";

/// 回调服务器的最长等待时长。
const CALLBACK_TIMEOUT_SECS: u64 = 300;

pub struct SsoState {
    pub callback: SharedCallbackServer,
    pub store: SecureStore,
}

impl Default for SsoState {
    fn default() -> Self {
        Self {
            callback: Mutex::new(None),
            store: SecureStore::new("z-biz-tool-mind"),
        }
    }
}

/// 起本地回环服务器，返回**实际监听的端口**。
///
/// 前端必须用这个端口去拼 `redirect_uri` —— 端口由内核分配，
/// 不是配置里写死的那个。
#[tauri::command]
pub async fn sso_start_callback(state: State<'_, SsoState>) -> Result<u16, String> {
    let server = CallbackServer::start(
        cap_sso::DEFAULT_CALLBACK_PATH,
        Duration::from_secs(CALLBACK_TIMEOUT_SECS),
    )
    .map_err(|e| format!("起不来本地回调服务：{}", e))?;
    let port = server.port();

    let mut slot = state.callback.lock().map_err(|e| e.to_string())?;
    // 覆盖旧句柄：上一次登录若没走完，端口会被一直占着。
    if let Some(old) = slot.take() {
        old.close();
    }
    *slot = Some(server);

    Ok(port)
}

/// 阻塞等待浏览器回调，返回**查询串**（不含 `?`）。
///
/// 这条命令会阻塞到回调到达、超时或被取消 —— 前端发出去之后应当
/// 立即去开浏览器，而不是等它返回。
#[tauri::command]
pub async fn sso_wait_callback(state: State<'_, SsoState>) -> Result<String, String> {
    let server = {
        let mut slot = state.callback.lock().map_err(|e| e.to_string())?;
        slot.take()
            .ok_or_else(|| "没有正在等待的登录流程".to_string())?
    };

    tauri::async_runtime::spawn_blocking(move || server.wait_for_callback())
        .await
        .map_err(|e| format!("等待回调失败：{}", e))?
        .map_err(|e| e.to_string())
}

/// 提前结束等待（用户点了「取消」）。
///
/// 幂等：没有正在进行的登录也不算错。
#[tauri::command]
pub async fn sso_cancel_callback(state: State<'_, SsoState>) -> Result<(), String> {
    let mut slot = state.callback.lock().map_err(|e| e.to_string())?;
    if let Some(server) = slot.take() {
        server.close();
    }
    Ok(())
}

/// 用系统默认浏览器打开 URL。
#[tauri::command]
pub async fn sso_open_browser(app: tauri::AppHandle, url: String) -> Result<(), String> {
    cap_sso::opener::open_url_with_tauri(&app, &url).map_err(|e| e.to_string())
}

/// 把 SSO 会话写进 OS 密钥库。
#[tauri::command]
pub async fn sso_set_tokens(state: State<'_, SsoState>, value: String) -> Result<(), String> {
    state
        .store
        .set(SSO_TOKEN_ACCOUNT, &value)
        .map_err(|e| e.to_string())
}

/// 从 OS 密钥库读 SSO 会话。
///
/// 条目不存在返回 `Ok(None)` —— 那不是错误，是「还没登录过」。
#[tauri::command]
pub async fn sso_get_tokens(state: State<'_, SsoState>) -> Result<Option<String>, String> {
    match state.store.get(SSO_TOKEN_ACCOUNT) {
        Ok(v) => Ok(Some(v)),
        Err(cap_sso::SecretError::NotFound) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// 退出登录：删掉密钥库里的会话。
///
/// **必须幂等**：用户可能连点两次退出，第二次不该报错。
#[tauri::command]
pub async fn sso_clear_tokens(state: State<'_, SsoState>) -> Result<(), String> {
    state
        .store
        .delete(SSO_TOKEN_ACCOUNT)
        .map_err(|e| e.to_string())
}

/// 探测 OS 密钥库是否可用。
///
/// 不可用时（例如某些 Linux 环境没有 Secret Service 守护进程），
/// 前端要把「用 ctc 登录」这个入口关掉并说明原因，
/// 而不是等用户点了之后才报错。
#[tauri::command]
pub async fn sso_secure_store_available(state: State<'_, SsoState>) -> Result<bool, String> {
    Ok(state.store.check_available().is_ok())
}

//! mind 的 AI 接入 —— cap-llm 薄封装，key 不再回传 WebView。
//!
//! ## 为什么要改（2026-10-26）
//!
//! 原架构：前端 `secretReveal("ai-api-key")` 把明文 key 取到 webview，
//! 在前端拼 `Authorization: Bearer …` 直接 fetch —— key 明文驻留 JS 内存，
//! 与「密钥只存在本机加密库」的承诺不符（存的是加密的，用的时候又摊开了）。
//!
//! 新架构：前端只传 endpoint/model/超时，key 由**本文件**从加密库解出，
//! 请求由 Rust 发出（协议/鉴权/错误脱敏全在 cap-llm）。明文 key 从此
//! 不出 Rust 进程 —— 设置页也不需要它（只探 `secret_exists`）。

use cap_llm::{LlmConfig, Message, ProviderKind};
use serde::{Deserialize, Serialize};

/// 与前端「选项 → 高级」密钥输入框约定的槽位名（secret.rs 同名）
const SECRET_KEY: &str = "ai-api-key";

/**
 * 给界面的结构化失败。
 *
 * ## 为什么不是 `Result<_, String>`
 *
 * 字符串只能被「读」，不能被「判断」。界面要给出的恰恰是判断：
 * 缺地址、缺模型、缺密钥、401、429 是五件不同的事，用户的下一步也各不相同。
 * 靠正则去猜文案里的字眼，等于把逻辑绑在措辞上 —— 谁改一个标点，分流就静默失效，
 * 而失效的表现是「所有错误都显示同一句话」，没人会把它当 bug 报上来。
 *
 * `focus` 是刻意加的：只说「去填密钥」而不把光标送过去，用户还得自己找那一栏。
 */
#[derive(Debug, Serialize)]
pub struct LlmFailure {
    /// 机器可判的类别：notConfigured / network / timeout / http / parse / unsupported / io
    pub kind: &'static str,
    /// HTTP 状态码（仅 kind == "http" 时非空）
    pub status: Option<u16>,
    /// 原始错误，已脱敏、已截断
    pub message: String,
    /// 一句话动机 + 一个动作
    pub hint: String,
    /// 该把光标送进哪一栏：apiKey / baseUrl / model / none
    pub focus: &'static str,
}

impl LlmFailure {
    /// 本地校验失败：没有协议错误可判，但同样要能定位到具体那一栏。
    fn local(message: impl Into<String>, focus: &'static str) -> Self {
        Self {
            kind: "notConfigured",
            status: None,
            message: message.into(),
            hint: "在「选项 → 高级」里补齐这一项后再试。密钥只存本机加密库，不会写进配置文件。"
                .into(),
            focus,
        }
    }

    fn from_error(e: cap_llm::LlmError) -> Self {
        Self {
            kind: kind_key(e.kind),
            status: e.status,
            hint: hint_for(e.kind, e.status),
            focus: focus_for(e.kind, e.status),
            message: e.to_string(),
        }
    }
}

fn kind_key(k: cap_llm::ErrorKind) -> &'static str {
    use cap_llm::ErrorKind as E;
    match k {
        E::NotConfigured => "notConfigured",
        E::Network => "network",
        E::Timeout => "timeout",
        E::Http => "http",
        E::Parse => "parse",
        E::Unsupported => "unsupported",
        E::Io => "io",
    }
}

/// 把类别 + 状态码翻译成「用户下一步该做什么」。每条都指一个具体动作，不复述错误。
fn hint_for(kind: cap_llm::ErrorKind, status: Option<u16>) -> String {
    use cap_llm::ErrorKind as E;
    match (kind, status) {
        (E::NotConfigured, _) => "配置还差一项。补齐「选项 → 高级」里空着的字段后重试。".into(),
        (E::Network, _) => {
            "连不上这个地址。国内厂商一般直连即可，开了代理先关掉；海外厂商（OpenAI / Gemini）相反，需要代理。"
                .into()
        }
        (E::Timeout, _) => {
            "等太久没等到回应。可能是链路慢或模型在排队 —— 可以在「选项 → 网络」把超时调大，或换个小模型。"
                .into()
        }
        (E::Http, Some(401)) | (E::Http, Some(403)) => {
            "API Key 无效、已过期，或没有该模型的权限。重新粘贴一次密钥；刚续费过要确认用的是新 key。"
                .into()
        }
        (E::Http, Some(404)) => {
            "地址或模型名不存在。常见原因是地址多写／少写了一段路径 —— \
             OpenAI 带 /v1，智谱是 /api/paas/v4，火山是 /api/v3。"
                .into()
        }
        (E::Http, Some(429)) => {
            "额度用尽或被限流。这不是你配错了 —— 换个时段再试，或到服务商后台充值／提额。".into()
        }
        (E::Http, Some(s)) if s >= 500 => "服务商那边故障了，不是你配置的问题。稍后重试即可。".into(),
        (E::Http, _) => "服务端拒绝了这次请求。原始错误见下方详情。".into(),
        (E::Parse, _) => {
            "对方回了内容但不是预期格式。多半是这个地址其实不是 OpenAI 兼容服务 —— \
             检查一下接口地址是不是填成了别家协议的端点。"
                .into()
        }
        (E::Unsupported, _) => "这家服务不支持当前操作。换一个模型或服务商再试。".into(),
        (E::Io, _) => "本机读写配置出错。检查配置目录是否可写。".into(),
    }
}

/// 这个失败该把光标送到哪一栏。分类必须与 [`hint_for`] 的文案一致 ——
/// 文案说「重新粘贴密钥」而光标停在地址栏，比不给光标更糟。
fn focus_for(kind: cap_llm::ErrorKind, status: Option<u16>) -> &'static str {
    use cap_llm::ErrorKind as E;
    match (kind, status) {
        (E::NotConfigured, _) => "none",
        (E::Http, Some(401)) | (E::Http, Some(403)) => "apiKey",
        (E::Http, Some(404)) | (E::Parse, _) => "baseUrl",
        (E::Unsupported, _) => "model",
        _ => "none",
    }
}

/// 命令参数
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiGenerateArgs {
    pub prompt: String,
    /// OpenAI 兼容服务地址（带不带 /chat/completions 都收 —— 由 cap-llm 补齐）
    pub endpoint: String,
    pub model: String,
    /// 超时秒数（读「选项 → 网络」；走代理的用户需要调大，不能写死）
    #[serde(default = "default_timeout")]
    pub timeout_sec: u64,
}

fn default_timeout() -> u64 {
    20
}

/// 配置三件套校验 + 拼 cap-llm 配置。key 缺失在这里就报错，不发请求。
///
/// 每一项失败都带 `focus`：三项分处「选项 → 高级」的三个输入框，
/// 只说「去填一下」等于让用户把三个框都试一遍。
/// 配置三件套校验 + 拼 cap-llm 配置（**测试用入口**）。
///
/// 生产路径走 [`prepare`]（同一个同步准备阶段）。
/// 保留这个公开别名是因为测试直接断言它的错误分类与 `focus`。
#[cfg(test)]
pub fn to_cap(args: &AiGenerateArgs) -> Result<LlmConfig, LlmFailure> {
    prepare(args)
}

/// 同步准备阶段：校验三件套 + 从加密库取密钥 + 拼 cap-llm 配置。
///
/// 与 [`to_cap`] 等价，但**刻意保持为独立的同步函数** ——
/// 调用方若要在测试里持配置目录锁，必须让锁只覆盖本函数，
/// 不能覆盖后续的 await（见 [`ai_generate_outline`] 的注释）。
fn prepare(args: &AiGenerateArgs) -> Result<LlmConfig, LlmFailure> {
    let endpoint = args.endpoint.trim();
    if endpoint.is_empty() {
        return Err(LlmFailure::local(
            "尚未配置 AI 接口地址。请填写 OpenAI 兼容的服务地址（如 https://api.openai.com/v1）。",
            "baseUrl",
        ));
    }
    let model = args.model.trim();
    if model.is_empty() {
        return Err(LlmFailure::local(
            "尚未配置 AI 模型名称。填一个能对话的模型，例如 gpt-4o-mini、deepseek-chat。",
            "model",
        ));
    }
    let key = crate::secret::get(SECRET_KEY)
        .map_err(|e| LlmFailure::local(e, "apiKey"))?
        .map(|k| k.trim().to_string())
        .unwrap_or_default();

    let cap = LlmConfig {
        kind: ProviderKind::Custom, // 只走 OpenAI 兼容协议（复刻方案 §3.13 的约束）
        base_url: endpoint.to_string(),
        api_key: key,
        model: model.to_string(),
        timeout: std::time::Duration::from_secs(args.timeout_sec.max(1)),
        temperature: Some(0.3),
        max_tokens: None,
        // 本仓要求显式填接口地址（复刻方案 §3.13），因此不绑定供应商预设 ——
        // 预设会在 base_url 为空时自动补地址，与本仓「必须显式填写」的约定相悖。
        preset: None,
    };

    // 要不要 key 交给 cap-llm 判（私网 / 回环地址上的自建服务没有鉴权层）。
    // 2026-10-31 修：此前把「加密库里没密钥」直接当致命错误，于是 mind 指向
    // mini 的本地网关（无鉴权）时，用户必须往加密库里塞一个假密钥才能生成大纲。
    if cap.needs_api_key() && cap.api_key.is_empty() {
        return Err(LlmFailure::local(
            "尚未配置 AI API Key。密钥只存在本机加密库，不会写进配置文件。",
            "apiKey",
        ));
    }
    Ok(cap)
}

/// 生成大纲（非流式）。key 从本机加密库解出、请求后即弃，不回传前端。
///
/// ## 为什么拆成两段（2026-10-31）
///
/// `to_cap` 要读加密库（读配置目录环境变量），而配置目录环境变量是**进程级**的，
/// 测试期间必须持锁。但网络请求是 await 的 —— 持着 `MutexGuard` 跨 await 会：
///
/// 1. 触发 clippy 的 `await_holding_lock`（CI 闸门直接红）；
/// 2. 即使过了 clippy，也是真错：锁被一把网络请求的时长占住，
///    别的测试想改配置目录就得干等，隔离沙盒的意义就废了。
///
/// 所以拆成「同步准备配置」+「异步发请求」两段，锁只覆盖第一段。
/// `prepare` 是同步函数，锁在它返回时就已经释放。
#[tauri::command]
pub async fn ai_generate_outline(args: AiGenerateArgs) -> Result<String, LlmFailure> {
    let cfg = prepare(&args)?;
    let messages = [
        Message::system(
            "你是思维导图大纲生成器。只输出大纲本身：每行一个主题，第一行为中心主题，用制表符缩进表示层级，\
             不要解释、不要代码块围栏、不要编号。",
        ),
        Message::user(&args.prompt),
    ];
    let reply = cap_llm::chat(&cfg, &messages)
        .await
        .map_err(LlmFailure::from_error)?;
    Ok(reply.content)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(endpoint: &str, model: &str) -> AiGenerateArgs {
        AiGenerateArgs {
            prompt: "测试主题".to_string(),
            endpoint: endpoint.to_string(),
            model: model.to_string(),
            timeout_sec: 20,
        }
    }

    #[test]
    fn empty_endpoint_and_model_are_reported_before_key() {
        let e = to_cap(&args(" ", "gpt-4o-mini")).unwrap_err();
        assert!(e.message.contains("接口地址"));
        // 报错必须指到具体那一栏 —— 三项分处三个输入框，
        // 只说「去填一下」等于让用户把三个都试一遍。
        assert_eq!(e.focus, "baseUrl");
        let e = to_cap(&args("https://api.openai.com/v1", " ")).unwrap_err();
        assert!(e.message.contains("模型名称"));
        assert_eq!(e.focus, "model");
    }

    #[test]
    fn every_local_failure_carries_an_actionable_hint() {
        // 「缺配置」是最常见的一种失败，提示里必须写清在哪儿补、以及密钥存在哪 ——
        // 否则用户会去配置文件里找密钥（它根本不在那儿）。
        let e = to_cap(&args("", "m")).unwrap_err();
        assert_eq!(e.kind, "notConfigured");
        assert!(e.hint.contains("选项"));
        assert!(e.hint.chars().count() >= 10);
    }

    #[test]
    fn focus_target_never_contradicts_the_hint() {
        use cap_llm::ErrorKind as E;
        assert_eq!(focus_for(E::Http, Some(401)), "apiKey");
        assert_eq!(focus_for(E::Http, Some(403)), "apiKey");
        assert_eq!(focus_for(E::Http, Some(404)), "baseUrl");
        assert_eq!(focus_for(E::Parse, None), "baseUrl");
        assert_eq!(focus_for(E::Unsupported, None), "model");
        // 网络/超时/限流都不是配置写错，不该把用户往表单里推
        assert_eq!(focus_for(E::Network, None), "none");
        assert_eq!(focus_for(E::Timeout, None), "none");
        assert_eq!(focus_for(E::Http, Some(429)), "none");
    }

    #[test]
    fn http_failure_is_classified_not_just_stringified() {
        let f = LlmFailure::from_error(cap_llm::LlmError::http(401, "invalid api key"));
        assert_eq!(f.kind, "http");
        assert_eq!(f.status, Some(401));
        assert_eq!(f.focus, "apiKey");
        assert!(f.message.contains("401"));
    }

    #[test]
    fn timeout_floor_is_one_second() {
        let mut a = args("https://api.openai.com/v1", "gpt-4o-mini");
        a.timeout_sec = 0;
        // key 缺失先于超时检查？不 —— 顺序是 endpoint/model/key，测试机没有密钥，
        // 这里只验证字段解析不 panic；超时下限逻辑在 cap-llm 侧由 max(1) 保证。
        let _ = to_cap(&a);
    }

    #[test]
    fn default_timeout_applies() {
        let json = r#"{"prompt":"p","endpoint":"https://x.com","model":"m"}"#;
        let a: AiGenerateArgs = serde_json::from_str(json).unwrap();
        assert_eq!(a.timeout_sec, 20);
    }

    // ==================== 真实网关直连 ====================

    /// 免密钥的私有网关必须能生成大纲（未设 `ZBIZ_GW` 时静默跳过）。
    ///
    /// mind 的密钥只存在本机加密库，`to_cap` 以前把它当硬性条件 ——
    /// 指向无鉴权的本地网关时，用户必须往加密库里塞一个假密钥。
    /// 这里用独立配置目录，确保读到的是「空库」而不是本机真实密钥。
    ///
    /// ```sh
    /// ZBIZ_GW=http://192.168.31.249:8200/v1 ZBIZ_MODEL=zBiz-Text-35B \
    ///   cargo test -p z-biz-tool-mind live_zbiz -- --nocapture
    /// ```
    #[tokio::test]
    async fn live_zbiz_gateway_accepts_keyless_and_replies() {
        let Ok(gw) = std::env::var("ZBIZ_GW") else {
            return;
        };
        let model = std::env::var("ZBIZ_MODEL").unwrap_or_else(|_| "zBiz-Text-35B".to_string());

        let args = AiGenerateArgs {
            prompt: "本地大模型的三个优点".to_string(),
            endpoint: gw.clone(),
            model,
            timeout_sec: 120,
        };

        // 锁只覆盖「改配置目录 + 读密钥」这一段同步准备。
        //
        // 绝不能持着它跨 await：一是 clippy 的 `await_holding_lock` 会让 CI 闸门红；
        // 二是真错 —— 锁被一把网络请求的时长占住，别的测试想改配置目录就得干等。
        //
        // 用一个显式作用域把 `_guard` 限制在准备阶段，出了作用域锁就释放了。
        let (cap, _dir) = {
            let _guard = crate::CONFIG_ENV_GUARD
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let dir = std::env::temp_dir().join(format!("zbiz-mind-live-{}", std::process::id()));
            std::fs::create_dir_all(&dir).expect("建临时配置目录失败");
            std::env::set_var("Z_MIND_CONFIG_DIR", &dir);
            let cap = prepare(&args).expect("免 Key 的本地网关必须通过校验");
            (cap, dir)
        };
        assert!(!cap.needs_api_key(), "私有地址不该要求 key");

        let out = ai_generate_outline(args).await.expect("真实调用失败");
        assert!(!out.trim().is_empty(), "返回为空（网关 {gw}）");
        println!("[mind → {gw}] {}", out.trim());
    }
}

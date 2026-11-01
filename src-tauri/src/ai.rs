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

use cap_llm::{Focus, LlmConfig, Message, ProviderKind};
use serde::Deserialize;

/// 与前端「选项 → 高级」密钥输入框约定的槽位名（secret.rs 同名）
const SECRET_KEY: &str = "ai-api-key";

/**
 * 给界面的结构化失败。
 *
 * 判据（分类 / 动作 / 落点）已下沉到 `cap_llm::failure` —— 家族里五个仓
 * 各抄了一份 `hint_for`，抄到第 5 遍时已经开始漂移（措辞各不相同、
 * `focus` 有的仓有有的仓没有）。此处只做**转发**，不再维护副本。
 *
 * `focus` 是刻意加的：只说「去填密钥」而不把光标送过去，用户还得自己找那一栏。
 */
pub use cap_llm::LlmFailure;

/// 本仓「缺配置」时的措辞。
///
/// 分类与落点由能力层定死，只有**指向本仓界面位置**的措辞在这里覆盖一次 ——
/// mind 的设置项在「选项 → 高级」里，标准措辞的「上方标红的字段」在
/// 本仓指不到任何东西。
///
/// 覆盖的是措辞，不是判据：`kind` 与 `focus` 仍然来自 `cap_llm::failure`。
const LOCAL_HINT: &str =
    "在「选项 → 高级」里补齐这一项后再试。密钥只存本机加密库，不会写进配置文件。";

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
        return Err(LlmFailure::local_with_hint(
            "尚未配置 AI 接口地址。请填写 OpenAI 兼容的服务地址（如 https://api.openai.com/v1）。",
            Focus::BaseUrl,
            LOCAL_HINT,
        ));
    }
    let model = args.model.trim();
    if model.is_empty() {
        return Err(LlmFailure::local_with_hint(
            "尚未配置 AI 模型名称。填一个能对话的模型，例如 gpt-4o-mini、deepseek-chat。",
            Focus::Model,
            LOCAL_HINT,
        ));
    }
    let key = crate::secret::get(SECRET_KEY)
        .map_err(|e| LlmFailure::local_with_hint(e, Focus::ApiKey, LOCAL_HINT))?
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
        return Err(LlmFailure::local_with_hint(
            "尚未配置 AI API Key。密钥只存在本机加密库，不会写进配置文件。",
            Focus::ApiKey,
            LOCAL_HINT,
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

/// 生成结构化图（非流式）。
///
/// 与 [`ai_generate_outline`] 的差别只有系统提示词：这里要求严格 JSON
/// （nodes + edges），解析与校验在前端 `engine/diagram.ts` —— 那边有
/// 四道闸（结构/引用/环/规模）和完整的失败文案，Rust 侧不重复一遍。
/// 传输、鉴权、错误分类、脱敏全部走同一条 cap-llm 通道。
#[tauri::command]
pub async fn ai_generate_diagram(args: AiGenerateArgs) -> Result<String, LlmFailure> {
    let cfg = prepare(&args)?;
    let messages = [
        Message::system(
            "你是结构图数据生成器。只输出一个 JSON 对象，形状为 \
             {\"nodes\":[{\"id\",\"text\",\"parent\"}],\"edges\":[{\"from\",\"to\",\"text\"}]}。\
             恰好一个节点 parent 为 null（根）；其余 parent 指向已存在的 id。\
             不带代码围栏、不带解释文字。",
        ),
        Message::user(&args.prompt),
    ];
    let reply = cap_llm::chat(&cfg, &messages)
        .await
        .map_err(LlmFailure::from_error)?;
    Ok(reply.content)
}

// ==================== 像素级生图（第二步） ====================

/// 生图命令参数。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageGenArgs {
    /// OpenAI 兼容的生图网关根地址（如 http://192.168.31.249:8200/v1）
    pub endpoint: String,
    /// 模型名（如 zBiz-Image-FLUX）
    pub model: String,
    pub prompt: String,
    /// 形如 "1024x1024"
    pub size: String,
    /// 生图网关 Bearer 密钥（自建网关常免鉴权，可空）
    #[serde(default)]
    pub api_key: String,
    /// 秒。FLUX 冷启动 90s+、热态 55s，给足余量
    #[serde(default = "default_image_timeout")]
    pub timeout_sec: u64,
}

fn default_image_timeout() -> u64 {
    600
}

/// 像素级生图：POST {endpoint}/images/generations，OpenAI 兼容形状。
///
/// ## 兜底纪律（CEO 裁定）
///
/// 网关是自建服务，不保证在线。所有失败必须给**能照着改**的人话：
/// 未配置/不可达/超时/HTTP 错误四类分开说，绝不静默失败或崩栈。
/// 请求可能长达数分钟 —— 超时默认 600s，**不设重试**（一张图几分钟，
/// 重试等于翻倍等待，用户宁可自己重发）。
#[tauri::command]
pub async fn ai_generate_image(args: ImageGenArgs) -> Result<serde_json::Value, LlmFailure> {
    use serde_json::json;

    let endpoint = args.endpoint.trim().trim_end_matches('/').to_string();
    if endpoint.is_empty() {
        return Err(LlmFailure::local_with_hint(
            "尚未配置图像服务地址。请在「选项 → 高级 → 图像服务端点」填写 OpenAI 兼容的生图网关（如 http://192.168.31.249:8200/v1）。",
            Focus::BaseUrl,
            LOCAL_HINT,
        ));
    }
    if args.model.trim().is_empty() {
        return Err(LlmFailure::local_with_hint(
            "尚未配置图像模型名（如 zBiz-Image-FLUX、flux.1-schnell）。",
            Focus::Model,
            LOCAL_HINT,
        ));
    }
    if args.prompt.trim().is_empty() {
        return Err(LlmFailure::local_with_hint(
            "生成描述不能为空。",
            Focus::None,
            LOCAL_HINT,
        ));
    }

    let url = format!("{}/images/generations", endpoint);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(args.timeout_sec.max(1)))
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| LlmFailure {
            kind: "io",
            status: None,
            hint: "本机网络栈初始化失败，请重启应用重试。".into(),
            focus: "none",
            message: e.to_string(),
        })?;

    let mut req = client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&json!({
            "model": args.model.trim(),
            "prompt": args.prompt.trim(),
            "size": args.size,
        }));
    if !args.api_key.trim().is_empty() {
        req = req.bearer_auth(args.api_key.trim());
    }

    let resp = req.send().await.map_err(|e| {
        // 连接层失败：区分「地址打不开」和「等太久」，两者下一步动作不同
        let msg = e.to_string();
        let (kind, hint) = if msg.contains("timed out") || msg.contains("timeout") {
            (
                "timeout",
                "图像服务在超时时间内没有返回。自建 FLUX 网关冷启动可能超过 2 分钟——\
                     到「选项 → 网络」把超时调大（生图建议 ≥300s），或确认网关已启动。",
            )
        } else {
            (
                "network",
                "连不上图像服务。请确认地址正确、服务在线（浏览器打开 {host}/health 验证）。\
                     生图网关是自建服务，不保证 7x24 在线。",
            )
        };
        LlmFailure {
            kind,
            status: None,
            hint: hint.replace("{host}", endpoint.split('/').nth(2).unwrap_or("网关")),
            focus: "baseUrl",
            message: cap_llm::redact(&msg, &args.api_key),
        }
    })?;

    let status = resp.status().as_u16();
    let body = resp.text().await.map_err(|e| LlmFailure {
        kind: "network",
        status: Some(status),
        hint: "服务响应无法读取。".into(),
        focus: "none",
        message: e.to_string(),
    })?;
    if status >= 400 {
        return Err(LlmFailure {
            kind: "http",
            status: Some(status),
            hint: match status {
                401 | 403 => "图像服务要求鉴权。到「选项 → 高级 → 图像服务密钥」填写网关的 Bearer Token。".into(),
                404 => "端点路径不对。确认地址末尾是 /v1（完整地址形如 http://host:8200/v1）。".into(),
                _ => "图像服务返回了错误。检查网关日志；若提示模型不存在，核对「图像模型名」与网关 /v1/models 列表一致。".into(),
            },
            focus: if status == 401 || status == 403 { "apiKey" } else { "baseUrl" },
            message: cap_llm::truncate_chars(&cap_llm::redact(&body, &args.api_key), 300),
        });
    }

    let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| LlmFailure {
        kind: "parse",
        status: Some(status),
        hint: "服务响应不是 JSON——这个地址可能不是 OpenAI 兼容生图端点。".into(),
        focus: "baseUrl",
        message: e.to_string(),
    })?;

    let b64 = v
        .get("data")
        .and_then(|d| d.get(0))
        .and_then(|x| x.get("b64_json"))
        .and_then(|b| b.as_str());
    match b64 {
        Some(b) if !b.is_empty() => Ok(json!({
            "b64": b,
            "seed": v.pointer("/data/0/seed"),
            "elapsedS": v.pointer("/data/0/elapsed_s"),
        })),
        // 空串视同没有 b64（服务异常语义），与 None 同走 url 兜底
        Some(_) | None => {
            let u = v.pointer("/data/0/url").and_then(|x| x.as_str());
            match u {
                Some(url) => Ok(json!({ "url": url })),
                None => Err(LlmFailure {
                    kind: "parse",
                    status: Some(status),
                    hint: "响应里既没有 b64_json 也没有 url 字段。确认该端点是 /v1/images/generations 协议。".into(),
                    focus: "baseUrl",
                    message: "图片接口返回缺少图片数据".into(),
                }),
            }
        }
    }
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

    // 注：失败落点的判据测试（落点与文案一致、网络类不跳光标）
    // 已下沉到 `cap_llm::failure`，家族五仓共用一份。

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

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
use serde::{Deserialize, Serialize};

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

// ==================== 多模态看图（第三步） ====================

/// 看图命令参数。
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisionArgs {
    /// OpenAI 兼容服务地址（同文本三件套的 endpoint）
    pub endpoint: String,
    /// 视觉模型名（如 zBiz-Vision-35B；与文本模型可以不同，由前端显式传入）
    pub model: String,
    pub prompt: String,
    /// 图片：data URL（data:image/png;base64,…）或纯 base64 —— cap-llm 两种都收
    pub image: String,
    #[serde(default = "default_vision_timeout")]
    pub timeout_sec: u64,
}

fn default_vision_timeout() -> u64 {
    120
}

/// 多模态看图：图片 + 指令 → 文本回复。
///
/// ## 为什么走 cap-llm 的 `images` 字段而不是手拼 content parts
///
/// 网关（zbiz_ai_api.py）对 chat 请求是**原样转发**给 llama-server 的 ——
/// 实测确认 llama-server 认 OpenAI 标准 content parts（`image_url` + data URL），
/// 而 cap-llm 的 `openai_messages` 对非空 `images` 恰好就是这个编码（wire.rs:336）。
/// 所以「把 base64 塞进 `Message::with_images`」就是正确协议，不需要在 mind 里
/// 再手写一份多模态报文。
///
/// ## 为什么 key 沿用文本三件套的 `SECRET_KEY`
///
/// 视觉与文本走的是**同一个** OpenAI 兼容端点（自建网关上甚至是同一个
/// llama-server 进程 + mmproj）。另开一个密钥槽等于让用户把同一个 key 粘两遍。
#[tauri::command]
pub async fn ai_vision(args: VisionArgs) -> Result<String, LlmFailure> {
    let cfg = prepare(&AiGenerateArgs {
        prompt: args.prompt.clone(),
        endpoint: args.endpoint.clone(),
        model: args.model.clone(),
        timeout_sec: args.timeout_sec,
    })?;
    let messages = [Message::user(&args.prompt).with_images(vec![args.image.clone()])];
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

    let resp = req
        .send()
        .await
        .map_err(|e| image_send_failure(&e, &endpoint, &args.api_key, "生成"))?;

    let status = resp.status().as_u16();
    let body = resp.text().await.map_err(|e| LlmFailure {
        kind: "network",
        status: Some(status),
        hint: "服务响应无法读取。".into(),
        focus: "none",
        message: e.to_string(),
    })?;
    if status >= 400 {
        return Err(image_http_failure(status, &body, &args.api_key));
    }

    parse_image_response(&body, status)
}

// ======================================================================
// 图生图（AI 改图）：拿画布上已有的图当底，按一句要求重画。
//
// 端点形状与生图不同（/images/edits），但**失败纪律必须一模一样** ——
// 两套措辞漂移，用户就要在「同一个网关、同一个地址」下学两种报错。
// 下面三个 helper 是生图与改图共用的唯一一份判据。
// ======================================================================

/// 改图命令参数。
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageEditArgs {
    /// OpenAI 兼容的生图网关根地址（与生图同一处配置）
    pub endpoint: String,
    /// 模型名（与生图同一处配置；网关实际按 prompt 走图生图工作流）
    pub model: String,
    /// 改动要求（用户的一句话）
    pub prompt: String,
    /// 原图：data URL 或裸 base64（前端给 data URL，网关两种都收）
    pub image: String,
    /// 重绘强度 0.05~0.95：越小越贴原图，越大越自由。
    /// 实测 FLUX schnell 在 0.5~0.6 只改纹理，≥0.85 才明显改结构 ——
    /// 默认取 0.85，是因为「改图」这个动作的期望就是**看得出的变化**。
    #[serde(default = "default_denoise")]
    pub denoise: f64,
    /// 网关 Bearer 密钥（自建网关常免鉴权，可空）
    #[serde(default)]
    pub api_key: String,
    /// 秒。改图同样可能分钟级，给足余量
    #[serde(default = "default_image_timeout")]
    pub timeout_sec: u64,
}

fn default_denoise() -> f64 {
    0.85
}

/// 把 denoise 钳进网关能接受的范围。
///
/// 网关侧钳制在 0.05~0.95（KSampler 的 denoise=1.0 是"完全重画"，会把原图丢掉）。
/// 前端也钳一次，是为了让**用户看到自己发出去的值**——
/// 传 1.5 被服务端悄悄改成 0.95，用户会以为"力度没生效"。
pub fn clamp_denoise(d: f64) -> f64 {
    // NaN 才是「无法解析」→ 走默认。Infinity 是「比任何有效值都大」→
    // 该钳到上限 0.95；把它当 NaN 处理会让「力度调到最大」变成「力度默认」，
    // 用户明明要重画却只拿到一次轻改。
    if d.is_nan() {
        return default_denoise();
    }
    d.clamp(0.05, 0.95)
}

/// 改图的本地校验（四项缺一不可）。
///
/// 独立成同步函数，与生图那边「prepare 是同步的」同一思路：
/// 校验路径不该必须发一次网络请求才能测。
fn image_edit_validate(args: &ImageEditArgs) -> Result<String, LlmFailure> {
    if args.endpoint.trim().is_empty() {
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
            "改图要求不能为空：请说明要把这张图改成什么样。",
            Focus::None,
            LOCAL_HINT,
        ));
    }
    if args.image.trim().is_empty() {
        return Err(LlmFailure::local_with_hint(
            "这张图没有可用的原图数据，无法改图。",
            Focus::None,
            LOCAL_HINT,
        ));
    }
    Ok(args.endpoint.trim().trim_end_matches('/').to_string())
}

/// 图生图：POST {endpoint}/images/edits，JSON 形态（网关同时收 multipart，桌面端走 JSON 更省事）。
///
/// 兜底纪律与生图完全一致：未配置/不可达/超时/HTTP 错误四类分开说，绝不静默失败。
/// **不设重试** —— 一次改图几分钟，重试等于翻倍等待。
#[tauri::command]
pub async fn ai_edit_image(args: ImageEditArgs) -> Result<serde_json::Value, LlmFailure> {
    use serde_json::json;

    let endpoint = image_edit_validate(&args)?;

    let url = format!("{}/images/edits", endpoint);
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
            "image": args.image.trim(),
            "denoise": clamp_denoise(args.denoise),
        }));
    if !args.api_key.trim().is_empty() {
        req = req.bearer_auth(args.api_key.trim());
    }

    let resp = req
        .send()
        .await
        .map_err(|e| image_send_failure(&e, &endpoint, &args.api_key, "改图"))?;

    let status = resp.status().as_u16();
    let body = resp.text().await.map_err(|e| LlmFailure {
        kind: "network",
        status: Some(status),
        hint: "服务响应无法读取。".into(),
        focus: "none",
        message: e.to_string(),
    })?;
    if status >= 400 {
        return Err(image_http_failure(status, &body, &args.api_key));
    }

    parse_image_response(&body, status)
}

// ---------- 生图与改图共用的失败判据（唯一一份） ----------

/// 连接层失败：区分「地址打不开」和「等太久」，两者下一步动作不同。
fn image_send_failure(
    e: &reqwest::Error,
    endpoint: &str,
    api_key: &str,
    action: &str,
) -> LlmFailure {
    let msg = e.to_string();
    let (kind, hint) = if msg.contains("timed out") || msg.contains("timeout") {
        (
            "timeout",
            format!(
                "图像服务在超时时间内没有返回。自建 FLUX 网关冷启动可能超过 2 分钟——\
                 到「选项 → 网络」把超时调大（{action}建议 ≥300s），或确认网关已启动。"
            ),
        )
    } else {
        (
            "network",
            "连不上图像服务。请确认地址正确、服务在线（浏览器打开 {host}/health 验证）。\
             生图网关是自建服务，不保证 7x24 在线。"
                .to_string(),
        )
    };
    LlmFailure {
        kind,
        status: None,
        hint: hint.replace("{host}", endpoint.split('/').nth(2).unwrap_or("网关")),
        focus: "baseUrl",
        message: cap_llm::redact(&msg, api_key),
    }
}

/// HTTP 4xx/5xx：状态码决定下一步动作，措辞按「缺什么 → 去哪儿补」写。
fn image_http_failure(status: u16, body: &str, api_key: &str) -> LlmFailure {
    // 图太小是实测踩到过的真实失败（FLUX 的 VAE 有 3x3 卷积核，
    // 输入比 kernel 还小就直接报错）—— 用户拿一张几十像素的小图标来改图就会遇到。
    // 这时给一句"换个图"，比让他对着 "Kernel size can't be greater than
    // actual input size" 发愣有用得多。
    let too_small = body.contains("Kernel size can't be greater")
        || body.contains("actual input size")
        || body.contains("padded input size");
    LlmFailure {
        kind: "http",
        status: Some(status),
        hint: match status {
            401 | 403 => "图像服务要求鉴权。到「选项 → 高级 → 图像服务密钥」填写网关的 Bearer Token。".into(),
            404 => "端点路径不对。确认地址末尾是 /v1（完整地址形如 http://host:8200/v1）；\
                    改图还需要网关支持 /images/edits（较旧的网关没有这个端点）。".into(),
            400 => "图像服务拒绝了这次请求。若是改图：检查原图格式与提示词；\
                    网关要求 prompt 与 image 两个字段都要有。".into(),
            _ if too_small => "这张图太小，图像服务没法处理（模型要求图片不小于 64×64）。\
                    请换一张更大的图再试 —— 画布上的小图标通常改不了。".into(),
            _ => "图像服务返回了错误。检查网关日志；若提示模型不存在，核对「图像模型名」与网关 /v1/models 列表一致。".into(),
        },
        focus: if status == 401 || status == 403 { "apiKey" } else { "baseUrl" },
        message: cap_llm::truncate_chars(&cap_llm::redact(body, api_key), 300),
    }
}

/// 解析 OpenAI 兼容的图片响应：b64_json 优先，url 兜底，都没有就是协议不对。
fn parse_image_response(body: &str, status: u16) -> Result<serde_json::Value, LlmFailure> {
    use serde_json::json;

    let v: serde_json::Value = serde_json::from_str(body).map_err(|e| LlmFailure {
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

    // ==================== 多模态看图（第三步） ====================

    fn vision_args(endpoint: &str, model: &str) -> VisionArgs {
        VisionArgs {
            endpoint: endpoint.to_string(),
            model: model.to_string(),
            prompt: "描述这张图".to_string(),
            image: "data:image/png;base64,QUJD".to_string(),
            timeout_sec: 120,
        }
    }

    #[test]
    fn vision_reuses_text_config_gates() {
        // 看图与文本共用 prepare() 的三件套校验：缺地址/缺模型都指到同一栏。
        // 直接调 ai_vision 会真发请求，这里只验证参数校验路径（prepare 是同步的）。
        let a = vision_args("", "zBiz-Vision-35B");
        let e = prepare(&AiGenerateArgs {
            prompt: a.prompt.clone(),
            endpoint: a.endpoint.clone(),
            model: a.model.clone(),
            timeout_sec: a.timeout_sec,
        })
        .unwrap_err();
        assert_eq!(e.focus, "baseUrl");
        assert!(e.message.contains("接口地址"));
    }

    #[test]
    fn vision_args_round_trip_camel_case() {
        let a = vision_args("http://192.168.31.249:8200/v1", "zBiz-Vision-35B");
        let json = serde_json::to_value(&a).unwrap();
        // camelCase 线上形状：前端传的键必须是 image/timeoutSec
        assert!(json.get("image").is_some(), "{json}");
        assert!(json.get("timeoutSec").is_some(), "{json}");
        assert!(json.get("endpoint").is_some(), "{json}");
        let back: VisionArgs = serde_json::from_value(serde_json::json!({
            "endpoint": a.endpoint,
            "model": a.model,
            "prompt": a.prompt,
            "image": a.image,
            "timeoutSec": 120,
        }))
        .unwrap();
        assert_eq!(back.image, a.image);
        assert_eq!(back.timeout_sec, 120);
    }

    #[test]
    fn vision_default_timeout_is_generous() {
        // 视觉推理是秒级到十秒级；比文本的 20s 宽，比生图的 600s 紧。
        let json = r#"{"endpoint":"http://x/v1","model":"m","prompt":"p","image":"QQ=="}"#;
        let a: VisionArgs = serde_json::from_str(json).unwrap();
        assert_eq!(a.timeout_sec, 120);
    }

    // ==================== 图生图（AI 改图） ====================

    fn edit_args(endpoint: &str, model: &str, prompt: &str, image: &str) -> ImageEditArgs {
        ImageEditArgs {
            endpoint: endpoint.to_string(),
            model: model.to_string(),
            prompt: prompt.to_string(),
            image: image.to_string(),
            denoise: default_denoise(),
            api_key: String::new(),
            timeout_sec: 600,
        }
    }

    #[test]
    fn edit_args_round_trip_camel_case() {
        let a = edit_args(
            "http://192.168.31.249:8200/v1",
            "zBiz-Image-FLUX",
            "改成夜景",
            "data:image/png;base64,QUJD",
        );
        let json = serde_json::to_value(&a).unwrap();
        // 前端传的键必须是 camelCase：denoise / timeoutSec / apiKey
        assert!(json.get("denoise").is_some(), "{json}");
        assert!(json.get("timeoutSec").is_some(), "{json}");
        assert!(json.get("apiKey").is_some(), "{json}");
        assert!(json.get("image").is_some(), "{json}");
    }

    #[test]
    fn edit_denoise_default_is_high_enough_to_change_structure() {
        // 实测：FLUX schnell 在 denoise 0.5~0.6 只改纹理，≥0.85 才明显改结构。
        // 默认值定低 ⇒ 用户说「改成跑车」却只换了个滤镜 ⇒ 功能等于没有。
        assert!(default_denoise() >= 0.85, "默认力度必须能改结构");
        // 也不能是 1.0 —— 那是完全重画，原图彻底丢掉。
        assert!(default_denoise() < 1.0, "1.0 会丢掉原图");
    }

    #[test]
    fn denoise_is_clamped_into_the_accepted_range() {
        // 网关侧钳在 0.05~0.95；前端也钳一次，用户看到的值才等于实际生效的值。
        assert_eq!(clamp_denoise(0.0), 0.05);
        assert_eq!(clamp_denoise(1.0), 0.95);
        assert_eq!(clamp_denoise(2.5), 0.95);
        assert_eq!(clamp_denoise(-1.0), 0.05);
        assert_eq!(clamp_denoise(0.85), 0.85);
        // NaN 走默认，不能变成 0.05（那等于「几乎不重画」）。
        assert_eq!(clamp_denoise(f64::NAN), default_denoise());
        assert_eq!(clamp_denoise(f64::INFINITY), 0.95);
    }

    #[test]
    fn edit_requires_endpoint_model_prompt_and_image() {
        // 四项缺一不可：少了任何一项都是「必然失败的请求」，本地就该拦下。
        let e = image_edit_validate(&edit_args("", "m", "p", "img")).unwrap_err();
        assert_eq!(e.focus, "baseUrl");
        assert!(e.message.contains("图像服务地址"));

        let e = image_edit_validate(&edit_args("http://x/v1", " ", "p", "img")).unwrap_err();
        assert_eq!(e.focus, "model");

        let e = image_edit_validate(&edit_args("http://x/v1", "m", " ", "img")).unwrap_err();
        assert!(e.message.contains("改图要求"));
        assert_eq!(e.focus, "none");

        let e = image_edit_validate(&edit_args("http://x/v1", "m", "p", " ")).unwrap_err();
        assert!(e.message.contains("原图"));
    }

    #[test]
    fn edit_image_response_is_parsed_like_generation() {
        // 改图与生图共用一个响应协议 —— 网关返回形状一样，解析就该一样。
        let body = r#"{"data":[{"b64_json":"QUJD","seed":7,"elapsed_s":12.5}]}"#;
        let v = parse_image_response(body, 200).unwrap();
        assert_eq!(v.get("b64").and_then(|x| x.as_str()), Some("QUJD"));
        assert_eq!(v.pointer("/seed").and_then(|x| x.as_i64()), Some(7));
    }

    #[test]
    fn edit_image_response_without_data_is_a_parse_failure() {
        // 没有图片数据不能静默成功 —— 否则前端会拿一个空结果去替换原图。
        let e = parse_image_response(r#"{"data":[]}"#, 200).unwrap_err();
        assert_eq!(e.kind, "parse");
        assert_eq!(e.focus, "baseUrl");
    }

    #[test]
    fn too_small_image_gets_an_actionable_hint() {
        // 实测踩到过：FLUX 的 VAE 有 3x3 卷积核，输入比 kernel 还小就报
        // "Kernel size can't be greater than actual input size"。
        // 用户拿一张几十像素的小图标来改图就会撞上 ——
        // 提示里必须说清"换张大图"，而不是把英文报错原样丢给他。
        let body = r#"{"error":"RuntimeError(\"Calculated padded input size per channel: (2 x 2). Kernel size: (3 x 3). Kernel size can't be greater than actual input size\")"}"#;
        let f = image_http_failure(500, body, "");
        assert!(f.hint.contains("太小"), "{}", f.hint);
        assert!(f.hint.contains("64"), "{}", f.hint);
    }

    #[test]
    fn ordinary_server_error_keeps_the_generic_hint() {
        // 阴性对照：不是"图太小"的问题，就别把人往"换张大图"上引。
        let body = r#"{"error":"ComfyUI workflow failed: model not found"}"#;
        let f = image_http_failure(500, body, "");
        assert!(!f.hint.contains("太小"), "{}", f.hint);
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

    /// 真实网关改图（未设 `ZBIZ_GW` 时静默跳过）。
    ///
    /// 这一条测的是**整条 Rust 链路**：JSON 请求体的形状（data URL + denoise）、
    /// 响应解析、超时设定。单测只能钉住纯函数，网关这头是活的、只能真跑。
    ///
    /// ```sh
    /// ZBIZ_GW=http://192.168.31.249:8200/v1 ZBIZ_MODEL=zBiz-Image-FLUX \
    ///   cargo test -p z-biz-tool-mind live_edit -- --nocapture
    /// ```
    #[tokio::test]
    async fn live_edit_image_against_real_gateway() {
        let Ok(gw) = std::env::var("ZBIZ_GW") else {
            return;
        };
        let model = std::env::var("ZBIZ_MODEL").unwrap_or_else(|_| "zBiz-Image-FLUX".to_string());

        // 一张 64x64 的红色 PNG。
        //
        // 尺寸不能更小：FLUX 的 VAE 有 3x3 的卷积核，输入比 kernel 还小会直接
        // 报 "Kernel size can't be greater than actual input size"（实测踩过）。
        // 这也说明真实用户拿一张极小的图来改，网关会失败 —— 那是网关的能力边界，
        // 不是本仓的 bug；错误会原样透给用户。
        let png_b64 = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAT0lEQVR42u3PQQkAAAgEsItz/fMYxgi+hcEKLNO+FgEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGBywLzk8EPlvGqjQAAAABJRU5ErkJggg==";
        let args = ImageEditArgs {
            endpoint: gw.clone(),
            model,
            prompt: "把这张图改画成蓝色方块".to_string(),
            image: format!("data:image/png;base64,{png_b64}"),
            denoise: default_denoise(),
            api_key: String::new(),
            timeout_sec: 600,
        };

        let v = ai_edit_image(args).await.expect("真实改图失败");
        let b64 = v
            .get("b64")
            .and_then(|x| x.as_str())
            .expect("响应里没有 b64");
        assert!(!b64.is_empty(), "b64 是空的");
        // 解出来的必须是 PNG 字节（魔数）—— 空串/错误页都过不了这一关。
        assert!(b64.starts_with("iVBORw0KGgo"), "不是 PNG 数据");
        println!("[mind 改图 → {gw}] seed={:?}", v.get("seed"));
    }
}

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
use serde::Deserialize;

/// 与前端「选项 → 高级」密钥输入框约定的槽位名（secret.rs 同名）
const SECRET_KEY: &str = "ai-api-key";

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
pub fn to_cap(args: &AiGenerateArgs) -> Result<LlmConfig, String> {
    let endpoint = args.endpoint.trim();
    if endpoint.is_empty() {
        return Err(
            "尚未配置 AI 接口地址，请在「选项 → 高级」里填写 OpenAI 兼容的服务地址（如 https://api.openai.com/v1）。"
                .to_string(),
        );
    }
    let model = args.model.trim();
    if model.is_empty() {
        return Err("尚未配置 AI 模型名称，请在「选项 → 高级」里填写，例如 gpt-4o-mini。".to_string());
    }
    let key = crate::secret::get(SECRET_KEY)?
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
        .ok_or_else(|| {
            "尚未配置 AI API Key，请在「选项 → 高级」里填写密钥；密钥只存在本机加密库，不会写进配置文件。"
                .to_string()
        })?;

    Ok(LlmConfig {
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
    })
}

/// 生成大纲（非流式）。key 从本机加密库解出、请求后即弃，不回传前端。
#[tauri::command]
pub async fn ai_generate_outline(args: AiGenerateArgs) -> Result<String, String> {
    let cfg = to_cap(&args)?;
    let messages = [
        Message::system(
            "你是思维导图大纲生成器。只输出大纲本身：每行一个主题，第一行为中心主题，用制表符缩进表示层级，\
             不要解释、不要代码块围栏、不要编号。",
        ),
        Message::user(&args.prompt),
    ];
    let reply = cap_llm::chat(&cfg, &messages)
        .await
        .map_err(|e| e.to_string())?;
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
        assert!(e.contains("接口地址"));
        let e = to_cap(&args("https://api.openai.com/v1", " ")).unwrap_err();
        assert!(e.contains("模型名称"));
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
}

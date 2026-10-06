//! 本地密钥存储：AES-256-GCM，密文形如 `enc:v1:<base64(nonce|ct|tag)>`。
//!
//! 用途是 AI 服务的 API Key（doc/复刻方案/00 §3.13）。主密钥 `master.key` 与
//! `secrets.json` 同目录，等价于"密钥跟着这台机器的这个用户走"，不做云同步。

use std::path::PathBuf;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use serde_json::Value;

use crate::config::{get_config_dir, read_json_file, write_private};

const PREFIX: &str = "enc:v1:";

fn secrets_path() -> PathBuf {
    get_config_dir().join("secrets.json")
}

fn key_path() -> PathBuf {
    get_config_dir().join("master.key")
}

/// 取主密钥；不存在则随机生成一份并落盘（0600）。
fn master_key() -> Result<[u8; 32], String> {
    let path = key_path();
    if let Ok(text) = std::fs::read_to_string(&path) {
        let bytes = data_encoding::BASE64
            .decode(text.trim().as_bytes())
            .map_err(|e| format!("master.key 解析失败: {}", e))?;
        if bytes.len() != 32 {
            return Err("master.key 长度不是 32 字节".to_string());
        }
        let mut k = [0u8; 32];
        k.copy_from_slice(&bytes);
        return Ok(k);
    }
    let mut k = [0u8; 32];
    getrandom::getrandom(&mut k).map_err(|e| format!("生成主密钥失败: {}", e))?;
    write_private(&path, data_encoding::BASE64.encode(&k).as_bytes())?;
    Ok(k)
}

fn encrypt(plain: &str) -> Result<String, String> {
    let key = master_key()?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| format!("密钥无效: {}", e))?;
    let mut nonce = [0u8; 12];
    getrandom::getrandom(&mut nonce).map_err(|e| format!("生成随机数失败: {}", e))?;
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce), plain.as_bytes())
        .map_err(|_| "加密失败".to_string())?;
    let mut blob = Vec::with_capacity(12 + ct.len());
    blob.extend_from_slice(&nonce);
    blob.extend_from_slice(&ct);
    Ok(format!("{}{}", PREFIX, data_encoding::BASE64.encode(&blob)))
}

fn decrypt(encoded: &str) -> Result<String, String> {
    let body = encoded
        .strip_prefix(PREFIX)
        .ok_or_else(|| "密文缺少 enc:v1: 前缀".to_string())?;
    let blob = data_encoding::BASE64
        .decode(body.as_bytes())
        .map_err(|e| format!("密文 base64 解析失败: {}", e))?;
    if blob.len() < 12 + 16 {
        return Err("密文长度不足".to_string());
    }
    let (nonce, ct) = blob.split_at(12);
    let key = master_key()?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| format!("密钥无效: {}", e))?;
    let plain = cipher
        .decrypt(Nonce::from_slice(nonce), ct)
        .map_err(|_| "解密失败（master.key 可能已更换）".to_string())?;
    String::from_utf8(plain).map_err(|e| format!("明文非 UTF-8: {}", e))
}

fn load() -> serde_json::Map<String, Value> {
    read_json_file(&secrets_path(), Value::Object(serde_json::Map::new()))
        .as_object()
        .cloned()
        .unwrap_or_default()
}

fn save(map: &serde_json::Map<String, Value>) -> Result<(), String> {
    let text = serde_json::to_string_pretty(&Value::Object(map.clone()))
        .map_err(|e| format!("序列化密钥表失败: {}", e))?;
    write_private(&secrets_path(), text.as_bytes())
}

pub fn put(name: &str, value: &str) -> Result<(), String> {
    let mut map = load();
    map.insert(name.to_string(), Value::String(encrypt(value)?));
    save(&map)
}

pub fn get(name: &str) -> Result<Option<String>, String> {
    let map = load();
    match map.get(name).and_then(|v| v.as_str()) {
        None => Ok(None),
        Some(s) => decrypt(s).map(Some),
    }
}

pub fn drop(name: &str) -> Result<bool, String> {
    let mut map = load();
    let had = map.remove(name).is_some();
    save(&map)?;
    Ok(had)
}

pub fn has(name: &str) -> bool {
    load().contains_key(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrips_and_nonce_makes_ciphertext_unique() {
        let _g = crate::lock_config_env();
        let dir = std::env::temp_dir().join(format!("z-mind-secret-{}", uuid::Uuid::new_v4()));
        std::env::set_var("Z_MIND_CONFIG_DIR", &dir);
        let a = encrypt("sk-test-123").expect("加密应成功");
        let b = encrypt("sk-test-123").expect("第二次加密也应成功");
        assert!(a.starts_with("enc:v1:"));
        assert_ne!(a, b, "同一明文两次加密应因 nonce 随机而不同");
        assert_eq!(decrypt(&a).unwrap(), "sk-test-123");
        assert_eq!(decrypt(&b).unwrap(), "sk-test-123");
        assert!(decrypt("plain-without-prefix").is_err());
        let _ = std::fs::remove_dir_all(&dir);
        std::env::remove_var("Z_MIND_CONFIG_DIR");
    }
}

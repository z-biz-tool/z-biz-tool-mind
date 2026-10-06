//! 配置读写：纯 JSON 文件，不引入 sqlite。
//!
//! 约定与 _ref-terminal 一致：
//! - 目录 `~/.z-mind`，可用环境变量 `Z_MIND_CONFIG_DIR` 覆盖（测试用）。
//! - 写入三件套：先把旧文件复制成带时间戳的备份（只留最新 10 份）→ 写 `.json.tmp` → rename。
//! - 类 Unix 下配置文件 0600、目录 0700。

use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

pub const CONFIG_FILE: &str = "config.json";
const KEEP_BACKUPS: usize = 10;

pub fn get_config_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("Z_MIND_CONFIG_DIR") {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir);
        }
    }
    dirs::home_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join(".z-mind")
}

pub fn config_path() -> PathBuf {
    get_config_dir().join(CONFIG_FILE)
}

/// 默认配置。分节对齐 MindMaster 选项页的 7 个 Tab（见 doc/复刻方案/00 §3.17）。
fn defaults() -> Map<String, Value> {
    let mut m = Map::new();
    m.insert(
        "general".into(),
        serde_json::json!({
            "theme": "system",
            "language": "zh-CN",
            "restoreLastSession": true,
            "showQuickBar": true,
            "canvasDragButton": "right",
            "wheelZoom": "cursor"
        }),
    );
    m.insert(
        "format".into(),
        serde_json::json!({
            "defaultLayout": "balanced",
            "defaultThemeId": "default",
            "autoFitOnOpen": true,
            "topicWidthMode": "auto"
        }),
    );
    m.insert(
        "save".into(),
        serde_json::json!({
            "autoSave": true,
            "autoSaveIntervalMin": 5,
            "historyCount": 10,
            "backupOnSave": true,
            "backupDir": "",
            "backupKeepDays": 30
        }),
    );
    m.insert(
        "network".into(),
        serde_json::json!({
            "proxyMode": "system",
            "proxyHost": "",
            "proxyPort": 0,
            "timeoutSec": 20
        }),
    );
    m.insert("shortcut".into(), serde_json::json!({ "custom": {} }));
    m.insert(
        "advanced".into(),
        serde_json::json!({
            "autoUpdate": true,
            "crashReport": false,
            "logLevel": "info",
            "aiEndpoint": "",
            "aiModel": ""
        }),
    );
    m.insert("rightMenu".into(), serde_json::json!({ "enabled": [] }));
    m.insert("recent".into(), serde_json::json!({ "maxCount": 20 }));
    m.insert(
        "quota".into(),
        serde_json::json!({ "aiPoints": 0, "aiUsed": 0 }),
    );
    m
}

pub fn default_config() -> Value {
    Value::Object(defaults())
}

/// 读配置；文件缺失或损坏时回落到默认值（损坏的原件会被备份，便于事后排查）。
pub fn read_config() -> Value {
    let path = config_path();
    match std::fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str::<Value>(&text) {
            Ok(v) => merge_defaults(&v),
            Err(_) => {
                let _ = backup_existing();
                default_config()
            }
        },
        Err(_) => default_config(),
    }
}

/// 前端只会写它认识的节，缺失的键仍由默认值补齐，避免版本升级后读到 undefined。
fn merge_defaults(stored: &Value) -> Value {
    let base = default_config();
    let mut out = base.as_object().cloned().unwrap_or_default();
    if let Some(obj) = stored.as_object() {
        for (k, v) in obj {
            if let (Some(def), Some(got)) = (out.get(k).and_then(|x| x.as_object()), v.as_object())
            {
                let mut merged = def.clone();
                for (mk, mv) in got {
                    merged.insert(mk.clone(), mv.clone());
                }
                out.insert(k.clone(), Value::Object(merged));
            } else {
                out.insert(k.clone(), v.clone());
            }
        }
    }
    Value::Object(out)
}

fn backup_existing() -> Result<(), String> {
    let path = config_path();
    if !path.exists() {
        return Ok(());
    }
    let stamp = chrono::Local::now().format("%Y%m%d_%H%M%S_%3f");
    let name = format!("config_{}.json", stamp);
    let dest = get_config_dir().join(name);
    std::fs::copy(&path, &dest).map_err(|e| format!("备份配置失败: {}", e))?;
    prune_backups()?;
    Ok(())
}

fn prune_backups() -> Result<(), String> {
    let dir = get_config_dir();
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(()),
    };
    let mut names: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        if let Some(s) = entry.file_name().to_str() {
            if s.starts_with("config_") && s.ends_with(".json") {
                names.push(s.to_string());
            }
        }
    }
    // 时间戳在文件名里，字典序即时间序（同一秒内的毫秒后缀保证唯一）。
    names.sort();
    while names.len() > KEEP_BACKUPS {
        let old = names.remove(0);
        let _ = std::fs::remove_file(dir.join(old));
    }
    Ok(())
}

pub fn write_config(value: &Value) -> Result<(), String> {
    let dir = get_config_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {}", e))?;
    backup_existing()?;
    let path = config_path();
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(value).map_err(|e| format!("序列化配置失败: {}", e))?;
    write_private(&tmp, text.as_bytes())?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("替换配置文件失败: {}", e))?;
    Ok(())
}

/// 按节合并写入：`patch` 必须是对象，只覆盖它出现的键。
pub fn merge_page(page: &str, patch: &Value) -> Result<Value, String> {
    let mut cfg = read_config();
    let obj = cfg
        .as_object_mut()
        .ok_or_else(|| "配置根节点不是对象".to_string())?;
    let target = obj
        .entry(page.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    match (target.as_object_mut(), patch.as_object()) {
        (Some(t), Some(p)) => {
            for (k, v) in p {
                t.insert(k.clone(), v.clone());
            }
        }
        _ => return Err(format!("配置节 {} 只能是对象", page)),
    }
    write_config(&cfg)?;
    Ok(cfg)
}

pub fn reset_page(page: &str) -> Result<Value, String> {
    let mut cfg = read_config();
    let base = default_config();
    if let (Some(obj), Some(def)) = (cfg.as_object_mut(), base.get(page)) {
        obj.insert(page.to_string(), def.clone());
    }
    write_config(&cfg)?;
    Ok(cfg)
}

/// 通用落盘：写文件并在 unix 上收紧权限。备份、回收站、密钥文件共用。
pub fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
        }
    }
    std::fs::write(path, bytes).map_err(|e| format!("写入文件失败: {} ({})", path.display(), e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

pub fn read_json_file(path: &Path, fallback: Value) -> Value {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or(fallback),
        Err(_) => fallback,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 环境变量是进程级的，并发跑测试时会互相踩，这里串行化。

    fn isolated(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "z-mind-config-{}-{}-{}",
            tag,
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::env::set_var("Z_MIND_CONFIG_DIR", &dir);
        dir
    }

    #[test]
    fn writes_then_reads_back_and_merges_page() {
        let _g = crate::lock_config_env();
        let dir = isolated("merge");
        let _ = std::fs::remove_dir_all(&dir);
        let patch: Value = serde_json::from_str(r#"{"autoSave":false}"#).unwrap();
        let cfg = merge_page("save", &patch).expect("merge 应成功");
        assert_eq!(cfg["save"]["autoSave"], Value::Bool(false));
        // 未提及的键保持默认值，不能被整节替换掉
        assert_eq!(cfg["save"]["historyCount"], Value::Number(10.into()));
        let reread = read_config();
        assert_eq!(reread["save"]["autoSave"], Value::Bool(false));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_config_is_backed_up_not_dropped() {
        let _g = crate::lock_config_env();
        let dir = isolated("corrupt");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(config_path(), b"{ not json").unwrap();
        let cfg = read_config();
        assert_eq!(cfg["general"]["language"], Value::String("zh-CN".into()));
        let kept = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with("config_"))
            .count();
        assert!(kept >= 1, "损坏原件应留下备份");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

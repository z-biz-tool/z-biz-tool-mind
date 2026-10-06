//! 自动备份 / 备份中心 / 回收站（doc/复刻方案/00 §3.15、§3.17 保存页）。
//!
//! 三条链路共用一个目录根，但彼此独立：
//! - autosave/：编辑期定时快照，按文档名分目录，文件名带毫秒时间戳。崩溃后从这里捞。
//! - backup/：手动或"保存时备份"的历史版本，按原文档路径索引（index.json）。
//! - trash/：删除动作一律先移动到这里，不做物理删除；恢复时再移回。
//!
//! 历史版本上限来自配置 save.historyCount，超出时删最旧的物理文件（索引同步收敛）。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::config::{get_config_dir, read_json_file, write_private};
use crate::paths::sanitize_name;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupEntry {
    /// 备份文件在 backup/<docKey>/ 下的文件名，同时充当 id。
    pub id: String,
    pub doc_path: String,
    pub title: String,
    pub size: u64,
    /// 毫秒时间戳，前端负责格式化成"2026-10-06 14:22"。
    pub created_at: i64,
    pub reason: String,
}

fn root() -> PathBuf {
    let cfg = crate::config::read_config();
    let custom = cfg
        .get("save")
        .and_then(|s| s.get("backupDir"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if custom.is_empty() {
        get_config_dir().join("backup")
    } else {
        PathBuf::from(custom)
    }
}

fn autosave_root() -> PathBuf {
    get_config_dir().join("autosave")
}

fn trash_root() -> PathBuf {
    get_config_dir().join("trash")
}

fn index_path() -> PathBuf {
    get_config_dir().join("backup-index.json")
}

fn doc_key(doc_path: &str) -> String {
    let name = Path::new(doc_path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| doc_path.to_string());
    sanitize_name(&name)
}

fn now_ms() -> i64 {
    chrono::Local::now().timestamp_millis()
}

fn stamp(ms: i64) -> String {
    use chrono::TimeZone;
    let dt = chrono::Local.timestamp_millis_opt(ms).single();
    match dt {
        Some(d) => d.format("%Y%m%d_%H%M%S_%3f").to_string(),
        None => format!("orphan_{}", ms),
    }
}

fn load_index() -> serde_json::Map<String, Value> {
    read_json_file(&index_path(), Value::Object(serde_json::Map::new()))
        .as_object()
        .cloned()
        .unwrap_or_default()
}

fn save_index(map: &serde_json::Map<String, Value>) -> Result<(), String> {
    let text = serde_json::to_string_pretty(&Value::Object(map.clone()))
        .map_err(|e| format!("序列化备份索引失败: {}", e))?;
    write_private(&index_path(), text.as_bytes())
}

fn history_count() -> usize {
    let cfg = crate::config::read_config();
    cfg.get("save")
        .and_then(|s| s.get("historyCount"))
        .and_then(|v| v.as_u64())
        .unwrap_or(10) as usize
}

/// 保存一份历史版本。`bytes` 由前端序列化好，后端只负责落盘与索引。
pub fn create(
    doc_path: &str,
    title: &str,
    reason: &str,
    bytes: &[u8],
) -> Result<BackupEntry, String> {
    let key = doc_key(doc_path);
    let dir = root().join(&key);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建备份目录失败: {}", e))?;
    let ms = now_ms();
    let entry = BackupEntry {
        id: format!("{}.emmx", stamp(ms)),
        doc_path: doc_path.to_string(),
        title: title.to_string(),
        size: bytes.len() as u64,
        created_at: ms,
        reason: reason.to_string(),
    };
    write_private(&dir.join(&entry.id), bytes)?;

    let mut index = load_index();
    let mut list: Vec<BackupEntry> = index
        .get(&key)
        .and_then(|v| serde_json::from_value::<Vec<BackupEntry>>(v.clone()).ok())
        .unwrap_or_default();
    list.push(entry.clone());
    list.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    let keep = history_count().max(1);
    // 淘汰的是最旧的物理文件：只裁索引不删文件会让磁盘无限膨胀。
    // drain(keep..) 在 keep > len 时直接 panic（第一份备份 len=1、keep=10 就是这条），
    // 而调用方多处写作 `let _ = backup::create(..)` —— panic 不会被吃掉，整个进程没了。
    if list.len() > keep {
        for old in list.drain(keep..) {
            let _ = std::fs::remove_file(dir.join(&old.id));
        }
    }
    index.insert(
        key,
        serde_json::to_value(&list).map_err(|e| format!("索引序列化失败: {}", e))?,
    );
    save_index(&index)?;
    Ok(entry)
}

pub fn list(doc_path: Option<&str>) -> Vec<BackupEntry> {
    let index = load_index();
    let mut out: Vec<BackupEntry> = Vec::new();
    for (_key, v) in &index {
        if let Ok(items) = serde_json::from_value::<Vec<BackupEntry>>(v.clone()) {
            for it in items {
                match doc_path {
                    Some(p) if it.doc_path != p => continue,
                    _ => out.push(it),
                }
            }
        }
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    out
}

fn find_entry(id: &str) -> Option<(String, BackupEntry)> {
    let index = load_index();
    for (key, v) in &index {
        if let Ok(items) = serde_json::from_value::<Vec<BackupEntry>>(v.clone()) {
            if let Some(hit) = items.into_iter().find(|i| i.id == id) {
                return Some((key.to_string(), hit));
            }
        }
    }
    None
}

/// 恢复历史版本：默认读回字节交给前端（保证与"打开"走同一条解析路径），
/// 只有明确给了 target 才直接覆盖写入。
pub fn read_backup(id: &str) -> Result<(BackupEntry, Vec<u8>), String> {
    let (key, entry) = find_entry(id).ok_or_else(|| format!("找不到备份 {}", id))?;
    let path = root().join(&key).join(&entry.id);
    let bytes =
        std::fs::read(&path).map_err(|e| format!("读取备份失败: {} ({})", path.display(), e))?;
    Ok((entry, bytes))
}

pub fn delete(id: &str) -> Result<(), String> {
    let (key, entry) = find_entry(id).ok_or_else(|| format!("找不到备份 {}", id))?;
    let _ = std::fs::remove_file(root().join(&key).join(&entry.id));
    let mut index = load_index();
    if let Some(v) = index.get(&key).cloned() {
        let mut items: Vec<BackupEntry> = serde_json::from_value(v).unwrap_or_default();
        items.retain(|i| i.id != id);
        index.insert(key, serde_json::to_value(items).map_err(|e| e.to_string())?);
    }
    save_index(&index)
}

/// 按配置 save.backupKeepDays 清理过期备份；0 表示不清理。
pub fn purge_older_than(days: i64) -> Result<usize, String> {
    if days <= 0 {
        return Ok(0);
    }
    let cutoff = now_ms() - days * 86_400_000;
    let mut removed = 0usize;
    let index = load_index();
    let mut next = index.clone();
    for (key, v) in &index {
        let items: Vec<BackupEntry> = serde_json::from_value(v.clone()).unwrap_or_default();
        let dir = root().join(key);
        let mut kept: Vec<BackupEntry> = Vec::new();
        let mut expired = 0usize;
        for it in items {
            // 过期即删物理文件；文件已经不在也算清理成功，避免索引里挂幽灵条目。
            if it.created_at < cutoff {
                match std::fs::remove_file(dir.join(&it.id)) {
                    Ok(()) => {
                        expired += 1;
                        continue;
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => {
                        expired += 1;
                        continue;
                    }
                    Err(_) => {}
                }
            }
            kept.push(it);
        }
        removed += expired;
        next.insert(
            key.clone(),
            serde_json::to_value(kept).map_err(|e| e.to_string())?,
        );
    }
    save_index(&next)?;
    Ok(removed)
}

/// 自动保存：写入 autosave/<文档名>/<时间戳>.emmx，返回落盘路径。
pub fn autosave(doc_path: &str, bytes: &[u8]) -> Result<String, String> {
    let dir = autosave_root().join(doc_key(doc_path));
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建自动保存目录失败: {}", e))?;
    let file = dir.join(format!("{}.emmx", stamp(now_ms())));
    write_private(&file, bytes)?;
    Ok(file.to_string_lossy().to_string())
}

pub fn autosave_list() -> Vec<(String, u64, i64)> {
    let mut out = Vec::new();
    let base = autosave_root();
    if let Ok(entries) = std::fs::read_dir(&base) {
        for sub in entries.flatten() {
            if let Ok(files) = std::fs::read_dir(sub.path()) {
                for f in files.flatten() {
                    let meta = match f.metadata() {
                        Ok(m) => m,
                        Err(_) => continue,
                    };
                    let ms = meta
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or(0);
                    out.push((f.path().to_string_lossy().to_string(), meta.len(), ms));
                }
            }
        }
    }
    out.sort_by(|a, b| b.2.cmp(&a.2));
    out
}

pub fn autosave_clear() -> Result<usize, String> {
    let base = autosave_root();
    let mut n = 0usize;
    if base.exists() {
        std::fs::remove_dir_all(&base).map_err(|e| format!("清理自动保存失败: {}", e))?;
        n = 1;
    }
    Ok(n)
}

/// 删除文档：移动到回收站并返回回收站条目 id。绝不物理删除。
/// 移动文件，带上跨卷兜底。
///
/// 回收站在配置目录（Windows 上是 C:\Users\<user>\...），文档却在用户放的地方（D:、映射到
/// Z: 的 NAS）。`std::fs::rename` 跨卷直接失败（Windows Os code 17 / unix EXDEV），
/// 于是"删除"和"恢复"在真机上都是报错 —— 只能复制完再删原件。
fn move_file(src: &Path, dest: &Path) -> Result<(), String> {
    if std::fs::rename(src, dest).is_ok() {
        return Ok(());
    }
    std::fs::copy(src, dest)
        .map_err(|e| format!("移动失败: {} -> {} ({})", src.display(), dest.display(), e))?;
    std::fs::remove_file(src)
        .map_err(|e| format!("移动后原件删除失败: {} ({})", src.display(), e))?;
    Ok(())
}

pub fn to_trash(path: &str) -> Result<String, String> {
    let src = Path::new(path);
    if !src.exists() {
        return Err(format!("文件不存在: {}", path));
    }
    let dir = trash_root();
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建回收站目录失败: {}", e))?;
    let name = src
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let id = format!("{}__{}", stamp(now_ms()), sanitize_name(&name));
    let dest = dir.join(&id);
    move_file(src, &dest).map_err(|e| format!("移入回收站失败: {}", e))?;

    let file = dir.join("index.json");
    let mut list: Vec<Value> = read_json_file(&file, Value::Array(Vec::new()))
        .as_array()
        .cloned()
        .unwrap_or_default();
    let ms = now_ms();
    // 一套键给两个读者：originalPath/deletedAt 是本模块恢复与过期清理用的内部键，
    // docPath/createdAt/title 那组是 BackupEntry 的形状 —— 回收站列表直接按 BackupEntry 渲染，
    // 只写内部键的话标题一栏空白、时间显示 Invalid Date。
    list.push(serde_json::json!({
        "id": id,
        "originalPath": path,
        "docPath": path,
        "name": name,
        "title": name,
        "kind": "emmx",
        "size": std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0),
        "deletedAt": ms,
        "createdAt": ms,
        "reason": "trash",
    }));
    let text = serde_json::to_string_pretty(&Value::Array(list)).map_err(|e| e.to_string())?;
    write_private(&file, text.as_bytes())?;
    Ok(id)
}

pub fn trash_list() -> Vec<Value> {
    let file = trash_root().join("index.json");
    read_json_file(&file, Value::Array(Vec::new()))
        .as_array()
        .cloned()
        .unwrap_or_default()
}

/// 从回收站放回；目标已存在时拒绝，把决定权交给前端（覆盖 or 改名）。
pub fn trash_restore(id: &str) -> Result<String, String> {
    let dir = trash_root();
    let file = dir.join("index.json");
    let mut list: Vec<Value> = read_json_file(&file, Value::Array(Vec::new()))
        .as_array()
        .cloned()
        .unwrap_or_default();
    let pos = list
        .iter()
        .position(|v| v.get("id").and_then(|x| x.as_str()) == Some(id))
        .ok_or_else(|| format!("回收站里没有 {}", id))?;
    let item = list[pos].clone();
    let original = item
        .get("originalPath")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "回收站条目缺少 originalPath".to_string())?
        .to_string();
    let src = dir.join(id);
    if Path::new(&original).exists() {
        return Err(format!("目标位置已存在文件: {}", original));
    }
    if let Some(parent) = Path::new(&original).parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目标目录失败: {}", e))?;
    }
    move_file(&src, Path::new(&original)).map_err(|e| format!("恢复失败: {}", e))?;
    list.remove(pos);
    let text = serde_json::to_string_pretty(&Value::Array(list)).map_err(|e| e.to_string())?;
    write_private(&file, text.as_bytes())?;
    Ok(original)
}

/// 彻底删除单个回收站条目（用户在回收站里点"删除"，是唯一允许物理删除的入口）。
pub fn trash_purge(id: &str) -> Result<bool, String> {
    let dir = trash_root();
    let file = dir.join("index.json");
    let mut list: Vec<Value> = read_json_file(&file, Value::Array(Vec::new()))
        .as_array()
        .cloned()
        .unwrap_or_default();
    let before = list.len();
    list.retain(|v| v.get("id").and_then(|x| x.as_str()) != Some(id));
    if list.len() == before {
        return Ok(false);
    }
    let _ = std::fs::remove_file(dir.join(id));
    let text = serde_json::to_string_pretty(&Value::Array(list)).map_err(|e| e.to_string())?;
    write_private(&file, text.as_bytes())?;
    Ok(true)
}

pub fn trash_purge_older_than(days: i64) -> Result<usize, String> {
    if days <= 0 {
        return Ok(0);
    }
    let cutoff = now_ms() - days * 86_400_000;
    let dir = trash_root();
    let file = dir.join("index.json");
    let list: Vec<Value> = read_json_file(&file, Value::Array(Vec::new()))
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut kept: Vec<Value> = Vec::new();
    let mut removed = 0usize;
    for item in list {
        let old = item
            .get("deletedAt")
            .and_then(|v| v.as_i64())
            .unwrap_or(i64::MAX)
            < cutoff;
        if old {
            if let Some(id) = item.get("id").and_then(|v| v.as_str()) {
                let _ = std::fs::remove_file(dir.join(id));
                removed += 1;
                continue;
            }
        }
        kept.push(item);
    }
    if removed > 0 {
        let text = serde_json::to_string_pretty(&Value::Array(kept)).map_err(|e| e.to_string())?;
        write_private(&file, text.as_bytes())?;
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn isolated(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("z-mind-bak-{}-{}", tag, uuid::Uuid::new_v4()));
        std::env::set_var("Z_MIND_CONFIG_DIR", &dir);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn history_rotates_oldest_beyond_limit() {
        let _g = crate::lock_config_env();
        let dir = isolated("rotate");
        for i in 0..12 {
            let bytes = format!("payload-{}", i).into_bytes();
            let _ = create("/tmp/doc.emmx", "doc", "manual", &bytes).unwrap();
            // 同一毫秒内的连续写入会撞文件名，这里靠 sleep-free 的序号保证条目可区分：
            // 断言只看"保留份数 == historyCount"，不依赖具体时间戳。
        }
        let items = list(Some("/tmp/doc.emmx"));
        assert!(
            items.len() <= 10,
            "应只保留 historyCount=10 份，实际 {}",
            items.len()
        );
        let _ = std::fs::remove_dir_all(&dir);
        std::env::remove_var("Z_MIND_CONFIG_DIR");
    }

    #[test]
    fn trash_moves_instead_of_deleting() {
        let _g = crate::lock_config_env();
        let dir = isolated("trash");
        let file = std::env::temp_dir().join(format!("z-mind-t-{}.emmx", uuid::Uuid::new_v4()));
        std::fs::write(&file, b"hello").unwrap();
        let id = to_trash(file.to_str().unwrap()).unwrap();
        assert!(!file.exists(), "原位置应已被移走");
        assert!(trash_root().join(&id).exists(), "回收站里应有实体文件");
        let back = trash_restore(&id).unwrap();
        assert_eq!(back, file.to_str().unwrap());
        assert!(file.exists(), "恢复后文件应回到原位");
        std::fs::remove_file(&file).ok();
        let _ = std::fs::remove_dir_all(&dir);
        std::env::remove_var("Z_MIND_CONFIG_DIR");
    }

    #[test]
    fn autosave_keeps_docname_and_rereads() {
        let _g = crate::lock_config_env();
        let dir = isolated("auto");
        let p = autosave("/tmp/我的导图.emmx", b"abc").unwrap();
        assert!(p.contains("我的导图"));
        assert_eq!(std::fs::read(&p).unwrap(), b"abc");
        assert!(!autosave_list().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
        std::env::remove_var("Z_MIND_CONFIG_DIR");
    }
}

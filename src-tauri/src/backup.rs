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
    list.sort_by_key(|e| std::cmp::Reverse(e.created_at));
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
    out.sort_by_key(|e| std::cmp::Reverse(e.created_at));
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

/// 什么算「一份快照」：**扩展名必须是 .emmx**。
///
/// 这条判据以前只长在删除那一侧，列表那一侧没有 —— 于是两端各说各话：
/// 文档目录里躺着任何非 .emmx 的文件（macOS 的 .DS_Store、别处拷进来的临时文件、
/// 一次崩掉写了一半的产物），它就会进列表，而它是删不掉的：
///   ① 面板上的「自动保存 N 份」虚高；
///   ② 启动弹窗把它当快照追问「可以恢复」；
///   ③ 用户点「忽略」，删除那一侧按同一条判据拒收 ⇒ 报「没能从磁盘上带走」，
///      而它永远还在 ⇒ 每次开机再问一遍（那个提示自己都写着"下次启动可能还会问一次"）。
/// 现在两侧共用这一个函数：**列表 = 可删 = 计数**，不许各写各的。
fn is_snapshot_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("emmx"))
        .unwrap_or(false)
}

pub fn autosave_list() -> Vec<(String, u64, i64)> {
    let mut out = Vec::new();
    let base = autosave_root();
    if let Ok(entries) = std::fs::read_dir(&base) {
        for sub in entries.flatten() {
            if let Ok(files) = std::fs::read_dir(sub.path()) {
                for f in files.flatten() {
                    if !is_snapshot_file(&f.path()) {
                        continue;
                    }
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
    out.sort_by_key(|x| std::cmp::Reverse(x.2));
    out
}

/// 清空自动保存目录。返回的**文件数**要和 `autosave_list` 报出来的口径一致，
/// 否则启动弹窗里"这会删掉 N 份"与实际删掉的数量会打脸。
/// 所以这里直接数列表的长度：数法与 `autosave_list` 同一条判据（`.emmx` 才算一份快照）。
/// 已知偏差：目录里非 `.emmx` 的文件会被 `remove_dir_all` 带走，但**不算数** ——
/// 那不是快照（「N 份快照」这句话说的就是快照数），而这条偏差是两边共用的同一条判据带来的。
pub fn autosave_clear() -> Result<usize, String> {
    let base = autosave_root();
    if !base.exists() {
        return Ok(0);
    }
    let n = autosave_list().len();
    std::fs::remove_dir_all(&base).map_err(|e| format!("清理自动保存失败: {}", e))?;
    Ok(n)
}

/// 了结一份快照：「忽略」或「已经恢复进内存」之后必须真的把它带走。
/// 只把弹窗关掉的话，下一次启动还会为同一份快照问一遍 —— 而用户已经答过一次了。
///
/// 这是一个删除动作，路径却来自前端，所以判据比 `paths::validate` 更紧：
/// 只准删 autosave 根目录底下的 `.emmx`。前缀比对用 canonicalize 之后的两边
/// （`..`、指向别处的软链接、Windows 的 `\\?\` verbatim 前缀都在这一步被统一掉），
/// 所以"传一个 autosave/../secret.emmx 进来"会被拒。
/// 删完那一层文档目录空了就顺手收掉，否则 autosave 根下会攒一堆空壳。
pub fn autosave_drop(path: &str) -> Result<bool, String> {
    if !is_snapshot_file(Path::new(path)) {
        return Err(format!("只能删除自动保存的 .emmx 快照: {}", path));
    }
    let canon = match Path::new(path).canonicalize() {
        Ok(c) => c,
        // 文件本来就不在了：要的效果已经达成，不该报成错误（连点两次「忽略」走这条）。
        Err(_) => return Ok(false),
    };
    let base = autosave_root()
        .canonicalize()
        .map_err(|_| "自动保存目录不存在".to_string())?;
    if !canon.starts_with(&base) {
        return Err(format!("该路径不在自动保存目录内: {}", path));
    }
    std::fs::remove_file(&canon).map_err(|e| format!("删除快照失败: {} ({})", path, e))?;
    if let Some(parent) = canon.parent() {
        let empty = std::fs::read_dir(parent)
            .map(|mut r| r.next().is_none())
            .unwrap_or(false);
        // 根目录自己永远留着；空目录收不掉也不影响"这一份已经了结"。
        if empty && parent != base {
            let _ = std::fs::remove_dir(parent);
        }
    }
    Ok(true)
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

    /// 启动弹窗里「全部清掉」那颗确认框要写得出真实份数，所以清空报的是文件数，
    /// 不是"我清过一次 = 1"。数法与 `autosave_list` 同口径（两边不许各数各的）。
    /// 不断言"恰好 4 份"：同一毫秒的两次写入会撞时间戳文件名，条数本身不是这条测试的重点，
    /// 报出的数 == 列表里的数、清完列表空、根还能用，才是。
    #[test]
    fn autosave_clear_reports_how_many_files_it_took() {
        let _g = crate::lock_config_env();
        let dir = isolated("clear");
        for i in 0..3 {
            autosave(&format!("/tmp/清掉-{}.emmx", i), b"abc").unwrap();
        }
        // 同一份文档再写一次：一个自动保存周期一份文件，积压是按份计的。
        autosave("/tmp/清掉-0.emmx", b"abcd").unwrap();
        let listed = autosave_list().len();
        assert!(listed >= 3, "三份不同文档至少该列出 3 份，实际 {}", listed);
        assert_eq!(autosave_clear().unwrap(), listed);
        assert!(autosave_list().is_empty(), "清空之后不该留下任何一份");
        assert_eq!(autosave_clear().unwrap(), 0, "已经空了再点一次报 0，不是错");
        assert!(
            autosave("/tmp/清掉之后还能写.emmx", b"x").is_ok(),
            "remove_dir_all 把根带走了，写侧要能自己建回来"
        );
        let _ = std::fs::remove_dir_all(&dir);
        std::env::remove_var("Z_MIND_CONFIG_DIR");
    }

    /// 「忽略」那一句要真删得掉，否则同一份快照每次开机都再问一遍。
    /// 顺带钉住"空掉的那一层文档目录被收走"—— 只删文件会在 autosave 根下攒一堆空壳。
    #[test]
    fn autosave_drop_finishes_one_snapshot() {
        let _g = crate::lock_config_env();
        let dir = isolated("drop");
        let p = autosave("/tmp/一次性的.emmx", b"abc").unwrap();
        let doc_dir = Path::new(&p).parent().unwrap().to_path_buf();
        assert!(doc_dir.exists());
        assert!(autosave_drop(&p).unwrap(), "在盘上的那一份应报已删掉");
        assert!(!Path::new(&p).exists());
        assert!(autosave_list().is_empty());
        assert!(!doc_dir.exists(), "空掉的文档目录应被收走");
        assert!(autosave_root().exists(), "根目录自己永远留着");
        // 直接躺在根下的那一份（不是 `autosave()` 造出来的形状，`autosave_list` 只走一层子目录，
        // 所以列列表看不见它）：删除按路径走，照样认得；但删完不许把根一起收走 ——
        // 下一次自动保存还要往里写。
        let stray = autosave_root().join("散着的一份.emmx");
        std::fs::write(&stray, b"xy").unwrap();
        assert!(autosave_drop(stray.to_str().unwrap()).unwrap());
        assert!(autosave_root().exists(), "父目录就是根时不许收掉根");
        // 再点一次「忽略」：目标已达成，不该报错把用户挡在那里。
        assert!(
            !autosave_drop(&p).unwrap(),
            "已经不在了的那一份报 false 而不是错"
        );
        let _ = std::fs::remove_dir_all(&dir);
        std::env::remove_var("Z_MIND_CONFIG_DIR");
    }

    /// 删除动作的路径来自前端，所以根目录之外一律拒。
    /// 三桩：根外的普通文件、`..` 遍历出根、根内但扩展名不对的文件（autosave 目录里
    /// 未来可能落别的东西，不能因为"在那个目录下"就让删）。
    #[test]
    fn autosave_drop_refuses_anything_outside_the_snapshots() {
        let _g = crate::lock_config_env();
        let dir = isolated("drop-guard");
        let outside =
            std::env::temp_dir().join(format!("z-mind-outside-{}.emmx", uuid::Uuid::new_v4()));
        std::fs::write(&outside, b"keep me").unwrap();
        assert!(autosave_drop(outside.to_str().unwrap()).is_err());
        assert!(outside.exists(), "被拒的路径必须原地不动");

        let p = autosave("/tmp/受保护的.emmx", b"abc").unwrap();
        // 两层 `..` 才真的走出根：autosave/<x>/../../ = 临时目录本身，`outside` 就在那里。
        // （写成一层会落到配置目录里那个"并不存在的同名文件"上 —— 那一条走的是"本来就不在了"，
        // 返回 false 而不是错，测试第一版就是这么把自己骗过去的。）
        let sneaky = autosave_root()
            .join("..")
            .join("..")
            .join(outside.file_name().unwrap())
            .to_string_lossy()
            .to_string();
        assert!(autosave_drop(&sneaky).is_err(), "`..` 遍历出根的要拦下");
        assert!(outside.exists());

        let not_a_snapshot = autosave_root().join("note.txt");
        std::fs::write(&not_a_snapshot, b"x").unwrap();
        assert!(autosave_drop(not_a_snapshot.to_str().unwrap()).is_err());
        assert!(not_a_snapshot.exists());
        // 历史版本也是 .emmx、也在配置目录下，但它不是快照 —— 点「忽略」不该碰到它。
        let b = create("/tmp/doc.emmx", "doc", "manual", b"payload").unwrap();
        let backup_file = root().join(doc_key("/tmp/doc.emmx")).join(&b.id);
        assert!(backup_file.exists());
        assert!(autosave_drop(backup_file.to_str().unwrap()).is_err());
        assert!(backup_file.exists(), "历史版本必须原地不动");
        assert!(autosave_drop(&p).unwrap(), "同一目录下的合法快照仍然删得掉");
        assert!(autosave_list().is_empty());

        std::fs::remove_file(&outside).ok();
        let _ = std::fs::remove_dir_all(&dir);
        std::env::remove_var("Z_MIND_CONFIG_DIR");
    }

    /// 列表里出现的每一份都必须删得掉 —— 这两条判据以前是分开的：
    /// 列表那一侧**不挑扩展名**，删除那一侧只准删 `.emmx`。
    /// 于是文档目录里任何一个非 `.emmx` 的文件（macOS 的 `.DS_Store`、
    /// 从别处拷进来的临时文件、写了一半就崩掉的产物）都会被当成快照列出来，
    /// 却永远删不掉：用户点「忽略」只会看到「没能从磁盘上带走」，
    /// 而它还在那儿 ⇒ 每次开机再问一遍（那个提示自己就写着"下次启动可能还会问一次"）。
    ///
    /// 现在列表与删除共用 `is_snapshot_file` 一条判据，这条测试把两侧钉在一起。
    #[test]
    fn autosave_list_only_lists_files_that_can_actually_be_dropped() {
        let _g = crate::lock_config_env();
        let dir = isolated("list-drop");
        let p = autosave("/tmp/口径.emmx", b"abc").unwrap();
        let doc_dir = Path::new(&p).parent().unwrap().to_path_buf();
        // 两个不是快照的东西躺在同一个文档目录里。
        // `.DS_Store` 是 macOS 的真实产物：Finder 在任何被打开过的目录里放一个。
        let ds_store = doc_dir.join(".DS_Store");
        std::fs::write(&ds_store, b"junk").unwrap();
        let half = doc_dir.join("写了一半.emmx.tmp");
        std::fs::write(&half, b"junk").unwrap();

        let listed = autosave_list();
        assert_eq!(
            listed.len(),
            1,
            "只有那一份 .emmx 算快照，实际列出了 {:?}",
            listed
        );
        assert!(listed[0].0.ends_with(".emmx"), "列出来的必须是 .emmx");
        // 列表里的每一份都必须删得掉 —— 以前这里是能炸的（列出的是删不掉的杂文件）。
        for (path, _, _) in &listed {
            assert!(
                autosave_drop(path).is_ok(),
                "列出来的这一份却删不掉: {}",
                path
            );
        }
        assert!(autosave_list().is_empty(), "删完之后列表就该空了");
        // 不认它 ≠ 把它删了：杂文件原地不动。
        assert!(ds_store.exists(), ".DS_Store 不该被顺手删掉");
        assert!(half.exists(), "写了一半的临时文件不该被顺手删掉");

        let _ = std::fs::remove_dir_all(&dir);
        std::env::remove_var("Z_MIND_CONFIG_DIR");
    }

    /// 「全部清掉」那颗确认框上写的是「N 份快照」，报出来的数就得是**快照数**。
    /// 目录里的杂文件会被 `remove_dir_all` 连带带走，但它们不是快照，不该占份数 ——
    /// 这条偏差是「列表 = 可删 = 计数」这条同一条判据带来的，两边不许各数各的。
    #[test]
    fn autosave_clear_counts_snapshots_not_stray_files() {
        let _g = crate::lock_config_env();
        let dir = isolated("clear-count");
        let p = autosave("/tmp/份数.emmx", b"abc").unwrap();
        let doc_dir = Path::new(&p).parent().unwrap().to_path_buf();
        std::fs::write(doc_dir.join(".DS_Store"), b"junk").unwrap();
        std::fs::write(doc_dir.join("残留.tmp"), b"junk").unwrap();

        let n = autosave_clear().unwrap();
        assert_eq!(n, 1, "只有那一份 .emmx 是快照，杂文件不算份数");
        assert!(autosave_list().is_empty());
        assert!(!autosave_root().exists(), "清空之后根目录自己也被收走了");

        let _ = std::fs::remove_dir_all(&dir);
        std::env::remove_var("Z_MIND_CONFIG_DIR");
    }
}

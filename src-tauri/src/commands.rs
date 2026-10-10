//! 前端可见的全部命令。
//!
//! 约定（与 _ref-terminal 对齐）：
//! - 一律返回 `Result<T, String>`，错误信息用中文完整句，前端直接展示。
//! - 结构体统一 `#[serde(rename_all = "camelCase")]`，TS 侧不需要再做字段名映射。
//! - 二进制走 base64 字符串而不是 `Vec<u8>`：`Vec<u8>` 在 Tauri 的 JSON IPC 里会展开成
//!   数字数组，一个 3 MB 的 .emmx 要付出十几倍的序列化开销；base64 两端都只有一行转换。
//!   （体积换 CPU，对我们这个量级的文档是划算的。）

use serde::Serialize;
use serde_json::Value;
use tauri::{Emitter, Manager};

use crate::{backup, config, crash, log, net, paths, quota, recent, secret};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub config_dir: String,
    pub temp_dir: String,
    /// 用户的「文档」目录。原生保存框只拿到裸文件名时会停在进程工作目录
    /// （从开始菜单启动就是安装目录），所以前端要用它兜一个绝对路径出来。取不到就是空串。
    pub document_dir: String,
    pub os: String,
    pub arch: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub path: String,
    pub bytes: u64,
    /// true 表示这是一次覆盖写，覆盖前的原件已被送去备份。
    pub replaced: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutosaveItem {
    pub path: String,
    pub size: u64,
    pub modified_at: i64,
}

const B64: data_encoding::Encoding = data_encoding::BASE64;

fn decode_bytes(text: &str) -> Result<Vec<u8>, String> {
    B64.decode(text.as_bytes())
        .map_err(|e| format!("文件内容 base64 解析失败: {}", e))
}

fn encode_bytes(bytes: &[u8]) -> String {
    B64.encode(bytes)
}

#[tauri::command]
pub fn app_info(app: tauri::AppHandle) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        config_dir: config::get_config_dir().to_string_lossy().to_string(),
        temp_dir: std::env::temp_dir().to_string_lossy().to_string(),
        document_dir: app
            .path()
            .document_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
    }
}

// ---------- 配置 ----------

#[tauri::command]
pub fn config_get() -> Result<Value, String> {
    Ok(config::read_config())
}

/// 把「高级」一节里那两个即时生效的键同步进 Rust。
///
/// 只有值真的变了才写日志：改一次设置会落好几条记录，级别没动还打印一次
/// 「日志级别 info → info」就是在往日志里掺噪音。
fn sync_advanced(cfg: &Value) {
    let before = log::current_level();
    let after = log::configure_from(cfg);
    if before != after {
        log::log(
            "info",
            "config",
            &format!("日志级别 {before} → {after}（立即生效）"),
        );
    }
    let crash_before = crash::enabled();
    let crash_after = crash::configure_from(cfg);
    if crash_before != crash_after {
        log::log(
            "info",
            "config",
            &format!(
                "崩溃记录 {} → {}（立即生效）",
                if crash_before { "开" } else { "关" },
                if crash_after { "开" } else { "关" }
            ),
        );
    }
}

/// 写一节配置。**先校验再落盘**：非法值一个字节都不许进 config.json。
///
/// 顺序很要紧 —— 先写再校验的话，用户填了个不能用的代理地址，文件里就留下一份
/// 应用启动时会拒绝加载的设置，而他看到的是一个已经存进去的界面。
#[tauri::command]
pub fn config_set(page: String, patch: Value) -> Result<Value, String> {
    let mut merged = config::merged_page(&page, &patch)?;
    if page == "network" {
        net::sanitize(&mut merged);
        net::validate(&merged)?;
    }
    config::write_config(&merged)?;

    // 高级一节里有两个会立刻改变 Rust 行为的键：日志级别与崩溃记录。两者都不用在
    // 改完之后重启 —— 关下去之后下一条记录就不该写、下一次 panic 就不该留痕。
    if page == "advanced" {
        sync_advanced(&merged);
    }
    if page == "network" {
        if let Ok(st) = net::status(&merged) {
            log::log("info", "config", &st.message);
        }
    }
    let keys: Vec<String> = patch
        .as_object()
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default();
    log::log(
        "debug",
        "config",
        &format!("更新 {page}: {}", keys.join(", ")),
    );
    Ok(merged)
}

#[tauri::command]
pub fn config_reset_page(page: String) -> Result<Value, String> {
    let cfg = config::reset_page(&page)?;
    if page == "advanced" {
        sync_advanced(&cfg);
    }
    Ok(cfg)
}

// ---------- 最近打开 ----------

#[tauri::command]
pub fn recent_list() -> Result<Vec<recent::RecentItem>, String> {
    Ok(recent::list())
}

#[tauri::command]
pub fn recent_touch(
    path: String,
    title: String,
    kind: String,
) -> Result<Vec<recent::RecentItem>, String> {
    recent::touch(&path, &title, &kind)
}

#[tauri::command]
pub fn recent_remove(path: String) -> Result<Vec<recent::RecentItem>, String> {
    recent::remove(&path)
}

#[tauri::command]
pub fn recent_clear() -> Result<(), String> {
    recent::clear()
}

#[tauri::command]
pub fn recent_set_capacity(max_count: usize) -> Result<Vec<recent::RecentItem>, String> {
    recent::set_capacity(max_count)
}

#[tauri::command]
pub fn recent_set_pinned(path: String, pinned: bool) -> Result<Vec<recent::RecentItem>, String> {
    recent::set_pinned(&path, pinned)
}

// ---------- 免费档保存配额 ----------

/// 只有真的写盘成功才调这个；打开走 recent_touch，那条不占名额（01 A-13）。
#[tauri::command]
pub fn quota_mark_saved(path: String) -> Result<usize, String> {
    quota::mark_saved(&path)
}

/// 已占用的名额清单，前端拿它做"已保存 N/10"的判定与文案。
#[tauri::command]
pub fn quota_saved_list() -> Result<Vec<String>, String> {
    Ok(quota::list())
}

// ---------- 文件字节 ----------

#[tauri::command]
pub fn file_read_bytes(path: String) -> Result<String, String> {
    let p = paths::validate(&path, false)?;
    let bytes = std::fs::read(&p).map_err(|e| format!("读取文件失败: {} ({})", path, e))?;
    Ok(encode_bytes(&bytes))
}

#[tauri::command]
pub fn file_write_bytes(
    path: String,
    content_base64: String,
    overwrite: bool,
) -> Result<WriteResult, String> {
    let (target, existed) = paths::prepare_write(&path)?;
    if existed && !overwrite {
        return Err(format!("文件已存在，未指定覆盖: {}", path));
    }
    let bytes = decode_bytes(&content_base64)?;
    if existed {
        // 覆盖前留一份历史版本，用户点错"保存"也不丢原稿。
        if let Ok(old) = std::fs::read(&target) {
            let name = target
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| path.clone());
            let _ = backup::create(&path, &name, "before-overwrite", &old);
        }
    }
    let tmp = target.with_extension(format!(
        "{}.tmp",
        uuid::Uuid::new_v4()
            .simple()
            .to_string()
            .get(..8)
            .unwrap_or("part")
    ));
    config::write_private(&tmp, &bytes)?;
    std::fs::rename(&tmp, &target).map_err(|e| format!("写入文件失败: {} ({})", path, e))?;
    log::log(
        "info",
        "file",
        &format!(
            "写入 {}（{} 字节，{}）",
            target.display(),
            bytes.len(),
            if existed {
                "覆盖，原件已进历史版本"
            } else {
                "新建"
            }
        ),
    );
    Ok(WriteResult {
        path: target.to_string_lossy().to_string(),
        bytes: bytes.len() as u64,
        replaced: existed,
    })
}

#[tauri::command]
pub fn file_exists(path: String) -> Result<bool, String> {
    Ok(paths::validate(&path, false)
        .map(|p| p.exists())
        .unwrap_or(false))
}

#[tauri::command]
pub fn file_size(path: String) -> Result<u64, String> {
    let p = paths::validate(&path, false)?;
    let meta = std::fs::metadata(&p).map_err(|e| format!("读取文件信息失败: {}", e))?;
    Ok(meta.len())
}

#[tauri::command]
pub fn file_remove(path: String) -> Result<String, String> {
    let p = paths::validate(&path, false)?;
    let moved = backup::to_trash(p.to_str().ok_or_else(|| "路径不是合法 UTF-8".to_string())?)?;
    // 文档没了就还它一格：闸门文案让用户"删除不需要的文件"，删了却不还名额那句话就是假的。
    // 账本写失败不该把这次删除报成失败 —— 文件已经进回收站了。
    if let Err(e) = quota::release(p.to_str().unwrap_or_default()) {
        log::log("warn", "quota", &format!("释放保存配额失败: {}", e));
    }
    log::log("info", "file", &format!("删除 {path}，已送入回收站"));
    Ok(moved)
}

// ---------- 自动保存 ----------

#[tauri::command]
pub fn autosave_write(
    app: tauri::AppHandle,
    path: String,
    content_base64: String,
) -> Result<String, String> {
    let bytes = decode_bytes(&content_base64)?;
    let file = backup::autosave(&path, &bytes)?;
    // 事件名 kebab-case，payload 键 snake_case（与 _ref-terminal 一致）。
    let _ = app.emit(
        "autosave-fired",
        serde_json::json!({ "path": path, "snapshot": file, "bytes": bytes.len() }),
    );
    Ok(file)
}

#[tauri::command]
pub fn autosave_list() -> Result<Vec<AutosaveItem>, String> {
    Ok(backup::autosave_list()
        .into_iter()
        .map(|(p, s, t)| AutosaveItem {
            path: p,
            size: s,
            modified_at: t,
        })
        .collect())
}

#[tauri::command]
pub fn autosave_clear() -> Result<usize, String> {
    backup::autosave_clear()
}

/// 了结一份快照（「忽略」/「恢复进内存之后」）。返回 false 表示它本来就不在了。
#[tauri::command]
pub fn autosave_drop(path: String) -> Result<bool, String> {
    let dropped = backup::autosave_drop(&path)?;
    if dropped {
        log::log("info", "autosave", &format!("了结快照 {path}"));
    }
    Ok(dropped)
}

// ---------- 备份中心 ----------

#[tauri::command]
pub fn backup_now(
    app: tauri::AppHandle,
    path: String,
    title: String,
    reason: String,
    content_base64: String,
) -> Result<backup::BackupEntry, String> {
    let bytes = decode_bytes(&content_base64)?;
    let entry = backup::create(&path, &title, &reason, &bytes)?;
    let _ = app.emit(
        "emmx-saved",
        serde_json::json!({ "path": path, "bytes": bytes.len(), "backup": entry.id }),
    );
    Ok(entry)
}

#[tauri::command]
pub fn backup_list(path: Option<String>) -> Result<Vec<backup::BackupEntry>, String> {
    Ok(backup::list(path.as_deref()))
}

#[tauri::command]
pub fn backup_restore(id: String, target: Option<String>) -> Result<serde_json::Value, String> {
    let (entry, bytes) = backup::read_backup(&id)?;
    match target {
        Some(t) => {
            let (dest, _) = paths::prepare_write(&t)?;
            config::write_private(&dest, &bytes)?;
            Ok(serde_json::json!({
                "entry": entry, "writtenTo": dest.to_string_lossy().to_string()
            }))
        }
        // 不给 target 时把字节交回前端，走和"打开文件"完全相同的解析路径。
        None => Ok(serde_json::json!({ "entry": entry, "contentBase64": encode_bytes(&bytes) })),
    }
}

#[tauri::command]
pub fn backup_delete(id: String) -> Result<(), String> {
    backup::delete(&id)
}

#[tauri::command]
pub fn backup_purge(days: i64) -> Result<usize, String> {
    backup::purge_older_than(days)
}

#[tauri::command]
pub fn history_list(path: String) -> Result<Vec<backup::BackupEntry>, String> {
    Ok(backup::list(Some(&path)))
}

// ---------- 回收站 ----------

#[tauri::command]
pub fn trash_list() -> Result<Vec<Value>, String> {
    Ok(backup::trash_list())
}

#[tauri::command]
pub fn trash_restore(id: String) -> Result<String, String> {
    let back = backup::trash_restore(&id)?;
    // 放回盘上的这份重新占一格：删除时已经还过名额，不补记就会少算，
    // 而回收站里的条目本来就是"我们存过盘的文件"的备份。
    if let Err(e) = quota::mark_saved(&back) {
        log::log("warn", "quota", &format!("回写保存配额失败: {}", e));
    }
    Ok(back)
}

#[tauri::command]
pub fn trash_purge(id: String) -> Result<bool, String> {
    backup::trash_purge(&id)
}

#[tauri::command]
pub fn trash_purge_older_than(days: i64) -> Result<usize, String> {
    backup::trash_purge_older_than(days)
}

// ---------- 密钥（AI API Key） ----------

#[tauri::command]
pub fn secret_store(name: String, value: String) -> Result<bool, String> {
    secret::put(&name, &value)?;
    // 只记条目名。日志是用户会直接发给别人的东西，密钥不行。
    log::log("info", "secret", &format!("已保存密钥条目 {name}"));
    Ok(true)
}

#[tauri::command]
pub fn secret_reveal(name: String) -> Result<Option<String>, String> {
    secret::get(&name)
}

#[tauri::command]
pub fn secret_drop(name: String) -> Result<bool, String> {
    secret::drop(&name)
}

#[tauri::command]
pub fn secret_exists(name: String) -> Result<bool, String> {
    Ok(secret::has(&name))
}

// ---------- 系统 ----------

/// 在资源管理器 / 访达里定位文件。用 std::process::Command 而不是 shell 插件，
/// 这样 capability 里可以完全不放开 shell 权限。
#[tauri::command]
pub fn reveal_in_folder(path: String) -> Result<(), String> {
    let p = paths::validate(&path, false)?;
    let target = p.to_string_lossy().to_string();
    let spawn_result = if cfg!(target_os = "windows") {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", target))
            .spawn()
    } else if cfg!(target_os = "macos") {
        std::process::Command::new("open")
            .args(["-R", &target])
            .spawn()
    } else {
        let parent = p
            .parent()
            .map(|x| x.to_string_lossy().to_string())
            .unwrap_or(target.clone());
        std::process::Command::new("xdg-open").arg(parent).spawn()
    };
    spawn_result.map_err(|e| format!("打开所在目录失败: {}", e))?;
    Ok(())
}

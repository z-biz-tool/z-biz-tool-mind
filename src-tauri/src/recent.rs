//! 最近打开列表（doc/复刻方案/00 §3.15：清空 / 刷新 / 固定 / 上限）。
//!
//! 存在配置目录下的 recent.json。这里只记路径与标题，不复制文档内容 ——
//! 文档本体的历史版本归 backup.rs，两条链路各管一件事，避免互相覆盖。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::config::{get_config_dir, read_json_file, write_private};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentItem {
    pub path: String,
    pub title: String,
    /// local / cloud / template，对应工作台列表的"来源"列。
    pub kind: String,
    pub opened_at: i64,
    #[serde(default)]
    pub pinned: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentStore {
    pub max_count: usize,
    pub items: Vec<RecentItem>,
}

impl Default for RecentStore {
    fn default() -> Self {
        RecentStore {
            max_count: 20,
            items: Vec::new(),
        }
    }
}

fn store_path() -> PathBuf {
    get_config_dir().join("recent.json")
}

fn load() -> RecentStore {
    let raw = read_json_file(&store_path(), Value::Object(serde_json::Map::new()));
    serde_json::from_value(raw).unwrap_or_default()
}

fn save(store: &RecentStore) -> Result<(), String> {
    let text =
        serde_json::to_string_pretty(store).map_err(|e| format!("序列化最近列表失败: {}", e))?;
    write_private(&store_path(), text.as_bytes())
}

fn now_ms() -> i64 {
    chrono::Local::now().timestamp_millis()
}

pub fn list() -> Vec<RecentItem> {
    let mut items = load().items;
    // 固定的排前面，其余按最近打开时间倒序（与工作台列表一致）。
    items.sort_by(|a, b| b.pinned.cmp(&a.pinned).then(b.opened_at.cmp(&a.opened_at)));
    items
}

pub fn touch(path: &str, title: &str, kind: &str) -> Result<Vec<RecentItem>, String> {
    let mut store = load();
    let mut item = RecentItem {
        path: path.to_string(),
        title: if title.is_empty() {
            path.to_string()
        } else {
            title.to_string()
        },
        kind: if kind.is_empty() {
            "local".to_string()
        } else {
            kind.to_string()
        },
        opened_at: now_ms(),
        pinned: false,
    };
    // 同一文件重复打开只刷新时间，不产生第二条记录；保留原有的固定状态。
    if let Some(pos) = store.items.iter().position(|x| x.path == item.path) {
        item.pinned = store.items[pos].pinned;
        store.items.remove(pos);
    }
    store.items.insert(0, item);
    if store.items.len() > store.max_count {
        // 先淘汰未固定的最旧项，固定的项不因数量上限被挤掉。
        store.items = trim(store.items, store.max_count);
    }
    save(&store)?;
    Ok(list())
}

/// 按容量裁剪：固定项优先保留，其余按插入顺序（新→旧）截断。
fn trim(items: Vec<RecentItem>, max: usize) -> Vec<RecentItem> {
    let (pinned, others): (Vec<RecentItem>, Vec<RecentItem>) =
        items.into_iter().partition(|i| i.pinned);
    let slots = max.saturating_sub(pinned.len());
    let kept_others = others.into_iter().take(slots).collect::<Vec<_>>();
    let mut out = pinned;
    out.extend(kept_others);
    out
}

pub fn remove(path: &str) -> Result<Vec<RecentItem>, String> {
    let mut store = load();
    store.items.retain(|x| x.path != path);
    save(&store)?;
    Ok(list())
}

pub fn clear() -> Result<(), String> {
    let store = RecentStore {
        max_count: load().max_count,
        items: Vec::new(),
    };
    save(&store)
}

pub fn set_pinned(path: &str, pinned: bool) -> Result<Vec<RecentItem>, String> {
    let mut store = load();
    for it in store.items.iter_mut() {
        if it.path == path {
            it.pinned = pinned;
        }
    }
    save(&store)?;
    Ok(list())
}

pub fn set_capacity(max: usize) -> Result<Vec<RecentItem>, String> {
    let mut store = load();
    store.max_count = max.clamp(1, 200);
    // 收紧容量时立刻按新上限裁剪，否则前端会把整份历史当成有效列表。
    store.items = trim(store.items, store.max_count);
    save(&store)?;
    Ok(list())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static GUARD: Mutex<()> = Mutex::new(());

    fn isolated(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("z-mind-recent-{}-{}", tag, uuid::Uuid::new_v4()));
        std::env::set_var("Z_MIND_CONFIG_DIR", &dir);
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn reopen_updates_time_without_duplicate() {
        let _g = GUARD.lock().unwrap();
        let dir = isolated("dedup");
        touch("/tmp/a.emmx", "A", "local").unwrap();
        touch("/tmp/a.emmx", "A 改名", "local").unwrap();
        let items = list();
        assert_eq!(items.len(), 1, "同一路径应只保留一条");
        assert_eq!(items[0].title, "A 改名");
        std::env::remove_var("Z_MIND_CONFIG_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn over_capacity_drops_unpinned_first() {
        let _g = GUARD.lock().unwrap();
        let dir = isolated("cap");
        set_capacity(2).unwrap();
        touch("/tmp/x1.emmx", "1", "local").unwrap();
        touch("/tmp/x2.emmx", "2", "local").unwrap();
        set_pinned("/tmp/x1.emmx", true).unwrap();
        touch("/tmp/x3.emmx", "3", "local").unwrap();
        let items = list();
        assert!(
            items.iter().any(|i| i.path == "/tmp/x1.emmx"),
            "固定项不应被淘汰"
        );
        assert_eq!(items.len(), 2, "总量不应超过上限");
        std::env::remove_var("Z_MIND_CONFIG_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn clear_removes_list_not_files() {
        let _g = GUARD.lock().unwrap();
        let dir = isolated("clear");
        let file = std::env::temp_dir().join(format!("z-mind-keep-{}.emmx", uuid::Uuid::new_v4()));
        std::fs::write(&file, b"zip-placeholder").unwrap();
        touch(file.to_str().unwrap(), "K", "local").unwrap();
        clear().unwrap();
        assert!(list().is_empty());
        assert!(file.exists(), "清空列表不能删掉磁盘上的文档");
        std::fs::remove_file(&file).ok();
        std::env::remove_var("Z_MIND_CONFIG_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

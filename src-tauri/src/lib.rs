mod backup;
mod commands;
mod config;
mod paths;
mod recent;
mod secret;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::config_get,
            commands::config_set,
            commands::config_reset_page,
            commands::recent_list,
            commands::recent_touch,
            commands::recent_remove,
            commands::recent_clear,
            commands::recent_set_capacity,
            commands::file_read_bytes,
            commands::file_write_bytes,
            commands::file_exists,
            commands::file_size,
            commands::file_remove,
            commands::path_validate,
            commands::path_prepare_write,
            commands::path_temp_dir,
            commands::path_config_dir,
            commands::autosave_write,
            commands::autosave_list,
            commands::autosave_clear,
            commands::backup_now,
            commands::backup_list,
            commands::backup_restore,
            commands::backup_delete,
            commands::backup_purge,
            commands::trash_list,
            commands::trash_restore,
            commands::trash_purge,
            commands::trash_purge_older_than,
            commands::secret_store,
            commands::secret_reveal,
            commands::secret_drop,
            commands::secret_exists,
            commands::reveal_in_folder,
            commands::history_list,
        ])
        .setup(|_| {
            // 启动即保证配置目录存在：后续所有读写都假设它可用。
            let dir = config::get_config_dir();
            std::fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {}", e))?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("z-biz-tool-mind 启动失败");
}

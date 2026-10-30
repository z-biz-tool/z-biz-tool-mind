mod ai;
mod backup;
mod commands;
mod config;
mod crash;
mod log;
mod net;
mod openfile;
mod paths;
mod quota;
mod recent;
mod secret;

/// 测试用的进程级串行锁。
///
/// 配置目录靠环境变量 `Z_MIND_CONFIG_DIR` 指定，而环境变量是整个测试进程共享的。
/// 每个模块各留一把自己的 GUARD 只能保证模块内不打架：五个模块并行时，
/// 一个测试刚 set_var 指到自己的临时目录，另一个就把它改走了，
/// 于是一批测试报 "找不到路径"，报的还都是不相干的错。
#[cfg(test)]
static CONFIG_ENV_GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());

// 本线程当前是否正持有配置目录锁。
//
// **写日志的路径也读同一个环境变量**（日志目录 = 配置目录下的 logs/），
// 所以「谁没拿锁就写日志，日志就落进当时正指向别人沙盒的目录」——
// 别人的测试于是读到多出来的行、字节数对不上，
// 而报出来的错跟真正的原因隔着十万八千里。
//
// 2026-10-21 实测：`net::sanitize()` 会写一条 debug 日志，
// 而调用它的 net.rs 测试没拿锁 ⇒ 它把日志写进了 log.rs 测试的隔离目录。
// 后果不是那条 net 用例挂，是 **log 与 paths 两类用例各以约 12% 的概率随机挂**
// （200 轮实测：log 25 次、paths 21 次），报的还是「字节数对不上」「找不到路径」这种
// 毫不相干的错。这个仓的 CI 又不在主干 push 上跑，于是它躲了 13 天没人看见。
//
// 有了这个标记，`log::log()` 就能在**写之前**断言「你拿锁了吗」，
// 把随机 flaky 变成当场、当地、可指认的失败。
//（这里用 // 而不是 ///：doc 注释挂在 thread_local! 宏调用上是「unused doc comment」。）
#[cfg(test)]
thread_local! {
    static CONFIG_ENV_LOCK_HELD: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// 持有配置目录锁的守卫。Drop 时清掉「本线程持锁」标记。
#[cfg(test)]
pub(crate) struct ConfigEnvGuard {
    // 字段只为了持有 MutexGuard 的生命周期（Drop 时解锁 + 清标记），本身不需要读。
    _guard: std::sync::MutexGuard<'static, ()>,
}

#[cfg(test)]
impl Drop for ConfigEnvGuard {
    fn drop(&mut self) {
        CONFIG_ENV_LOCK_HELD.with(|c| c.set(false));
    }
}

/// 本线程是否正持有配置目录锁（写日志前要问一句）。
#[cfg(test)]
pub(crate) fn config_env_lock_held() -> bool {
    CONFIG_ENV_LOCK_HELD.with(|c| c.get())
}

/// 测试用的隔离配置目录：把 `Z_MIND_CONFIG_DIR` 指到一个唯一临时目录并返回它。
///
/// **必须**在已经持有 `lock_config_env()` 的前提下调用 —— 环境变量是**进程级**的，
/// 不拿锁就改它，等于把别人正在用的沙盒换掉。
#[cfg(test)]
fn isolated_config_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "z-mind-{}-{}-{}",
        tag,
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::env::set_var("Z_MIND_CONFIG_DIR", &dir);
    dir
}

/// 拿锁 + 指向一个唯一临时配置目录，返回（守卫，目录）。
///
/// 顺序是**先拿锁、再改环境变量** —— 反过来的话，可能在别的测试正用着这个环境变量时
/// 把它的沙盒换掉，于是那个测试的写盘落进我们的目录、或我们的落进它的。
/// 2026-10-21 实测这类交错会让用例以约 12% 的概率随机失败。
#[cfg(test)]
pub(crate) fn isolated_sandbox(tag: &str) -> (ConfigEnvGuard, std::path::PathBuf) {
    let g = lock_config_env();
    let dir = isolated_config_dir(tag);
    (g, dir)
}

#[cfg(test)]
fn lock_config_env() -> ConfigEnvGuard {
    // 某个测试 panic 会把锁毒化，后面每个测试都只能拿到 PoisonError ——
    // 那是第二条与真实缺陷无关的失败。锁里只有 ()，不携带需要保持一致的状态，恢复即可。
    let g = CONFIG_ENV_GUARD.lock().unwrap_or_else(|e| e.into_inner());
    CONFIG_ENV_LOCK_HELD.with(|c| c.set(true));
    ConfigEnvGuard { _guard: g }
}

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 这几件事必须在 Builder 之前：日志级别决定第一行记录写不写得出，
    // 代理参数只在 WebView2 核心创建那一刻读一次 —— 建好窗口再设就晚了，
    // panic hook 则要赶在第一批命令被调用前装上，不然头一次崩溃就没有记录。
    let cfg = config::read_config();
    let level = log::configure_from(&cfg);
    log::log("info", "config", &format!("日志级别 = {level}"));
    match net::install(&cfg) {
        Ok(st) => log::log("info", "net", &st.message),
        // 用户手改过的 config.json 里可能有非法代理地址：拦不住的话就退回跟随系统，
        // 并把这件事写进日志，而不是让整个应用起不来。
        Err(e) => log::log(
            "error",
            "net",
            &format!("代理设置无法应用，已按跟随系统启动: {e}"),
        ),
    }
    // 崩溃记录要在任何可能 panic 的代码之前就位：开关读配置，hook 只装一次。
    let crash_on = crash::configure_from(&cfg);
    crash::install_panic_hook();
    log::log(
        "debug",
        "config",
        &format!("崩溃记录 = {}", if crash_on { "开" } else { "关" }),
    );
    log::prune();

    let app = tauri::Builder::default()
        // 单实例（2026-10-26 分发底座）：第二次启动聚焦已有窗口，不再开新进程。
        // 必须作为第一个注册的插件（tauri-plugin-single-instance 官方要求）。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        // 自动更新：前端 UpdaterGate 延时 check()，endpoint/pubkey 见 tauri.conf.json
        .plugin(tauri_plugin_updater::Builder::new().build())
        // 更新安装完成后的「立即重启」
        .plugin(tauri_plugin_process::init())
        .manage(openfile::Pending::default())
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::config_get,
            commands::config_set,
            commands::config_reset_page,
            commands::recent_list,
            commands::recent_touch,
            commands::quota_mark_saved,
            commands::quota_saved_list,
            commands::recent_remove,
            commands::recent_clear,
            commands::recent_set_capacity,
            commands::recent_set_pinned,
            commands::file_read_bytes,
            commands::file_write_bytes,
            commands::file_exists,
            commands::file_size,
            commands::file_remove,
            commands::autosave_write,
            commands::autosave_list,
            commands::autosave_clear,
            commands::autosave_drop,
            commands::backup_now,
            commands::backup_list,
            commands::backup_restore,
            commands::backup_delete,
            commands::backup_purge,
            commands::trash_list,
            commands::trash_restore,
            commands::trash_purge,
            commands::trash_purge_older_than,
            // 密钥命令：secret_reveal 已整体删除（2026-10-26）——
            // 明文密钥不再回传前端界面，AI 请求由后端自取（见 ai.rs）
            commands::secret_store,
            commands::secret_drop,
            commands::secret_exists,
            // AI 生成收口到 Rust（cap-llm）：key 从本机加密库自取，不再回传前端界面
            ai::ai_generate_outline,
            commands::reveal_in_folder,
            commands::history_list,
            openfile::open_take_pending,
            log::log_write,
            log::log_set_level,
            log::log_info,
            log::log_open_dir,
            net::proxy_status,
            crash::crash_report,
            crash::crash_info,
            crash::crash_open_dir,
        ])
        .setup(|app| {
            // 启动即保证配置目录存在：后续所有读写都假设它可用。
            let dir = config::get_config_dir();
            std::fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {}", e))?;
            let info = app.package_info();
            log::log(
                "info",
                "app",
                &format!(
                    "{} v{} 已启动（{}/{}），配置目录 {}",
                    info.name,
                    info.version,
                    std::env::consts::OS,
                    std::env::consts::ARCH,
                    dir.display()
                ),
            );
            // Windows / Linux 双击 .emmx：路径就在命令行里，趁前端开始渲染之前收进队列。
            openfile::seed_from_args(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("z-biz-tool-mind 启动失败");

    app.run(|app_handle, event| {
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        {
            // macOS 上第二次双击不发新进程，只投这一条事件；转成本地路径后进同一条队列。
            // 这个变体在 Windows/ Linux 上根本不存在，所以判据也只能在那两个平台上编进去。
            if let tauri::RunEvent::Opened { urls } = event {
                openfile::push(
                    app_handle,
                    urls.iter()
                        .filter_map(|u| u.to_file_path().ok())
                        .map(|p| p.to_string_lossy().to_string()),
                );
            }
        }
        #[cfg(not(any(target_os = "macos", target_os = "ios")))]
        {
            let _ = (app_handle, event);
        }
    });
}

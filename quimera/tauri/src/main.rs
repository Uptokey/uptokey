//! Entrada principal da aplicação Tauri (v2).
//! Configura a janela via `tauri.conf.json`, inicializa o supervisor do
//! sidecar e registra os comandos da ponte tipada.

#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

// Reuse the accepted native adapters at compile time; no checkout is needed at runtime.
#[cfg(windows)]
extern crate windows_sys_harness as windows_sys;
use uptokey_tauri_lib::harness_layout;
#[cfg(test)]
mod harness_build_config;
mod harness_window;
mod native_build_identity;
use harness_window::local_origin;
#[path = "../../../experiments/deepseek-workbench/desktop/src/account_bridge.rs"]
mod account_bridge;
#[path = "../../../experiments/deepseek-workbench/desktop/src/account_urls.rs"]
mod account_urls;
#[path = "../../../experiments/deepseek-workbench/desktop/src/approved_context.rs"]
mod approved_context;
#[path = "../../../experiments/deepseek-workbench/desktop/src/browser.rs"]
mod browser;
#[path = "../../../experiments/deepseek-workbench/desktop/src/computer_use.rs"]
mod computer_use;
#[path = "../../../experiments/deepseek-workbench/desktop/src/diagnostics.rs"]
mod diagnostics;
#[path = "../../../experiments/deepseek-workbench/desktop/src/export_save.rs"]
mod export_save;
#[path = "../../../experiments/deepseek-workbench/desktop/src/folder_snapshot.rs"]
mod folder_snapshot;
#[cfg(target_os = "linux")]
#[path = "../../../experiments/deepseek-workbench/desktop/src/linux_tray.rs"]
mod linux_tray;
#[path = "../../../experiments/deepseek-workbench/desktop/src/local_connections.rs"]
mod local_connections;
#[path = "../../../experiments/deepseek-workbench/desktop/src/notification_bridge.rs"]
mod notification_bridge;
#[path = "../../../experiments/deepseek-workbench/desktop/src/product_contract.rs"]
mod product_contract;
#[path = "../../../experiments/deepseek-workbench/desktop/src/public_api.rs"]
mod public_api;
#[path = "../../../experiments/deepseek-workbench/desktop/src/theme_bridge.rs"]
mod theme_bridge;

use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_single_instance::init as single_instance_init;

use uptokey_tauri_lib::config;
use uptokey_tauri_lib::sidecar::resolve_sidecar_dir;
use uptokey_tauri_lib::supervisor::{self, start_supervisor, ProxyStateView};

/// Diretório de recursos do bundle (onde `prepare-sidecar` deposita o sidecar).
fn resource_dir(app: &AppHandle) -> std::path::PathBuf {
    app.path()
        .resource_dir()
        .expect("resource_dir should be available")
}

/// Harness owns its sole window through harness_window::mount. Never allow
/// declarative windows inherited from merged build configuration to appear.
/// The shell retains its existing isolated-window recreation behavior.
fn initial_window_policy(
    windows: &mut [tauri::utils::config::WindowConfig],
    harness: bool,
    isolated_profile: bool,
) -> Vec<tauri::utils::config::WindowConfig> {
    let shell_windows = if !harness && isolated_profile {
        windows.to_vec()
    } else {
        Vec::new()
    };
    if harness || isolated_profile {
        for window in windows {
            window.create = false;
        }
    }
    shell_windows
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Some(identity) = native_build_identity::dispatch(&args) {
        match identity {
            Ok(json) => println!("{json}"),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(2);
            }
        }
        return;
    }
    let harness = cfg!(feature = "harness-entry")
        || args
            .iter()
            .any(|arg| matches!(arg.as_str(), "--harness" | "--harness-recovery"));
    // This read-only command exits before profile, resources, windows or core.
    if args
        .iter()
        .any(|arg| matches!(arg.as_str(), "--help" | "-h"))
    {
        println!("Uptokey {}\nDefault interface: {}\n--harness           Open Harness\n--harness-recovery  Open recovery without starting core\n--help              Show this help without starting the application",
            env!("CARGO_PKG_VERSION"), if cfg!(feature = "harness-entry") { "Harness" } else { "shell" });
        return;
    }
    // Cria o app Tauri.
    let profile =
        config::OperationalProfile::from_env().expect("native operational profile invalid");
    let recovery_only = args.iter().any(|arg| arg == "--harness-recovery");
    // A Harness-only release must not compile the legacy PWA's asset macro.
    // Keep the optional --harness entry available to explicit shell builds.
    #[cfg(feature = "harness-entry")]
    let mut context = tauri::generate_context!("tauri.harness.conf.json");
    #[cfg(not(feature = "harness-entry"))]
    let mut context = if harness {
        tauri::generate_context!("tauri.harness.conf.json")
    } else {
        tauri::generate_context!()
    };
    let isolated_windows = initial_window_policy(
        &mut context.config_mut().app.windows,
        harness,
        profile.data_dir.is_some(),
    );

    let harness_handler: Box<dyn Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync> =
        Box::new(tauri::generate_handler![
            account_bridge::harness_account_request,
            account_bridge::harness_open_account_login,
            account_bridge::harness_complete_account_login,
            account_bridge::harness_open_account_page,
            account_bridge::harness_refresh_provider_models,
            local_connections::harness_local_connections,
            computer_use::harness_computer_approve_focus,
            theme_bridge::harness_theme_sync,
            theme_bridge::harness_theme_state,
            public_api::harness_public_api_queued,
            notification_bridge::harness_notification_show
        ]);
    let shell_handler: Box<dyn Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync> =
        Box::new(tauri::generate_handler![
            uptokey_tauri_lib::bridge::proxy_address,
            uptokey_tauri_lib::bridge::proxy_start,
            uptokey_tauri_lib::bridge::proxy_stop,
            uptokey_tauri_lib::bridge::proxy_restart,
            uptokey_tauri_lib::bridge::proxy_status,
            uptokey_tauri_lib::bridge::proxy_health,
            uptokey_tauri_lib::bridge::get_system_theme,
            uptokey_tauri_lib::bridge::get_preferred_theme,
            uptokey_tauri_lib::bridge::set_preferred_theme,
            uptokey_tauri_lib::bridge::resolve_theme,
            uptokey_tauri_lib::bridge::notification_show,
            uptokey_tauri_lib::bridge::diagnostics_export,
            uptokey_tauri_lib::bridge::pick_folder,
            uptokey_tauri_lib::bridge::list_workspace_contexts,
            uptokey_tauri_lib::bridge::approve_workspace_context,
            uptokey_tauri_lib::bridge::open_account_login,
            uptokey_tauri_lib::bridge::open_subscription_url,
            uptokey_tauri_lib::bridge::open_model_page,
            uptokey_tauri_lib::bridge::open_provider_portal,
        ]);

    let app = tauri::Builder::default()
        .plugin(single_instance_init(|app, _args, _cwd| {
            // Se já existe janela, traz ao foco.
            if let Some(window) = app
                .get_webview_window("workbench")
                .or_else(|| app.get_webview_window("main"))
            {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(|window, event| {
            if window.label() == "workbench"
                && matches!(
                    event,
                    tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
                )
            {
                if let Some(state) = window.app_handle().try_state::<computer_use::NativeState>() {
                    state.shutdown(false);
                }
            }
            #[cfg(target_os = "linux")]
            if window.label() == "workbench" {
                linux_tray::handle_window_event(window, event);
            }
        })
        .setup(move |app| {
            app.manage(profile.clone());
            let harness_exporter = if harness {
                let app_data = app.path().app_data_dir()?;
                let layout = uptokey_tauri_lib::harness_host::admit_installed(
                    &resource_dir(app.handle()),
                    &app_data,
                    &profile,
                )
                .map_err(|_| "harness-resources-unavailable")?;
                let webview_profile = layout.state_root().join(".local/desktop-profile");
                harness_layout::provision_state_directory(&webview_profile)?;
                layout.validate_profile(&webview_profile)?;
                let exporter = diagnostics::Exporter::from_layout(layout)?;
                harness_window::mount(
                    app,
                    Some(exporter.clone()),
                    webview_profile,
                    false,
                    url::Url::parse(harness_window::recovery_url())?,
                )?;
                Some(exporter)
            } else {
                None
            };
            // Recovery opens only the existing local UI; it cannot start core or engine.
            if recovery_only {
                return Ok(());
            }
            // Inicia o único supervisor do sidecar após a admissão local.
            let sidecar_dir = resolve_sidecar_dir(&resource_dir(app.handle()));

            // Gerar token de IPC
            use rand::RngCore;
            let mut key = [0u8; 32];
            rand::thread_rng().fill_bytes(&mut key);
            let ipc_secret = uptokey_tauri_lib::sidecar::to_hex(&key);

            let supervisor_handle = start_supervisor(sidecar_dir, ipc_secret, {
                let app_handle = app.handle().clone();
                let harness_exporter = harness_exporter.clone();
                let workspace_started = std::sync::atomic::AtomicBool::new(false);
                Arc::new(move |state: &ProxyStateView| {
                    // Emitindo evento para a WebView.
                    let _ = app_handle.emit("proxy-state", state);
                    // Readiness comes from the existing supervisor, without a
                    // second health probe, startup race or retry loop.
                    if matches!(state, ProxyStateView::Ready { .. })
                        && !workspace_started.swap(true, std::sync::atomic::Ordering::SeqCst)
                    {
                        if let Some(exporter) = &harness_exporter {
                            harness_window::start_runtime(app_handle.clone(), exporter.clone());
                        }
                    }
                })
            });
            // Armazena handle para uso posterior nos comandos.
            app.manage(supervisor_handle);
            if harness_exporter.is_some() {
                return Ok(());
            }
            // Configuração inicial (migrar se necessário).
            let config_dir = app
                .handle()
                .path()
                .app_data_dir()
                .expect("app_dir unavailable");
            let config_dir = profile.storage_dir(config_dir, "shell");
            let _ = config::load_or_migrate(&config_dir);
            for window in &isolated_windows {
                let directory = profile
                    .storage_dir(std::path::PathBuf::new(), "webview")
                    .join(&window.label);
                let builder = tauri::WebviewWindowBuilder::from_config(app, window)?
                    .data_directory(directory.clone());
                #[cfg(any(target_os = "macos", target_os = "ios"))]
                let builder = {
                    use sha2::{Digest, Sha256};
                    let digest = Sha256::digest(directory.to_string_lossy().as_bytes());
                    let mut identifier = [0u8; 16];
                    identifier.copy_from_slice(&digest[..16]);
                    builder.data_store_identifier(identifier)
                };
                builder.build()?;
            }
            Ok(())
        })
        .invoke_handler(move |invoke| {
            // Dispatch is split even before ACL resolution: a remote Harness
            // window never reaches canonical administrative commands.
            if invoke.message.webview().label() == "workbench" {
                harness_handler(invoke)
            } else if invoke.message.webview().label() == "main" {
                shell_handler(invoke)
            } else {
                invoke.resolver.reject("window_denied");
                true
            }
        })
        .build(context)
        .expect("error while building tauri");
    app.run(|app_handle, event| {
        if let tauri::RunEvent::ExitRequested { .. } = event {
            if let Some(state) = app_handle.try_state::<computer_use::NativeState>() {
                state.shutdown(true);
            }
            if let Some(state) = app_handle.try_state::<supervisor::SupervisorHandle>() {
                state.request_shutdown();
            }
        }
    });
}

#[cfg(test)]
mod initial_window_policy_tests {
    use super::initial_window_policy;
    use tauri::utils::config::WindowConfig;

    fn declarations() -> Vec<WindowConfig> {
        vec![
            WindowConfig {
                label: "main".into(),
                create: true,
                ..Default::default()
            },
            WindowConfig {
                label: "legacy-secondary".into(),
                create: true,
                ..Default::default()
            },
        ]
    }

    #[test]
    fn harness_without_core_profile_never_autocreates_inherited_windows() {
        let mut windows = declarations();
        assert!(initial_window_policy(&mut windows, true, false).is_empty());
        assert!(windows.iter().all(|window| !window.create));
        assert_eq!(windows[0].label, "main");
    }

    #[test]
    fn harness_with_core_profile_never_recreates_shell_windows() {
        let mut windows = declarations();
        assert!(initial_window_policy(&mut windows, true, true).is_empty());
        assert!(windows.iter().all(|window| !window.create));
    }

    #[test]
    fn shell_preserves_default_and_isolated_declarative_behavior() {
        let mut normal = declarations();
        assert!(initial_window_policy(&mut normal, false, false).is_empty());
        assert!(normal.iter().all(|window| window.create));
        let mut isolated = declarations();
        let recreate = initial_window_policy(&mut isolated, false, true);
        assert_eq!(
            recreate
                .iter()
                .map(|window| window.label.as_str())
                .collect::<Vec<_>>(),
            ["main", "legacy-secondary"]
        );
        assert!(recreate.iter().all(|window| window.create));
        assert!(isolated.iter().all(|window| !window.create));
    }
}

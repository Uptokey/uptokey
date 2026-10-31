#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod account_bridge;
mod account_status;
mod account_urls;
mod approved_context;
mod browser;
mod computer_use;
mod export_save;
mod folder_snapshot;
mod local_connections;
#[cfg(target_os = "linux")]
mod linux_tray;
mod notification_bridge;
mod platform_context;
mod public_api;
mod theme_bridge;
use serde::Deserialize;
use std::{
    io::{self, Read},
    path::PathBuf,
};
use tauri::Manager;
use url::Url;
#[path = "../../../../quimera/tauri/src/harness_window.rs"]
mod harness_window;
use harness_window::*;
mod diagnostics;
#[path = "../../../../quimera/tauri/src/harness_layout.rs"]
mod harness_layout;
mod product_contract;

pub(crate) fn initial_url(raw: &str, recovery: bool) -> Result<Url, &'static str> {
    if recovery {
        if !raw.is_empty() {
            return Err("recovery-bootstrap-invalid");
        };
        Url::parse(recovery_url()).map_err(|_| "recovery-url-invalid")
    } else {
        startup_url(raw)
    }
}

pub(crate) fn account_url_allowed(raw: &str) -> bool {
    let Ok(url) = Url::parse(raw) else {
        return false;
    };
    let pairs: Vec<_> = url.query_pairs().collect();
    external_url_allowed(&url)
        && url.origin().ascii_serialization() == "https://app.uptokey.com"
        && url.path() == "/api/account/native/authorize"
        && url.fragment().is_none()
        && pairs.len() == 1
        && pairs[0].0 == "id"
        && pairs[0].1.len() == 36
        && pairs[0].1.bytes().enumerate().all(|(i, b)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}

pub(crate) fn open_account_url(
    url: &str,
    _exporter: &diagnostics::Exporter,
) -> Result<(), &'static str> {
    if !account_url_allowed(url) {
        return Err("account-login-url-invalid");
    }
    browser::open(&Url::parse(url).map_err(|_| "account-login-url-invalid")?).map_err(|code| {
        if std::env::var("UPTOKEY_BROWSER_DIAGNOSTICS").as_deref() == Ok("1") {
            eprintln!("{code}");
        }
        "account-browser-unavailable"
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Bootstrap {
    url: String,
    profile: PathBuf,
    #[serde(default)]
    inspect: bool,
    #[serde(default)]
    recovery: bool,
    #[serde(default)]
    node_executable: Option<PathBuf>,
    #[serde(default)]
    resource_layout: Option<ResourceLayoutBootstrap>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ResourceLayoutBootstrap {
    resource_lab: PathBuf,
    state_root: PathBuf,
    protected_source_root: PathBuf,
}

fn bootstrap_exporter(
    bootstrap: &Bootstrap,
    explicit_resource_layout: bool,
) -> Result<Option<diagnostics::Exporter>, &'static str> {
    if let Some(layout) = &bootstrap.resource_layout {
        // Explicit development/acceptance transport only. The installed native
        // entry must derive these paths and attest its sidecar itself.
        if !explicit_resource_layout {
            return Err("resource-layout-explicit-mode-required");
        }
        let node = bootstrap
            .node_executable
            .as_deref()
            .ok_or("resource-layout-node-required")?;
        let layout = harness_layout::HarnessLayout::installed(
            &layout.resource_lab,
            &layout.state_root,
            &layout.protected_source_root,
            node,
        )?;
        layout.validate_profile(&bootstrap.profile)?;
        return diagnostics::Exporter::from_layout(layout).map(Some);
    }
    if explicit_resource_layout {
        return Err("resource-layout-required");
    }
    bootstrap
        .node_executable
        .as_deref()
        .map(|node| diagnostics::Exporter::new(&bootstrap.profile, node))
        .transpose()
}

fn main() {
    if let Err(code) = run() {
        // Bootstrap contains a transient credential. Never format its value or
        // propagate parser/window errors that could embed the URL.
        eprintln!("Uptokey Harness Lab: {code}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), &'static str> {
    let mut raw = Vec::new();
    io::stdin()
        .take(8193)
        .read_to_end(&mut raw)
        .map_err(|_| "bootstrap-read-failed")?;
    if raw.len() > 8192 {
        return Err("bootstrap-too-large");
    }
    let bootstrap: Bootstrap = serde_json::from_slice(&raw).map_err(|_| "bootstrap-invalid")?;
    raw.fill(0);
    let exporter = bootstrap_exporter(
        &bootstrap,
        std::env::args().any(|arg| arg == "--resource-layout"),
    )?;
    if std::env::args().nth(1).as_deref() == Some("--product-contract-check") {
        let receipt = exporter
            .ok_or("product-contract-unavailable")?
            .product_contract()?;
        println!(
            "{}",
            serde_json::to_string(&receipt).map_err(|_| "product-contract-invalid")?
        );
        return Ok(());
    }
    if std::env::args().nth(1).as_deref() == Some("--export-diagnostics") {
        let path = exporter.ok_or("diagnostics-unavailable")?.export()?;
        println!("{}", serde_json::json!({"exported":true,"path":path}));
        return Ok(());
    }
    if std::env::args().nth(1).as_deref() == Some("--import-workspace") {
        let path = std::env::args_os()
            .nth(2)
            .ok_or("workspace-path-required")?;
        let path = std::path::Path::new(&path);
        let exporter = exporter.ok_or("workspace-import-unavailable")?;
        let project = match diagnostics::workspace_archive_format(path)? {
            diagnostics::WorkspaceArchiveFormat::Encrypted => {
                exporter.import_workspace_encrypted(path)?
            }
            diagnostics::WorkspaceArchiveFormat::Zip => exporter.import_workspace(path)?,
        };
        println!("{}", serde_json::json!({"imported":true,"project":project}));
        return Ok(());
    }
    if std::env::args().nth(1).as_deref() == Some("--import-folder") {
        let path = std::env::args_os().nth(2).ok_or("folder-path-required")?;
        let receipt = exporter
            .ok_or("workspace-import-unavailable")?
            .import_folder(std::path::Path::new(&path))?;
        println!(
            "{}",
            serde_json::to_string(&receipt).map_err(|_| "folder-receipt-invalid")?
        );
        return Ok(());
    }
    if std::env::args().nth(1).as_deref() == Some("--import-public-api") {
        let path = std::env::args_os().nth(2).ok_or("api-path-required")?;
        let receipt = exporter
            .ok_or("api-import-unavailable")?
            .import_public_api(std::path::Path::new(&path))?;
        println!(
            "{}",
            serde_json::json!({"registered":true,"apiId":receipt.api_id,"schemaSha256":receipt.schema_sha256,"operations":receipt.operations})
        );
        return Ok(());
    }
    if std::env::args().nth(1).as_deref() == Some("--export-workspace") {
        let path = exporter
            .ok_or("workspace-export-unavailable")?
            .export_workspace()?;
        println!("{}", serde_json::json!({"exported":true,"path":path}));
        return Ok(());
    }
    if std::env::args().nth(1).as_deref() == Some("--reconnect-local") {
        let connected = exporter.ok_or("reconnect-unavailable")?.reconnect_services()?.reconnected();
        println!("{}", serde_json::json!({"reconnected":connected}));
        return Ok(());
    }
    if std::env::args().nth(1).as_deref() == Some("--browser-context-check") {
        let context = platform_context::current()?;
        #[cfg(windows)]
        println!(
            "{}",
            serde_json::json!({"platform":context.platform,"integrity":context.identity})
        );
        #[cfg(unix)]
        println!(
            "{}",
            serde_json::json!({"platform":context.platform,"uid":context.identity,"elevated":context.elevated})
        );
        #[cfg(not(any(windows, unix)))]
        let _ = context;
        return Ok(());
    }
    if std::env::args().nth(1).as_deref() == Some("--open-account-check") {
        let exporter = exporter.ok_or("account-unavailable")?;
        let challenge = exporter.account(true)?;
        if challenge.get("authenticated").and_then(|v| v.as_bool()) == Some(true) {
            println!("{}", serde_json::json!({"authenticated":true}));
            return Ok(());
        }
        let url = challenge
            .get("loginUrl")
            .and_then(|v| v.as_str())
            .ok_or("account-login-unavailable")?;
        if !account_url_allowed(url) {
            return Err("account-login-url-invalid");
        }
        open_account_url(url, &exporter)?;
        println!("{}", serde_json::json!({"shellAccepted":true}));
        return Ok(());
    }
    if std::env::args().nth(1).as_deref() == Some("--account-status") {
        let exporter = exporter.ok_or("account-unavailable")?;
        let status =
            account_status::read_status(|path, input| exporter.account_request(path, input))?;
        println!("{}", status);
        return Ok(());
    }
    if std::env::args().nth(1).as_deref() == Some("--restart-runtime-check") {
        let receipt = exporter.ok_or("restart-unavailable")?.restart_runtime()?;
        startup_url(
            receipt
                .get("url")
                .and_then(|v| v.as_str())
                .ok_or("restart-url-missing")?,
        )?;
        println!(
            "{}",
            serde_json::json!({"restarted":true,"authenticatedStartupValidated":true,"tokenExported":false})
        );
        return Ok(());
    }
    if std::env::args().nth(1).as_deref() == Some("--runtime-cycle-check") {
        let control = exporter.ok_or("runtime-unavailable")?;
        control.runtime_state(false)?;
        let receipt = control.runtime_state(true)?;
        startup_url(
            receipt
                .get("url")
                .and_then(|v| v.as_str())
                .ok_or("startup-url-missing")?,
        )?;
        println!(
            "{}",
            serde_json::json!({"stopped":true,"started":true,"authenticatedStartupValidated":true,"tokenExported":false})
        );
        return Ok(());
    }
    let initial = initial_url(&bootstrap.url, bootstrap.recovery)?;
    // Recovery must remain available while the engine/core is unavailable.
    // A normal workspace, however, is admitted only when the Rust host can
    // prove the complete canonical product contract against the live runtime.
    if !bootstrap.recovery {
        exporter
            .as_ref()
            .ok_or("product-contract-unavailable")?
            .product_contract()?;
    }
    if !bootstrap.profile.is_absolute() || !bootstrap.profile.is_dir() {
        return Err("profile-unavailable");
    }
    let builder = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
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
        ])
        .plugin(tauri_plugin_dialog::init());
    #[cfg(not(target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_notification::init());
    let application = builder
        .on_window_event(|window, event| {
            if window.label() == "workbench"
                && matches!(
                    event,
                    tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
                )
            {
                window
                    .app_handle()
                    .state::<computer_use::NativeState>()
                    .shutdown(false);
            }
            #[cfg(target_os = "linux")]
            linux_tray::handle_window_event(window, event);
            #[cfg(not(target_os = "linux"))]
            let _ = (window, event);
        })
        .setup(move |app| {
            harness_window::mount(app, exporter, bootstrap.profile, bootstrap.inspect, initial)
        })
        .build(tauri::generate_context!())
        .map_err(|_| "desktop-runtime-failed")?;
    application.run(|app, event| {
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            app.state::<computer_use::NativeState>().shutdown(true);
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn running_workspace_preserves_draft_only_for_redundant_start() {
        let live = url::Url::parse("http://127.0.0.1:43180/").unwrap();
        let receipt = serde_json::json!({"alreadyRunning":true});
        assert!(super::preserve_running_workspace(
            "start-runtime",
            &receipt,
            &live
        ));
        for action in ["stop-runtime", "restart-runtime"] {
            assert!(!super::preserve_running_workspace(action, &receipt, &live));
        }
        for value in [
            serde_json::json!({}),
            serde_json::json!({"alreadyRunning":false}),
            serde_json::json!({"alreadyRunning":"true"}),
        ] {
            assert!(!super::preserve_running_workspace(
                "start-runtime",
                &value,
                &live
            ));
        }
    }
    #[test]
    fn running_workspace_recovery_and_authentication_still_navigate() {
        let receipt = serde_json::json!({"alreadyRunning":true});
        for raw in [
            super::stopped_url(),
            super::recovery_url(),
            "about:blank",
            "http://127.0.0.1:43180/?token=synthetic-token-only",
            "https://example.com/",
            "http://127.0.0.1:43180/other",
        ] {
            assert!(!super::preserve_running_workspace(
                "start-runtime",
                &receipt,
                &url::Url::parse(raw).unwrap()
            ));
        }
    }
    #[test]
    fn recovery_bootstrap_accepts_only_empty_url_and_bundled_asset() {
        assert_eq!(
            super::initial_url("", true).unwrap().as_str(),
            super::recovery_url()
        );
        assert!(super::initial_url("https://evil.test", true).is_err());
        assert!(super::initial_url(super::recovery_url(), false).is_err());
    }
    #[test]
    fn stopped_page_is_the_only_added_asset_navigation() {
        assert!(super::navigation_allowed(
            &url::Url::parse(super::stopped_url()).unwrap()
        ));
        assert!(!super::navigation_allowed(
            &url::Url::parse(&format!("{}?other=1", super::stopped_url())).unwrap()
        ));
        assert!(!super::navigation_allowed(
            &url::Url::parse(&super::stopped_url().replace("stopped.html", "other.html")).unwrap()
        ));
    }
    use super::*;
    const TOKEN: &str = "synthetic-native-bootstrap-token";
    #[test]
    fn installed_layout_bootstrap_requires_explicit_mode_and_complete_layout() {
        let mut bootstrap: Bootstrap = serde_json::from_value(
            serde_json::json!({"url":"","profile":"unused-profile","recovery":true}),
        )
        .unwrap();
        assert_eq!(
            bootstrap_exporter(&bootstrap, true).err(),
            Some("resource-layout-required")
        );
        bootstrap.resource_layout = Some(ResourceLayoutBootstrap {
            resource_lab: PathBuf::from("unused-resources"),
            state_root: PathBuf::from("unused-state"),
            protected_source_root: PathBuf::from("unused-package"),
        });
        assert_eq!(
            bootstrap_exporter(&bootstrap, false).err(),
            Some("resource-layout-explicit-mode-required")
        );
        assert_eq!(
            bootstrap_exporter(&bootstrap, true).err(),
            Some("resource-layout-node-required")
        );
    }
    #[test]
    fn account_login_opens_only_the_canonical_authorize_target() {
        let valid="https://app.uptokey.com/api/account/native/authorize?id=123e4567-e89b-42d3-a456-426614174000";
        assert!(account_url_allowed(valid));
        for value in [
            valid.replace("app.uptokey.com", "evil.test"),
            valid.replace("/authorize", "/logout"),
            format!("{valid}&extra=1"),
            format!("{valid}#fragment"),
        ] {
            assert!(!account_url_allowed(&value))
        }
    }
    #[test]
    fn startup_accepts_only_the_laboratory_origin_and_one_token() {
        assert!(startup_url(&format!("http://127.0.0.1:43180/?token={TOKEN}")).is_ok());
        for raw in [
            format!("https://example.com/?token={TOKEN}"),
            format!("http://localhost:43180/?token={TOKEN}"),
            format!("http://127.0.0.1:43181/?token={TOKEN}"),
            format!("http://u@127.0.0.1:43180/?token={TOKEN}"),
            format!("http://127.0.0.1:43180/?token={TOKEN}&token={TOKEN}"),
            format!("http://127.0.0.1:43180/?token={TOKEN}#leak"),
            "http://127.0.0.1:43180/".into(),
        ] {
            assert!(startup_url(&raw).is_err());
        }
    }
    #[test]
    fn native_startup_cookie_is_strict_and_becomes_http_only_loopback_cookie() {
        let receipt = serde_json::json!({"cookie":{"name":format!("dsh-auth-{}","b".repeat(43)),"value":format!("v1.{}.{}","c".repeat(32),"d".repeat(43)),"maxAgeSeconds":31536000}});
        let cookie = startup_cookie(&receipt).unwrap();
        assert_eq!(cookie.domain(), Some("127.0.0.1"));
        assert_eq!(cookie.path(), Some("/"));
        assert_eq!(cookie.http_only(), Some(true));
        assert_eq!(cookie.secure(), Some(false));
        assert_eq!(
            cookie.same_site(),
            Some(tauri::webview::cookie::SameSite::Strict)
        );
        assert_eq!(cookie.max_age().unwrap().whole_seconds(), 31536000);
        assert_eq!(
            transitional_startup_cookie(&receipt).unwrap().same_site(),
            Some(tauri::webview::cookie::SameSite::Lax)
        );
        for invalid in [
            serde_json::json!({}),
            serde_json::json!({"cookie":{"name":"other","value":"v1.abc.def","maxAgeSeconds":1}}),
            serde_json::json!({"cookie":{"name":format!("dsh-auth-{}","b".repeat(43)),"value":format!("v2.{}.{}","c".repeat(32),"d".repeat(43)),"maxAgeSeconds":31536000}}),
            serde_json::json!({"cookie":{"name":format!("dsh-auth-{}","b".repeat(43)),"value":format!("v1.{}.{}","c".repeat(32),"d".repeat(43)),"maxAgeSeconds":0}}),
        ] {
            assert!(startup_cookie(&invalid).is_err())
        }
        assert_eq!(
            clean_startup_url(&format!("http://127.0.0.1:43180/?token={TOKEN}"))
                .unwrap()
                .as_str(),
            "http://127.0.0.1:43180/"
        );
    }
    #[test]
    fn navigation_keeps_the_original_local_ui_and_its_preview_frames() {
        for raw in [
            "http://127.0.0.1:43180/session/demo",
            "about:blank",
            "about:srcdoc",
            "blob:http://127.0.0.1:43180/fixture",
        ] {
            assert!(navigation_allowed(&Url::parse(raw).unwrap()));
        }
        for raw in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "https://example.com",
            "http://127.0.0.1:11434",
            "blob:https://example.com/fixture",
        ] {
            assert!(!navigation_allowed(&Url::parse(raw).unwrap()));
        }
    }
    #[test]
    fn external_links_allow_https_without_native_or_local_targets() {
        for raw in [
            "https://platform.deepseek.com/api_keys",
            "https://docs.ollama.com/",
            "https://console.anthropic.com/settings/keys",
            "https://example.com:443/docs?lang=pt#start",
        ] {
            assert!(external_url_allowed(&Url::parse(raw).unwrap()), "{raw}");
            assert!(!navigation_allowed(&Url::parse(raw).unwrap()));
        }
        for raw in [
            "http://127.0.0.1:43180/?token=synthetic",
            "https://127.0.0.1/",
            "https://[::1]/",
            "https://localhost/",
            "https://host.local/",
            "https://app.localhost./",
            "https://host.internal/",
            "https://intranet/",
            "https://example.com:8443/",
            "https://user:password@example.com/",
            "http://example.com/",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,test",
            "ms-settings:privacy",
            "mailto:person@example.com",
            "blob:https://example.com/demo",
            "about:blank",
        ] {
            assert!(!external_url_allowed(&Url::parse(raw).unwrap()), "{raw}");
        }
    }
}

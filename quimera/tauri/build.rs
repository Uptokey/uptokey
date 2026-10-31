#[path = "src/harness_build_config.rs"]
mod harness_build_config;
#[allow(dead_code)]
#[path = "src/native_build_identity.rs"]
mod native_build_identity;

fn main() {
    println!("cargo:rerun-if-changed=src/native_build_identity.rs");
    println!("cargo:rerun-if-env-changed=UPTOKEY_RELEASE_SOURCE_COMMIT");
    let commit = std::env::var_os("UPTOKEY_RELEASE_SOURCE_COMMIT").map(|value| {
        value
            .into_string()
            .expect("release source commit must be UTF-8")
    });
    if let Some(value) = &commit {
        assert!(
            native_build_identity::valid_source_commit(value),
            "release source commit must be 40 lowercase hex characters"
        );
    }
    // Explicitly clear absent metadata so local builds cannot inherit stale identity.
    println!(
        "cargo:rustc-env=UPTOKEY_RELEASE_SOURCE_COMMIT={}",
        commit.as_deref().unwrap_or("")
    );
    println!("cargo:rerun-if-changed=src/harness_build_config.rs");
    println!("cargo:rerun-if-changed=tauri.harness.conf.json");
    println!("cargo:rerun-if-env-changed=TAURI_CONFIG");
    if std::env::var_os("CARGO_FEATURE_HARNESS_ENTRY").is_some() {
        let harness = std::fs::read_to_string("tauri.harness.conf.json")
            .expect("Harness build configuration unavailable");
        let incoming = std::env::var("TAURI_CONFIG").ok();
        let overlay = harness_build_config::overlay(&harness, incoming.as_deref())
            .expect("Harness build configuration invalid");
        // tauri-build and generate_context must receive the exact same overlay.
        std::env::set_var("TAURI_CONFIG", &overlay);
        println!("cargo:rustc-env=TAURI_CONFIG={overlay}");
    }
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "proxy_address",
            "proxy_start",
            "proxy_stop",
            "proxy_restart",
            "proxy_status",
            "proxy_health",
            "get_system_theme",
            "get_preferred_theme",
            "set_preferred_theme",
            "resolve_theme",
            "notification_show",
            "diagnostics_export",
            "pick_folder",
            "list_workspace_contexts",
            "approve_workspace_context",
            "open_account_login",
            "open_subscription_url",
            "open_model_page",
            "open_provider_portal",
            "harness_account_request",
            "harness_open_account_login",
            "harness_complete_account_login",
            "harness_open_account_page",
            "harness_refresh_provider_models",
            "harness_local_connections",
            "harness_computer_approve_focus",
            "harness_theme_sync",
            "harness_theme_state",
            "harness_public_api_queued",
            "harness_notification_show",
        ]),
    ))
    .expect("native capability build failed");
}

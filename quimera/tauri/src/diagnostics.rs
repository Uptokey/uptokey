//! Diagnóstico sanitizado: exporta somente estados/versões/códigos de erro.
//! Proibido incluir prompts, conteúdo, caminhos de usuário, tokens ou chaves;
//! coberto por teste com canários.

use crate::supervisor::ProxyStateView;
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};

pub const DIAGNOSTICS_FILE: &str = "uptokey-diagnostics.json";

pub fn build_diagnostics(
    app_version: &str,
    bundle_identifier: &str,
    proxy: &ProxyStateView,
    sidecar_version: Option<&str>,
    config_schema: u32,
    recent_error_codes: &[String],
) -> serde_json::Value {
    json!({
        "app": "uptokey-tauri",
        "app_version": app_version,
        "bundle_identifier": bundle_identifier,
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "proxy": proxy,
        "sidecar_version": sidecar_version,
        "config_schema_version": config_schema,
        "recent_error_codes": recent_error_codes,
        "generated_at_unix": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    })
}

pub fn export_diagnostics(log_dir: &Path, payload: &serde_json::Value) -> Result<PathBuf, String> {
    let _ = fs::create_dir_all(log_dir);
    let path = log_dir.join(DIAGNOSTICS_FILE);
    let json = serde_json::to_string_pretty(payload).map_err(|_| "diagnostics_serialize_failed")?;
    // Canário de defesa em profundidade: recusa persistir se algum padrão de
    // credencial aparecer no payload serializado.
    let redacted_check = crate::sidecar::redact_line(&json);
    if redacted_check != json {
        return Err("diagnostics_contains_secret_pattern".into());
    }
    fs::write(&path, json).map_err(|_| "diagnostics_write_failed")?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostics_shape_is_sanitized() {
        let payload = build_diagnostics(
            "0.2.0",
            "com.uptokey.tauri",
            &ProxyStateView::Ready {
                version: "v0.2.0".into(),
                owned: true,
                pid: Some(4242),
            },
            Some("0.2.0"),
            2,
            &["readiness_timeout".to_string()],
        );
        let text = serde_json::to_string(&payload).unwrap();
        assert!(text.contains("uptokey-tauri"));
        assert!(text.contains("\"ready\""));
        assert!(!text.contains("C:\\Users"));
        assert!(!text.contains("/home/"));
        assert!(!text.contains("Bearer"));
    }

    #[test]
    fn export_refuses_secret_canary() {
        let payload = json!({ "note": "Bearer abcdefghijklmnopqrstuvwxyz0123456789" });
        let dir =
            std::env::temp_dir().join(format!("uptokey-tauri-diag-test-{}", std::process::id()));
        let result = export_diagnostics(&dir, &payload);
        assert_eq!(
            result.err().as_deref(),
            Some("diagnostics_contains_secret_pattern")
        );
        let _ = fs::remove_dir_all(&dir);
    }
}

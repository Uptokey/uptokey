//! Configuração mínima da casca (somente preferência de tema do shell).
//! Dono único: este arquivo guarda apenas estado do shell; tema da interface,
//! sessões, conversas e segredos permanecem nos stores canônicos (PWA/proxy).

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub const CONFIG_FILE: &str = "shell-config.json";
pub const LEGACY_FILE: &str = "config.json";
pub const MIGRATED_MARK: &str = "config.json.v1-migrated";

/// Explicit host configuration, never supplied by the WebView.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct OperationalProfile {
    pub data_dir: Option<PathBuf>,
    pub secret_service: Option<String>,
}

impl OperationalProfile {
    pub fn from_env() -> Result<Self, String> {
        Self::from_lookup(|key| std::env::var(key).ok())
    }

    pub(crate) fn from_lookup(
        mut lookup: impl FnMut(&str) -> Option<String>,
    ) -> Result<Self, String> {
        let data_dir = lookup("UPTOKEY_QUIMERA_DATA_DIR")
            .map(|value| {
                crate::sidecar::validate_profile_directory(&value)?;
                Ok::<_, String>(PathBuf::from(value))
            })
            .transpose()?;
        let secret_service = lookup("UPTOKEY_SECRET_SERVICE");
        if let Some(service) = &secret_service {
            const DEFAULT: &str = "com.uptokey.quimera.proxy";
            let valid = service == DEFAULT
                || service
                    .strip_prefix("com.uptokey.quimera.proxy.")
                    .is_some_and(|suffix| {
                        (1..=101).contains(&suffix.len())
                            && suffix
                                .bytes()
                                .next()
                                .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
                            && suffix.bytes().all(|b| {
                                b.is_ascii_lowercase()
                                    || b.is_ascii_digit()
                                    || b == b'.'
                                    || b == b'-'
                            })
                    });
            if !valid {
                return Err("native_secret_service_invalid".into());
            }
            if service != DEFAULT && data_dir.is_none() {
                return Err("native_profile_data_directory_required".into());
            }
        }
        Ok(Self {
            data_dir,
            secret_service,
        })
    }

    pub fn storage_dir(&self, default: PathBuf, component: &str) -> PathBuf {
        self.data_dir
            .as_ref()
            .map(|root| root.join("desktop").join(component))
            .unwrap_or(default)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ShellConfig {
    pub schema_version: u32,
    /// Preferência do shell: "dark" | "light" | "system".
    pub theme: Option<String>,
}

impl Default for ShellConfig {
    fn default() -> Self {
        Self {
            schema_version: 2,
            theme: None,
        }
    }
}

#[derive(Deserialize)]
struct LegacyConfig {
    preferred_theme: Option<String>,
}

fn valid_theme(value: &str) -> bool {
    matches!(value, "dark" | "light" | "system")
}

/// Carrega a configuração; se só existir o formato v1 (`config.json` com
/// `preferred_theme`), migra de forma preservadora: grava o novo arquivo e
/// renomeia o antigo para `config.json.v1-migrated` (nunca sobrescreve/apaga).
pub fn load_or_migrate(config_dir: &Path) -> ShellConfig {
    let path = config_dir.join(CONFIG_FILE);
    if let Ok(raw) = fs::read_to_string(&path) {
        if let Ok(mut cfg) = serde_json::from_str::<ShellConfig>(&raw) {
            if cfg.schema_version != 2 {
                cfg.schema_version = 2;
                let _ = save(config_dir, &cfg);
            }
            if let Some(t) = cfg.theme.clone() {
                if !valid_theme(&t) {
                    cfg.theme = None;
                }
            }
            return cfg;
        }
    }
    let legacy = config_dir.join(LEGACY_FILE);
    if let Ok(raw) = fs::read_to_string(&legacy) {
        if let Ok(old) = serde_json::from_str::<LegacyConfig>(&raw) {
            let cfg = ShellConfig {
                schema_version: 2,
                theme: old.preferred_theme.filter(|t| valid_theme(t)),
            };
            let _ = save(config_dir, &cfg);
            let _ = fs::rename(&legacy, config_dir.join(MIGRATED_MARK));
            return cfg;
        }
    }
    ShellConfig::default()
}

/// Escrita atômica: arquivo temporário + rename; crash nunca corrompe config.
pub fn save(config_dir: &Path, cfg: &ShellConfig) -> Result<(), String> {
    let _ = fs::create_dir_all(config_dir);
    let path = config_dir.join(CONFIG_FILE);
    let tmp = config_dir.join(format!("{}.tmp", CONFIG_FILE));
    let json = serde_json::to_string_pretty(cfg).map_err(|_| "config_serialize_failed")?;
    fs::write(&tmp, json).map_err(|_| "config_write_failed")?;
    fs::rename(&tmp, &path).map_err(|_| "config_rename_failed")?;
    Ok(())
}

pub fn config_path(config_dir: &Path) -> PathBuf {
    config_dir.join(CONFIG_FILE)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn operational_profile_defaults_preserve_existing_storage() {
        let profile = OperationalProfile::from_lookup(|_| None).unwrap();
        assert_eq!(profile, OperationalProfile::default());
        assert_eq!(
            profile.storage_dir(PathBuf::from("existing"), "shell"),
            PathBuf::from("existing")
        );
    }

    #[test]
    fn operational_profile_separates_shell_webview_and_vault_without_creating_data() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().join("isolated");
        let profile = OperationalProfile::from_lookup(|key| match key {
            "UPTOKEY_QUIMERA_DATA_DIR" => Some(root.to_string_lossy().into_owned()),
            "UPTOKEY_SECRET_SERVICE" => Some("com.uptokey.quimera.proxy.native-smoke".into()),
            _ => panic!("unapproved environment lookup"),
        })
        .unwrap();
        assert_eq!(
            profile.secret_service.as_deref(),
            Some("com.uptokey.quimera.proxy.native-smoke")
        );
        assert_eq!(
            profile.storage_dir(PathBuf::from("personal"), "shell"),
            root.join("desktop/shell")
        );
        assert_eq!(
            profile.storage_dir(PathBuf::from("personal"), "webview"),
            root.join("desktop/webview")
        );
        assert!(!root.exists());
    }

    #[test]
    fn operational_profile_rejects_invalid_namespace_or_missing_isolation() {
        let fixture = tempfile::tempdir().unwrap();
        for service in [
            "foreign.vault",
            "",
            "com.uptokey.quimera.proxy.",
            "com.uptokey.quimera.proxy.UPPER",
            "com.uptokey.quimera.proxy.a\n",
            "com.uptokey.quimera.proxy.-bad",
        ] {
            assert_eq!(
                OperationalProfile::from_lookup(|key| Some(if key == "UPTOKEY_QUIMERA_DATA_DIR" {
                    fixture.path().to_string_lossy().into_owned()
                } else {
                    service.into()
                }))
                .unwrap_err(),
                "native_secret_service_invalid"
            );
        }
        assert_eq!(
            OperationalProfile::from_lookup(|key| (key == "UPTOKEY_SECRET_SERVICE")
                .then(|| "com.uptokey.quimera.proxy.test".into()))
            .unwrap_err(),
            "native_profile_data_directory_required"
        );
        assert!(OperationalProfile::from_lookup(
            |key| (key == "UPTOKEY_QUIMERA_DATA_DIR").then(|| "relative".into())
        )
        .is_err());
        assert!(OperationalProfile::from_lookup(
            |key| (key == "UPTOKEY_SECRET_SERVICE").then(|| "com.uptokey.quimera.proxy".into())
        )
        .is_ok());
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "uptokey-tauri-config-test-{}-{}",
            tag,
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn fresh_install_returns_default() {
        let dir = temp_dir("fresh");
        let cfg = load_or_migrate(&dir);
        assert_eq!(cfg, ShellConfig::default());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn migrates_legacy_theme_without_losing_file() {
        let dir = temp_dir("migrate");
        fs::write(dir.join(LEGACY_FILE), "{\"preferred_theme\":\"dark\"}").unwrap();
        let cfg = load_or_migrate(&dir);
        assert_eq!(cfg.theme.as_deref(), Some("dark"));
        assert_eq!(cfg.schema_version, 2);
        assert!(dir.join(MIGRATED_MARK).exists());
        assert!(!dir.join(LEGACY_FILE).exists());
        // Idempotente: segunda carga lê o novo arquivo.
        let again = load_or_migrate(&dir);
        assert_eq!(again, cfg);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn legacy_invalid_theme_is_dropped_not_corrupted() {
        let dir = temp_dir("invalid-theme");
        fs::write(
            dir.join(LEGACY_FILE),
            "{\"preferred_theme\":\"neon-purple-9000\"}",
        )
        .unwrap();
        let cfg = load_or_migrate(&dir);
        assert_eq!(cfg.theme, None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupted_current_config_falls_back_without_panic() {
        let dir = temp_dir("corrupt");
        fs::write(dir.join(CONFIG_FILE), "{not json!!!").unwrap();
        let cfg = load_or_migrate(&dir);
        assert_eq!(cfg, ShellConfig::default());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_is_atomic_and_roundtrips() {
        let dir = temp_dir("roundtrip");
        let cfg = ShellConfig {
            schema_version: 2,
            theme: Some("light".into()),
        };
        save(&dir, &cfg).unwrap();
        assert_eq!(load_or_migrate(&dir), cfg);
        assert!(!dir.join(format!("{}.tmp", CONFIG_FILE)).exists());
        let _ = fs::remove_dir_all(&dir);
    }
}

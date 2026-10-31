//! Project the Harness-owned Appearance preference onto the native window.
//!
//! `quimera/tauri/src/bridge.rs::get_system_theme` (lines 1339–1345 in the
//! canonical source inspected 2026-10-23) supplies the Light/Dark mapping.
//! Its shell-config persistence is deliberately not imported: the original
//! Harness `ui-theme.preference` remains the sole durable preference owner.
use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::{State, Theme, WebviewWindow};

pub const INITIALIZATION_SCRIPT: &str = r#"(()=>{'use strict';
 if(location.origin!=='http://127.0.0.1:43180'||!window.__TAURI_INTERNALS__||typeof window.__TAURI_INTERNALS__.invoke!=='function')return;
 const invoke=window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__);
 Object.defineProperty(window,'UptokeyHarnessTheme',{value:Object.freeze({ready:true,
  sync:preference=>invoke('harness_theme_sync',{preference}),
  read:()=>invoke('harness_theme_state')
 }),writable:false,configurable:false});
})();"#;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Preference {
    #[default]
    System,
    Light,
    Dark,
}
impl Preference {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "system" => Ok(Self::System),
            "light" => Ok(Self::Light),
            "dark" => Ok(Self::Dark),
            _ => Err("theme_preference_invalid".to_owned()),
        }
    }
    fn name(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Light => "light",
            Self::Dark => "dark",
        }
    }
    fn native(self) -> Option<Theme> {
        match self {
            Self::System => None,
            Self::Light => Some(Theme::Light),
            Self::Dark => Some(Theme::Dark),
        }
    }
}

/// Only the last applied projection is kept in memory; no second settings file.
#[derive(Clone, Default)]
pub struct ThemeBridge {
    preference: Arc<Mutex<Preference>>,
}

#[derive(Debug, Serialize)]
pub struct ThemeSnapshot {
    preference: &'static str,
    resolved: &'static str,
}

fn observed_snapshot(preference: Preference, actual: Theme) -> Result<ThemeSnapshot, String> {
    let resolved = match actual {
        Theme::Light => "light",
        Theme::Dark => "dark",
        _ => return Err("theme_unavailable".to_owned()),
    };
    Ok(ThemeSnapshot {
        preference: preference.name(),
        resolved,
    })
}
fn trusted_window(label: &str, url: &tauri::Url) -> bool {
    label == "workbench"
        && url.origin().ascii_serialization() == "http://127.0.0.1:43180"
        && url.username().is_empty()
        && url.password().is_none()
}
fn admit_window(window: &WebviewWindow) -> Result<(), String> {
    let url = window.url().map_err(|_| "theme_window_denied".to_owned())?;
    if !trusted_window(window.label(), &url) {
        return Err("theme_window_denied".to_owned());
    }
    Ok(())
}

#[tauri::command]
pub async fn harness_theme_sync(
    window: WebviewWindow,
    state: State<'_, ThemeBridge>,
    preference: String,
) -> Result<ThemeSnapshot, String> {
    admit_window(&window)?;
    let next = Preference::parse(&preference)?;
    let bridge = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Serialize set+observe so concurrent updates cannot publish stale state.
        let mut current = bridge
            .preference
            .lock()
            .map_err(|_| "theme_state_unavailable".to_owned())?;
        window
            .set_theme(next.native())
            .map_err(|_| "theme_unavailable".to_owned())?;
        *current = next;
        let actual = window.theme().map_err(|_| "theme_unavailable".to_owned())?;
        observed_snapshot(*current, actual)
    })
    .await
    .map_err(|_| "theme_unavailable".to_owned())?
}

#[tauri::command]
pub async fn harness_theme_state(
    window: WebviewWindow,
    state: State<'_, ThemeBridge>,
) -> Result<ThemeSnapshot, String> {
    admit_window(&window)?;
    let bridge = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let current = bridge
            .preference
            .lock()
            .map_err(|_| "theme_state_unavailable".to_owned())?;
        let actual = window.theme().map_err(|_| "theme_unavailable".to_owned())?;
        observed_snapshot(*current, actual)
    })
    .await
    .map_err(|_| "theme_unavailable".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preference_accepts_only_harness_builtin_modes() {
        for (text, preference) in [
            ("system", Preference::System),
            ("light", Preference::Light),
            ("dark", Preference::Dark),
        ] {
            assert_eq!(Preference::parse(text).unwrap(), preference);
            assert_eq!(preference.name(), text);
        }
        for invalid in [
            "", "auto", "Dark", "system ", " light", "light\n", "custom", "../dark",
        ] {
            assert!(Preference::parse(invalid).is_err());
        }
    }
    #[test]
    fn system_remains_native_automatic_mode() {
        assert!(Preference::System.native().is_none());
        assert!(matches!(Preference::Light.native(), Some(Theme::Light)));
        assert!(matches!(Preference::Dark.native(), Some(Theme::Dark)));
        let bridge = ThemeBridge::default();
        assert_eq!(*bridge.preference.lock().unwrap(), Preference::System);
    }
    #[test]
    fn resolution_uses_observed_window_theme() {
        let system = observed_snapshot(Preference::System, Theme::Dark).unwrap();
        assert_eq!(system.preference, "system");
        assert_eq!(system.resolved, "dark");
        let mismatch = observed_snapshot(Preference::Dark, Theme::Light).unwrap();
        assert_eq!(mismatch.preference, "dark");
        assert_eq!(mismatch.resolved, "light");
    }
    #[test]
    fn theme_commands_admit_only_workbench_local_origin() {
        assert!(trusted_window(
            "workbench",
            &tauri::Url::parse("http://127.0.0.1:43180/").unwrap()
        ));
        for (label, url) in [
            ("main", "http://127.0.0.1:43180/"),
            ("workbench", "http://localhost:43180/"),
            ("workbench", "https://127.0.0.1:43180/"),
            ("workbench", "http://127.0.0.1:43181/"),
            ("workbench", "http://user@127.0.0.1:43180/"),
            ("workbench", "tauri://localhost/recovery.html"),
        ] {
            assert!(!trusted_window(label, &tauri::Url::parse(url).unwrap()));
        }
    }
}

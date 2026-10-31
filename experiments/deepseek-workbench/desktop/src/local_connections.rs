//! A public projection of the existing reconnect helper, never a pairing owner.
use crate::diagnostics::Exporter;
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{State, WebviewWindow};

pub const INITIALIZATION_SCRIPT: &str = include_str!("local_connections.js");

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Service {
    #[default]
    Unknown,
    Connected,
    Unavailable,
}
#[derive(Clone, Copy, Debug, Default, Serialize)]
pub struct Connections {
    core: Service,
    ollama: Service,
    // A receipt is a last attempt, not continuous health monitoring.
    checked: bool,
}
impl Connections {
    pub fn from_receipt(value: &serde_json::Value) -> Result<Self, &'static str> {
        let invalid = "reconnect-receipt-invalid";
        let parse = |name: &str| match value["services"][name].as_str() {
            Some("connected") => Ok(Service::Connected),
            Some("unavailable") => Ok(Service::Unavailable),
            _ => Err(invalid),
        };
        let result = Self {
            core: parse("core")?,
            ollama: parse("ollama")?,
            checked: true,
        };
        if value["reconnected"].as_bool() != Some(result.reconnected())
            || value["coreRestarted"].as_bool() != Some(false)
            || value["controllerRestarted"].as_bool() != Some(false)
        {
            return Err(invalid);
        }
        Ok(result)
    }
    pub fn reconnected(self) -> bool {
        self.core == Service::Connected && self.ollama == Service::Connected
    }
    pub fn menu_label(self) -> &'static str {
        match (self.core, self.ollama) {
            (Service::Connected, Service::Connected) => "Local services connected — reconnect",
            (Service::Connected, _) => "Core connected; optional Ollama unavailable — reconnect",
            _ => "Core connection unavailable — reconnect",
        }
    }
}

#[derive(Clone, Default)]
pub struct NativeActions {
    pub busy: Arc<AtomicBool>,
    last: Arc<Mutex<Connections>>,
}
// The menu and IPC use exactly the same owner and last-attempt projection.
impl NativeActions {
    pub fn invalidate(&self) {
        if let Ok(mut last) = self.last.lock() {
            *last = Connections::default();
        }
    }
    pub fn reconnect(&self, exporter: &Exporter) -> Result<Connections, &'static str> {
        let result = exporter.reconnect_services();
        if let Ok(mut last) = self.last.lock() {
            *last = result.as_ref().copied().unwrap_or_default();
        }
        result
    }
    pub fn snapshot(&self) -> Result<Connections, &'static str> {
        self.last
            .lock()
            .map(|value| *value)
            .map_err(|_| "local_connections_unavailable")
    }
}
struct ActionGuard(Arc<AtomicBool>);
impl ActionGuard {
    fn acquire(busy: Arc<AtomicBool>) -> Result<Self, &'static str> {
        if busy.swap(true, Ordering::SeqCst) {
            return Err("local_connections_busy");
        }
        Ok(Self(busy))
    }
}
impl Drop for ActionGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
fn trusted_window(label: &str, url: &tauri::Url) -> bool {
    label == "workbench" && crate::harness_window::local_origin(url)
}
#[tauri::command]
pub async fn harness_local_connections(
    window: WebviewWindow,
    exporter: State<'_, Option<Exporter>>,
    actions: State<'_, NativeActions>,
    reconnect: bool,
) -> Result<Connections, String> {
    if !window
        .url()
        .is_ok_and(|url| trusted_window(window.label(), &url))
    {
        return Err("local_connections_window_denied".into());
    }
    let exporter = exporter
        .inner()
        .as_ref()
        .cloned()
        .ok_or("local_connections_unavailable")?;
    if !reconnect {
        return actions.snapshot().map_err(str::to_owned);
    }
    let guard = ActionGuard::acquire(actions.busy.clone()).map_err(str::to_owned)?;
    let actions = actions.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        actions.reconnect(&exporter)
    })
    .await
    .map_err(|_| "local_connections_unavailable")?
    .map_err(|_| "local_connections_unavailable".to_owned());
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn optional_ollama_failure_does_not_hide_core_connection() {
        let value = serde_json::json!({"reconnected":false,"services":{"core":"connected","ollama":"unavailable"},"coreRestarted":false,"controllerRestarted":false,"token":"private"});
        let result = Connections::from_receipt(&value).unwrap();
        assert_eq!(result.core, Service::Connected);
        assert!(result.menu_label().starts_with("Core connected"));
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            serde_json::json!({"core":"connected","ollama":"unavailable","checked":true})
        );
    }
    #[test]
    fn malformed_or_contradictory_receipt_never_becomes_ready() {
        for value in [
            serde_json::json!({"reconnected":true}),
            serde_json::json!({"reconnected":true,"services":{"core":"connected","ollama":"unavailable"},"coreRestarted":false,"controllerRestarted":false}),
        ] {
            assert!(Connections::from_receipt(&value).is_err());
        }
        assert_eq!(
            NativeActions::default().snapshot().unwrap().core,
            Service::Unknown
        );
    }
    #[test]
    fn menu_and_ipc_cannot_acquire_concurrent_owner() {
        let actions = NativeActions::default();
        let guard = ActionGuard::acquire(actions.busy.clone()).unwrap();
        assert!(ActionGuard::acquire(actions.busy.clone()).is_err());
        drop(guard);
        assert!(ActionGuard::acquire(actions.busy.clone()).is_ok());
    }
    #[test]
    fn known_runtime_transition_invalidates_prior_connection_receipt() {
        let actions = NativeActions::default();
        *actions.last.lock().unwrap() = Connections {
            core: Service::Connected,
            ollama: Service::Connected,
            checked: true,
        };
        actions.invalidate();
        let snapshot = actions.snapshot().unwrap();
        assert_eq!(snapshot.core, Service::Unknown);
        assert!(!snapshot.checked);
    }
    #[test]
    fn only_workbench_at_existing_local_origin_is_admitted() {
        assert!(trusted_window(
            "workbench",
            &tauri::Url::parse("http://127.0.0.1:43180/").unwrap()
        ));
        for (label, url) in [
            ("main", "http://127.0.0.1:43180/"),
            ("workbench", "http://localhost:43180/"),
            ("workbench", "http://user@127.0.0.1:43180/"),
            ("workbench", "https://app.uptokey.com/"),
        ] {
            assert!(!trusted_window(label, &tauri::Url::parse(url).unwrap()));
        }
    }
}

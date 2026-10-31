use tauri::AppHandle;
#[cfg(not(target_os = "linux"))]
use tauri_plugin_notification::NotificationExt;

pub const INITIALIZATION_SCRIPT: &str = r#"(function(){'use strict';const invoke=window.__TAURI_INTERNALS__?.invoke;if(typeof invoke!=='function')return;const kinds=new Set(['session-done','question','permission','error']);const api=Object.freeze({show(kind){if(!kinds.has(kind))return Promise.reject(new Error('notification-kind-invalid'));return invoke('harness_notification_show',{kind});}});Object.defineProperty(window,'UptokeyHarnessNotifications',{value:api});window.addEventListener('uptokey:native-attention',event=>{const kind=event?.detail?.kind;if(kinds.has(kind))void api.show(kind).catch(()=>{});});})();"#;

fn notification(kind: &str) -> Option<(&'static str, &'static str)> {
    match kind {
        "session-done" => Some(("Uptokey", "Task completed.")),
        "question" => Some(("Uptokey", "Your input is needed.")),
        "permission" => Some(("Uptokey", "Approval is needed.")),
        "error" => Some(("Uptokey", "A task needs attention.")),
        _ => None,
    }
}

#[tauri::command]
#[cfg(not(target_os = "linux"))]
pub fn harness_notification_show(app: AppHandle, kind: String) -> Result<(), &'static str> {
    let (title, body) = notification(&kind).ok_or("notification-kind-invalid")?;
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|_| "native-notification-unavailable")
}

#[tauri::command]
#[cfg(target_os = "linux")]
pub fn harness_notification_show(_app: AppHandle, kind: String) -> Result<(), &'static str> {
    use gio::prelude::DBusProxyExt;
    use glib::variant::ToVariant;
    use std::collections::HashMap;

    let (title, body) = notification(&kind).ok_or("notification-kind-invalid")?;
    let proxy = gio::DBusProxy::for_bus_sync(
        gio::BusType::Session,
        gio::DBusProxyFlags::DO_NOT_LOAD_PROPERTIES | gio::DBusProxyFlags::DO_NOT_CONNECT_SIGNALS,
        None,
        "org.freedesktop.Notifications",
        "/org/freedesktop/Notifications",
        "org.freedesktop.Notifications",
        gio::Cancellable::NONE,
    )
    .map_err(|_| "native-notification-unavailable")?;
    let hints: HashMap<String, glib::Variant> = HashMap::new();
    let parameters = (
        "uptokey-harness-desktop",
        0u32,
        "uptokey-harness-desktop",
        title,
        body,
        Vec::<String>::new(),
        hints,
        -1i32,
    )
        .to_variant();
    proxy
        .call_sync(
            "Notify",
            Some(&parameters),
            gio::DBusCallFlags::NONE,
            5_000,
            gio::Cancellable::NONE,
        )
        .map(|_| ())
        .map_err(|_| "native-notification-unavailable")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notification_contract_has_only_fixed_secret_free_copy() {
        assert_eq!(
            notification("session-done"),
            Some(("Uptokey", "Task completed."))
        );
        assert_eq!(
            notification("question"),
            Some(("Uptokey", "Your input is needed."))
        );
        assert_eq!(
            notification("permission"),
            Some(("Uptokey", "Approval is needed."))
        );
        assert_eq!(
            notification("error"),
            Some(("Uptokey", "A task needs attention."))
        );
        for invalid in [
            "",
            "done",
            "Session done",
            "../../secret",
            "session-done\nsecret",
        ] {
            assert_eq!(notification(invalid), None);
        }
    }

    #[test]
    fn initialization_exposes_only_kind_and_the_scoped_command() {
        assert!(INITIALIZATION_SCRIPT.contains("harness_notification_show"));
        assert!(INITIALIZATION_SCRIPT.contains("Object.freeze"));
        assert!(INITIALIZATION_SCRIPT.contains("uptokey:native-attention"));
        assert!(!INITIALIZATION_SCRIPT.contains("title:"));
        assert!(!INITIALIZATION_SCRIPT.contains("body:"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_transport_keeps_the_freedesktop_notify_signature() {
        use glib::variant::ToVariant;
        use std::collections::HashMap;

        let hints: HashMap<String, glib::Variant> = HashMap::new();
        let parameters = (
            "uptokey-harness-desktop",
            0u32,
            "uptokey-harness-desktop",
            "Uptokey",
            "Task completed.",
            Vec::<String>::new(),
            hints,
            -1i32,
        )
            .to_variant();
        assert_eq!(parameters.type_().as_str(), "(susssasa{sv}i)");
    }
}

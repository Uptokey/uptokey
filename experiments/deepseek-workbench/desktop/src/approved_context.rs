//! Native selection of one already-approved context root. No credentials cross this boundary.
use crate::diagnostics::Exporter;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{
    menu::{MenuItem, Submenu},
    AppHandle, Manager,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

pub const ACTION: &str = "import-approved-context";
pub const REVOKE_ACTION: &str = "revoke-approved-context";
pub const CONNECT_ACTION: &str = "connect-approved-context";
const CHOICE_PREFIX: &str = "approved-context-choice-";
const MAX_CHOICES: usize = 128;
const MAX_REVISION: u64 = 9_007_199_254_740_991;
const SELECTION_LIFETIME: Duration = Duration::from_secs(300);

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Selection {
    pub client_id: String,
    pub link_revision: u64,
    pub conversation_id: String,
    pub project_id: String,
    pub root_binding_id: String,
    pub root_revision: u64,
}
impl Selection {
    fn valid(&self) -> bool {
        uuid(&self.client_id)
            && uuid(&self.conversation_id)
            && identifier(&self.project_id)
            && identifier(&self.root_binding_id)
            && (1..=MAX_REVISION).contains(&self.link_revision)
            && (1..=MAX_REVISION).contains(&self.root_revision)
    }
}
fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()
            }
        })
}
fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Choice {
    pub label: String,
    pub selection: Selection,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Listing {
    pub linked: bool,
    pub choices: Vec<Choice>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionSession {
    pub client_id: String,
    pub expected_revision: u64,
    pub id: String,
    pub expires_at: String,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionChallenge {
    pub id: String,
    pub user_code: String,
    pub expires_at: String,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionBegin {
    pub challenge: ConnectionChallenge,
    pub expires_in_ms: u64,
    pub session: ConnectionSession,
}
pub fn parse_listing(value: serde_json::Value) -> Result<Listing, &'static str> {
    let listing: Listing = serde_json::from_value(value).map_err(|_| "context_response_invalid")?;
    if listing.choices.len() > MAX_CHOICES || (!listing.linked && !listing.choices.is_empty()) {
        return Err("context_response_invalid");
    }
    let mut seen = HashSet::new();
    let first = listing.choices.first().map(|choice| &choice.selection);
    for choice in &listing.choices {
        let selection = &choice.selection;
        if choice.label.trim().is_empty()
            || choice.label.len() > 2048
            || !selection.valid()
            || !seen.insert(selection.clone())
            || first.is_some_and(|first| {
                first.client_id != selection.client_id
                    || first.link_revision != selection.link_revision
                    || first.conversation_id != selection.conversation_id
            })
        {
            return Err("context_response_invalid");
        }
    }
    Ok(listing)
}
pub fn parse_import(value: serde_json::Value) -> Result<String, &'static str> {
    if value.get("imported").and_then(|value| value.as_bool()) != Some(true) {
        return Err("context_import_invalid");
    }
    let project = value
        .get("project")
        .and_then(|value| value.as_str())
        .ok_or("context_import_invalid")?;
    let suffix = project
        .strip_prefix("/workspace/import-")
        .ok_or("context_import_invalid")?;
    if suffix.len() != 32
        || !suffix
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err("context_import_invalid");
    }
    Ok(project.to_owned())
}
pub fn parse_revoke(value: serde_json::Value) -> Result<u64, &'static str> {
    let object = value.as_object().ok_or("context_revoke_invalid")?;
    if object.len() != 3
        || object.get("revoked").and_then(|value| value.as_bool()) != Some(true)
        || !object
            .get("clientId")
            .and_then(|value| value.as_str())
            .is_some_and(uuid)
    {
        return Err("context_revoke_invalid");
    }
    let revision = object
        .get("revision")
        .and_then(|value| value.as_u64())
        .ok_or("context_revoke_invalid")?;
    if !(1..=MAX_REVISION).contains(&revision) {
        return Err("context_revoke_invalid");
    }
    Ok(revision)
}
fn utc_shape(value: &str) -> bool {
    let bytes = value.as_bytes();
    matches!(bytes.len(), 20 | 24)
        && bytes.last() == Some(&b'Z')
        && bytes.iter().enumerate().all(|(index, byte)| {
            matches!(index, 4 | 7) && *byte == b'-'
                || index == 10 && *byte == b'T'
                || matches!(index, 13 | 16) && *byte == b':'
                || bytes.len() == 24 && index == 19 && *byte == b'.'
                || index == bytes.len() - 1 && *byte == b'Z'
                || byte.is_ascii_digit()
        })
}
pub fn parse_connection_begin(value: serde_json::Value) -> Result<ConnectionBegin, &'static str> {
    let begin: ConnectionBegin =
        serde_json::from_value(value).map_err(|_| "context_connection_invalid")?;
    let session = &begin.session;
    let challenge = &begin.challenge;
    if !uuid(&session.client_id)
        || !uuid(&session.id)
        || session.id != challenge.id
        || session.expires_at != challenge.expires_at
        || session.expected_revision > MAX_REVISION
        || challenge.user_code.len() != 8
        || !challenge
            .user_code
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_lowercase())
        || !utc_shape(&challenge.expires_at)
        || !(1..=600_000).contains(&begin.expires_in_ms)
    {
        return Err("context_connection_invalid");
    }
    Ok(begin)
}
pub fn parse_connection_complete(
    value: serde_json::Value,
    session: &ConnectionSession,
) -> Result<u64, &'static str> {
    let object = value.as_object().ok_or("context_connection_invalid")?;
    if object.len() != 3
        || object.get("connected").and_then(|value| value.as_bool()) != Some(true)
        || object.get("clientId").and_then(|value| value.as_str()) != Some(&session.client_id)
    {
        return Err("context_connection_invalid");
    }
    let revision = object
        .get("revision")
        .and_then(|value| value.as_u64())
        .ok_or("context_connection_invalid")?;
    if revision
        != session
            .expected_revision
            .checked_add(1)
            .ok_or("context_connection_invalid")?
        || revision > MAX_REVISION
    {
        return Err("context_connection_invalid");
    }
    Ok(revision)
}
fn menu_label(raw: &str, index: usize) -> String {
    let clean: String = raw
        .chars()
        .filter(|character| {
            !character.is_control()
                && !matches!(*character,'\u{202a}'..='\u{202e}'|'\u{2066}'..='\u{2069}')
        })
        .take(160)
        .collect();
    format!("{}. {}", index + 1, clean.trim().replace('&', "&&"))
}

#[derive(Default)]
struct SelectionState {
    generation: u64,
    pending: Option<(Instant, Vec<Choice>)>,
}
impl SelectionState {
    fn invalidate(&mut self) -> u64 {
        self.generation = self.generation.wrapping_add(1);
        self.pending = None;
        self.generation
    }
    fn install(&mut self, generation: u64, choices: Vec<Choice>, now: Instant) -> bool {
        if generation != self.generation {
            return false;
        }
        self.pending = Some((now, choices));
        true
    }
    fn take(&mut self, action: &str, now: Instant) -> Option<Selection> {
        let suffix = action.strip_prefix(CHOICE_PREFIX)?;
        let (generation, index) = suffix.split_once('-')?;
        let generation = generation.parse::<u64>().ok()?;
        let index = index.parse::<usize>().ok()?;
        if action != format!("{CHOICE_PREFIX}{generation}-{index}") || generation != self.generation
        {
            return None;
        }
        let (created, choices) = self.pending.as_ref()?;
        if now
            .checked_duration_since(*created)
            .is_none_or(|elapsed| elapsed > SELECTION_LIFETIME)
        {
            self.pending = None;
            return None;
        }
        let selection = choices.get(index)?.selection.clone();
        self.pending = None;
        Some(selection)
    }
}
#[derive(Clone)]
struct PendingConnection {
    deadline: Instant,
    begin: ConnectionBegin,
}
#[derive(Clone, Default)]
pub struct NativeState {
    selection: Arc<Mutex<SelectionState>>,
    popup: Arc<Mutex<Option<Submenu<tauri::Wry>>>>,
    connection: Arc<Mutex<Option<PendingConnection>>>,
}
struct BusyReset(Arc<AtomicBool>);
impl Drop for BusyReset {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst)
    }
}
fn notice(app: &AppHandle, message: &str) {
    app.dialog()
        .message(message)
        .title("Uptokey")
        .blocking_show();
}
fn error_message(code: &str) -> &'static str {
    match code {
        "context_not_linked" | "context_link_required" => "No approved context is connected.",
        "context_snapshot_changed"
        | "context_changed"
        | "context_link_changed"
        | "context_selection_stale" => {
            "The approved context changed. Open Import approved context again."
        }
        "context_snapshot_denied" => "This context does not allow a project snapshot.",
        "context_pairing_required" => {
            "Reconnect Uptokey local services to access approved contexts."
        }
        "context_link_pending" => "Context approval is still pending.",
        "context_link_expired" => {
            "Context approval expired. Choose Connect approved context again."
        }
        "context_link_invalid" => {
            "Reconnect Uptokey local services to repair the context identity."
        }
        "context_scope_denied" => "This Uptokey client cannot connect approved contexts.",
        "context_rate_limited" => {
            "Context connection is temporarily limited. Try again after the current request window."
        }
        _ => "Could not import the approved context. Open Import approved context to try again.",
    }
}

/// Returns true only for this feature's native action IDs. Dismissal performs no import.
#[expect(
    clippy::too_many_arguments,
    reason = "Preserve the accepted native menu contract and its distinct approval controls"
)]
pub fn handle_event(
    action: &str,
    app: &AppHandle,
    exporter: &Exporter,
    busy: &Arc<AtomicBool>,
    control: &MenuItem<tauri::Wry>,
    connect_control: &MenuItem<tauri::Wry>,
    revoke_control: &MenuItem<tauri::Wry>,
    state: &NativeState,
) -> bool {
    if action != ACTION
        && action != CONNECT_ACTION
        && action != REVOKE_ACTION
        && !action.starts_with(CHOICE_PREFIX)
    {
        return false;
    }
    if busy.swap(true, Ordering::SeqCst) {
        return true;
    }
    let reset = BusyReset(busy.clone());
    if action == CONNECT_ACTION {
        let app = app.clone();
        let exporter = exporter.clone();
        let connect_control = connect_control.clone();
        let state = state.clone();
        std::thread::spawn(move || {
            let _reset = reset;
            let _ = connect_control.set_enabled(false);
            let _ = connect_control.set_text("Connecting approved context…");
            let pending = state.connection.lock().ok().and_then(|mut state| {
                if state
                    .as_ref()
                    .is_some_and(|pending| Instant::now() >= pending.deadline)
                {
                    *state = None
                }
                state.clone()
            });
            if let Some(pending) = pending {
                let result = exporter.approved_context_connect_consume(&pending.begin.session);
                if !matches!(result, Err("context_link_pending")) {
                    if let Ok(mut state) = state.connection.lock() {
                        *state = None;
                    }
                }
                let _ = connect_control.set_text("Connect approved context…");
                let _ = connect_control.set_enabled(true);
                match result{
                    Ok(_)=>notice(&app,"Approved context connected."),
                    Err("context_link_pending")=>notice(&app,&format!("Approval is pending. In the owner Uptokey conversation run:\n/link-context {} {}\nThen choose Connect approved context again.",pending.begin.challenge.id,pending.begin.challenge.user_code)),
                    Err(code)=>notice(&app,error_message(code)),
                }
                return;
            }
            let result = exporter.approved_context_connect_begin();
            let _ = connect_control.set_text("Connect approved context…");
            let _ = connect_control.set_enabled(true);
            match result {
                Ok(begin) => {
                    let Some(deadline) =
                        Instant::now().checked_add(Duration::from_millis(begin.expires_in_ms))
                    else {
                        notice(&app, error_message("context_connection_invalid"));
                        return;
                    };
                    if let Ok(mut state) = state.connection.lock() {
                        *state = Some(PendingConnection {
                            deadline,
                            begin: begin.clone(),
                        });
                    }
                    notice(&app,&format!("In the owner Uptokey conversation run:\n/link-context {} {}\nThen choose Connect approved context again.",begin.challenge.id,begin.challenge.user_code));
                }
                Err(code) => notice(&app, error_message(code)),
            }
        });
    } else if action == REVOKE_ACTION {
        let app = app.clone();
        let exporter = exporter.clone();
        let revoke_control = revoke_control.clone();
        std::thread::spawn(move || {
            let _reset = reset;
            let confirmed = app
                .dialog()
                .message("Disconnect the approved context from this Uptokey laboratory?")
                .title("Uptokey")
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "Disconnect".into(),
                    "Cancel".into(),
                ))
                .blocking_show();
            if !confirmed {
                return;
            }
            let _ = revoke_control.set_enabled(false);
            let _ = revoke_control.set_text("Disconnecting approved context…");
            let result = exporter.approved_context_revoke();
            let _ = revoke_control.set_text("Disconnect approved context…");
            let _ = revoke_control.set_enabled(true);
            match result {
                Ok(_) => notice(&app, "Approved context disconnected."),
                Err(code) => notice(&app, error_message(code)),
            }
        });
    } else if action == ACTION {
        let generation = match state.selection.lock() {
            Ok(mut state) => state.invalidate(),
            Err(_) => return true,
        };
        let app = app.clone();
        let exporter = exporter.clone();
        let control = control.clone();
        let state = state.clone();
        std::thread::spawn(move || {
            let _ = control.set_enabled(false);
            let _ = control.set_text("Loading approved contexts…");
            let result = (|| -> Result<Option<Submenu<tauri::Wry>>, &'static str> {
                let listing = exporter.approved_context_list()?;
                if !listing.linked || listing.choices.is_empty() {
                    notice(
                        &app,
                        if listing.linked {
                            "No approved project roots are available."
                        } else {
                            "No approved context is connected."
                        },
                    );
                    return Ok(None);
                }
                let popup = Submenu::with_id(
                    &app,
                    "approved-context-choices",
                    "Import approved context",
                    true,
                )
                .map_err(|_| "context_menu_unavailable")?;
                for (index, choice) in listing.choices.iter().enumerate() {
                    let item = MenuItem::with_id(
                        &app,
                        format!("{CHOICE_PREFIX}{generation}-{index}"),
                        menu_label(&choice.label, index),
                        true,
                        None::<&str>,
                    )
                    .map_err(|_| "context_menu_unavailable")?;
                    popup
                        .append(&item)
                        .map_err(|_| "context_menu_unavailable")?;
                }
                if !state
                    .selection
                    .lock()
                    .map_err(|_| "context_menu_unavailable")?
                    .install(generation, listing.choices, Instant::now())
                {
                    return Err("context_selection_stale");
                }
                Ok(Some(popup))
            })();
            let _ = control.set_text("Import approved context…");
            let _ = control.set_enabled(true);
            // A selected popup row gets the same busy flag in its own event.
            drop(reset);
            match result {
                Ok(Some(popup)) => {
                    if let Ok(mut retained) = state.popup.lock() {
                        *retained = Some(popup.clone());
                    }
                    let shown = app
                        .get_webview_window("workbench")
                        .ok_or("context_window_unavailable")
                        .and_then(|window| {
                            window
                                .popup_menu(&popup)
                                .map_err(|_| "context_menu_unavailable")
                        });
                    if shown.is_err() {
                        if let Ok(mut state) = state.selection.lock() {
                            state.invalidate();
                        }
                        notice(&app,"Could not open the project choices. Try Import approved context again.");
                    }
                }
                Ok(None) => {}
                Err(code) => notice(&app, error_message(code)),
            }
        });
    } else {
        let selection = state
            .selection
            .lock()
            .ok()
            .and_then(|mut state| state.take(action, Instant::now()));
        let Some(selection) = selection else {
            return true;
        };
        let app = app.clone();
        let exporter = exporter.clone();
        let control = control.clone();
        std::thread::spawn(move || {
            let _reset = reset;
            let _ = control.set_enabled(false);
            let _ = control.set_text("Importing approved context…");
            let result = exporter
                .approved_context_import(&selection)
                .and_then(|project| {
                    let window = app
                        .get_webview_window("workbench")
                        .ok_or("context_window_unavailable")?;
                    if !window
                        .url()
                        .is_ok_and(|url| crate::local_origin(&url) && url.path() == "/")
                    {
                        return Err("context_window_unavailable");
                    }
                    let project =
                        serde_json::to_string(&project).map_err(|_| "context_import_invalid")?;
                    window
                        .eval(format!(
                            "window.UptokeyHarnessWorkspaceImports.enqueue({project})"
                        ))
                        .map_err(|_| "context_navigation_unavailable")
                });
            let _ = control.set_text("Import approved context…");
            let _ = control.set_enabled(true);
            if let Err(code) = result {
                notice(&app, error_message(code));
            }
        });
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    fn selection() -> Selection {
        Selection {
            client_id: "419e988d-c7bc-4182-8ed0-70b939d93459".into(),
            link_revision: 2,
            conversation_id: "71fe68ab-6162-4f0a-a1ad-a8154963611f".into(),
            project_id: "project-synthetic".into(),
            root_binding_id: "root-synthetic".into(),
            root_revision: 3,
        }
    }
    fn choice() -> Choice {
        Choice {
            label: "Synthetic project / root".into(),
            selection: selection(),
        }
    }
    #[test]
    fn selection_is_finite_one_use_and_stale_after_refresh_or_expiry() {
        let now = Instant::now();
        let mut state = SelectionState::default();
        let first = state.invalidate();
        assert!(state.install(first, vec![choice()], now));
        assert!(state
            .take(&format!("{CHOICE_PREFIX}{first}-1"), now)
            .is_none());
        assert_eq!(
            state.take(&format!("{CHOICE_PREFIX}{first}-0"), now),
            Some(selection())
        );
        assert!(state
            .take(&format!("{CHOICE_PREFIX}{first}-0"), now)
            .is_none());
        let second = state.invalidate();
        assert!(!state.install(first, vec![choice()], now));
        assert!(state.install(second, vec![choice()], now));
        assert!(state
            .take(&format!("{CHOICE_PREFIX}{first}-0"), now)
            .is_none());
        assert!(state
            .take(
                &format!("{CHOICE_PREFIX}{second}-0"),
                now + SELECTION_LIFETIME + Duration::from_secs(1)
            )
            .is_none());
    }
    #[test]
    fn listing_rejects_unbounded_mixed_and_duplicate_authority() {
        let selected = serde_json::to_value(selection()).unwrap();
        let value =
            serde_json::json!({"linked":true,"choices":[{"label":"Root","selection":selected}]});
        assert!(parse_listing(value.clone()).is_ok());
        let mut duplicate = value.clone();
        duplicate["choices"]
            .as_array_mut()
            .unwrap()
            .push(value["choices"][0].clone());
        assert!(parse_listing(duplicate).is_err());
        let mut unlinked = value.clone();
        unlinked["linked"] = false.into();
        assert!(parse_listing(unlinked).is_err());
        let mut extra = value.clone();
        extra["choices"][0]["selection"]["token"] = "synthetic".into();
        assert!(parse_listing(extra).is_err());
        let mut mixed = value.clone();
        let mut other = value["choices"][0].clone();
        other["selection"]["linkRevision"] = 3.into();
        mixed["choices"].as_array_mut().unwrap().push(other);
        assert!(parse_listing(mixed).is_err());
        let mut oversized = value.clone();
        oversized["choices"] =
            serde_json::Value::Array(vec![value["choices"][0].clone(); MAX_CHOICES + 1]);
        assert!(parse_listing(oversized).is_err());
    }
    #[test]
    fn labels_and_import_paths_cannot_become_commands_or_escape_workspace() {
        assert_eq!(menu_label("A&B\nRoot\u{202e}", 0), "1. A&&BRoot");
        assert!(menu_label(&"x".repeat(300), 1).len() < 170);
        let valid = "/workspace/import-0123456789abcdef0123456789abcdef";
        assert_eq!(
            parse_import(serde_json::json!({"imported":true,"project":valid})),
            Ok(valid.into())
        );
        for path in [
            "/workspace/../private",
            "C:/private",
            "/workspace/import-0123456789ABCDEF0123456789ABCDEF",
            "/workspace/import-0123456789abcdef0123456789abcdef/x",
        ] {
            assert!(parse_import(serde_json::json!({"imported":true,"project":path})).is_err());
        }
    }
    #[test]
    fn revoke_receipt_is_exact_and_bounded() {
        assert_eq!(
            parse_revoke(
                serde_json::json!({"revoked":true,"clientId":"419e988d-c7bc-4182-8ed0-70b939d93459","revision":3})
            ),
            Ok(3)
        );
        for invalid in [
            serde_json::json!({"revoked":false,"clientId":"419e988d-c7bc-4182-8ed0-70b939d93459","revision":3}),
            serde_json::json!({"revoked":true,"clientId":"bad","revision":3}),
            serde_json::json!({"revoked":true,"clientId":"419e988d-c7bc-4182-8ed0-70b939d93459","revision":0}),
            serde_json::json!({"revoked":true,"clientId":"419e988d-c7bc-4182-8ed0-70b939d93459","revision":3,"token":"no"}),
        ] {
            assert!(parse_revoke(invalid).is_err());
        }
    }
    #[test]
    fn connection_receipts_are_exact_and_revision_bound() {
        let value = serde_json::json!({"challenge":{"id":"419e988d-c7bc-4182-8ed0-70b939d93459","userCode":"A1B2C3D4","expiresAt":"2026-10-25T04:30:00.000Z"},"expiresInMs":300000,"session":{"clientId":"71fe68ab-6162-4f0a-a1ad-a8154963611f","expectedRevision":2,"id":"419e988d-c7bc-4182-8ed0-70b939d93459","expiresAt":"2026-10-25T04:30:00.000Z"}});
        let begin = parse_connection_begin(value.clone()).unwrap();
        assert_eq!(
            parse_connection_complete(
                serde_json::json!({"connected":true,"clientId":begin.session.client_id,"revision":3}),
                &begin.session
            ),
            Ok(3)
        );
        let mut injected = value.clone();
        injected["session"]["token"] = "no".into();
        assert!(parse_connection_begin(injected).is_err());
        let mut mismatched = value.clone();
        mismatched["session"]["id"] = "71fe68ab-6162-4f0a-a1ad-a8154963611f".into();
        assert!(parse_connection_begin(mismatched).is_err());
        let mut dead = value.clone();
        dead["expiresInMs"] = 0.into();
        assert!(parse_connection_begin(dead).is_err());
        for receipt in [
            serde_json::json!({"connected":true,"clientId":begin.session.client_id,"revision":2}),
            serde_json::json!({"connected":true,"clientId":"419e988d-c7bc-4182-8ed0-70b939d93459","revision":3}),
        ] {
            assert!(parse_connection_complete(receipt, &begin.session).is_err());
        }
    }
}

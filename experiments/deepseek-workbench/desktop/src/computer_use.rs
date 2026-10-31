//! One explicit native-window grant. No renderer command can select a window.
use crate::diagnostics::Exporter;
use serde::Deserialize;
use std::{
    collections::HashSet,
    io::{Read, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{MenuItem, Submenu},
    AppHandle, Manager,
};
use tauri_plugin_dialog::DialogExt;

#[path = "computer_focus.rs"]
mod computer_focus;
#[cfg(windows)]
#[path = "computer_job.rs"]
mod computer_job;

const REFRESH: &str = "computer-use-refresh";
const STOP: &str = "computer-use-stop";
const CHOICE: &str = "computer-use-window-";
const MAX_WINDOWS: usize = 128;
const MAX_LIST_BYTES: usize = 128 * 1024;
const MAX_STATUS_BYTES: usize = 4096;
const SELECTION_TTL: Duration = Duration::from_secs(60);
const STOP_GRACE: Duration = Duration::from_secs(8);

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WindowChoice {
    id: u32,
    pid: u32,
    title: String,
    app: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    focused: bool,
    minimized: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WindowListing {
    schema: String,
    platform: String,
    windows: Vec<WindowChoice>,
}

fn parse_listing(raw: &[u8]) -> Result<Vec<WindowChoice>, &'static str> {
    if raw.len() > MAX_LIST_BYTES {
        return Err("computer-window-list-invalid");
    }
    let listing: WindowListing =
        serde_json::from_slice(raw).map_err(|_| "computer-window-list-invalid")?;
    if listing.schema != "uptokey.computer.windows.v1"
        || !matches!(listing.platform.as_str(), "windows" | "linux" | "macos")
        || listing.windows.len() > MAX_WINDOWS
    {
        return Err("computer-window-list-invalid");
    }
    let mut ids = HashSet::new();
    for choice in &listing.windows {
        if choice.id == 0
            || choice.pid == 0
            || !ids.insert(choice.id)
            || choice.title.len() > 4096
            || choice.app.len() > 1024
            || choice.width > 65536
            || choice.height > 65536
        {
            return Err("computer-window-list-invalid");
        }
        // Geometry/focus are validated again by the native backend on every action.
        let _ = (choice.x, choice.y, choice.focused, choice.minimized);
    }
    Ok(listing.windows)
}

fn window_label(choice: &WindowChoice) -> String {
    let raw = if choice.title.trim().is_empty() {
        &choice.app
    } else {
        &choice.title
    };
    let text: String = raw
        .chars()
        .filter(|c| {
            !c.is_control() && !matches!(*c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
        .take(100)
        .collect();
    format!(
        "{} · PID {} · #{}",
        text.trim().replace('&', "&&"),
        choice.pid,
        choice.id
    )
}

#[derive(Default)]
struct Choices {
    generation: u64,
    pending: Option<(Instant, Vec<WindowChoice>)>,
}
impl Choices {
    fn invalidate(&mut self) -> u64 {
        self.generation = self.generation.wrapping_add(1);
        self.pending = None;
        self.generation
    }
    fn install(&mut self, generation: u64, windows: Vec<WindowChoice>, now: Instant) -> bool {
        if self.generation != generation {
            return false;
        }
        self.pending = Some((now, windows));
        true
    }
    fn take(&mut self, action: &str, now: Instant) -> Option<WindowChoice> {
        let (generation, index) = action.strip_prefix(CHOICE)?.split_once('-')?;
        let generation = generation.parse::<u64>().ok()?;
        let index = index.parse::<usize>().ok()?;
        if action != format!("{CHOICE}{generation}-{index}") || generation != self.generation {
            return None;
        }
        let (created, choices) = self.pending.as_ref()?;
        if now
            .checked_duration_since(*created)
            .is_none_or(|age| age > SELECTION_TTL)
        {
            self.pending = None;
            return None;
        }
        let selected = choices.get(index)?.clone();
        self.pending = None;
        Some(selected)
    }
}

struct SessionProcess {
    child: Child,
    stdin: Option<ChildStdin>,
    #[cfg(windows)]
    job: Option<computer_job::OwnedJob>,
}
impl SessionProcess {
    fn spawn(command: &mut Command) -> Result<Self, &'static str> {
        #[cfg(windows)]
        let (mut child, job) = computer_job::OwnedJob::spawn(command)?;
        #[cfg(not(windows))]
        let mut child = command
            .spawn()
            .map_err(|_| "computer-session-unavailable")?;
        let stdin = child.stdin.take();
        Ok(Self {
            child,
            stdin,
            #[cfg(windows)]
            job: Some(job),
        })
    }

    fn close(&mut self) {
        // EOF is the revocation signal. The owner closes relay/native input
        // before removing its ephemeral profile and forwarding artifacts.
        self.stdin.take();
        let deadline = Instant::now() + STOP_GRACE;
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20))
                }
                _ => {
                    let _ = self.child.kill();
                    let _ = self.child.wait();
                    break;
                }
            }
        }
        // A crashed helper cannot run its Node exit hooks. Release its job
        // even when the helper has already exited, terminating surviving SSH
        // and native descendants. Desktop crashes close the same OS handle.
        #[cfg(windows)]
        self.job.take();
    }
}
impl Drop for SessionProcess {
    fn drop(&mut self) {
        self.close();
    }
}

#[derive(Default)]
struct StateData {
    choices: Choices,
    epoch: u64,
    closed: bool,
    process: Option<(u64, SessionProcess)>,
    focus: computer_focus::Pending,
    #[cfg(windows)]
    selection: Option<computer_focus::Selection>,
    popup: Option<Submenu<tauri::Wry>>,
    controls: Option<Controls>,
}
#[derive(Clone, Default)]
pub struct NativeState(Arc<Mutex<StateData>>);
impl NativeState {
    fn revoke(&self, permanent: bool) -> Option<SessionProcess> {
        let mut state = self.0.lock().ok()?;
        state.closed |= permanent;
        state.epoch = state.epoch.wrapping_add(1);
        state.choices.invalidate();
        state.popup = None;
        state.focus = computer_focus::Pending::default();
        #[cfg(windows)]
        {
            state.selection = None;
        }
        state.process.take().map(|(_, process)| process)
    }
    pub fn shutdown(&self, permanent: bool) {
        let process = self.revoke(permanent);
        let controls = self.0.lock().ok().and_then(|state| state.controls.clone());
        if let Some(controls) = controls {
            controls.stopped();
        }
        drop(process);
    }
    fn current(&self, epoch: u64) -> bool {
        self.0
            .lock()
            .is_ok_and(|state| !state.closed && state.epoch == epoch)
    }
    fn finish(&self, epoch: u64) -> bool {
        let process = {
            let Ok(mut state) = self.0.lock() else {
                return false;
            };
            if state.epoch != epoch {
                return false;
            }
            state.focus = computer_focus::Pending::default();
            #[cfg(windows)]
            {
                state.selection = None;
            }
            state.process.take().map(|(_, process)| process)
        };
        drop(process);
        true
    }
}

#[derive(Clone)]
pub struct Controls {
    pub submenu: Submenu<tauri::Wry>,
    refresh: MenuItem<tauri::Wry>,
    stop: MenuItem<tauri::Wry>,
    status: MenuItem<tauri::Wry>,
}
impl Controls {
    pub fn new(app: &AppHandle) -> tauri::Result<Self> {
        let refresh = MenuItem::with_id(app, REFRESH, "Refresh windows…", true, None::<&str>)?;
        let stop = MenuItem::with_id(app, STOP, "Stop computer use", false, None::<&str>)?;
        let status = MenuItem::with_id(
            app,
            "computer-use-status",
            "Disabled — choose a window",
            false,
            None::<&str>,
        )?;
        let submenu = Submenu::with_items(app, "Computer use", true, &[&status, &refresh, &stop])?;
        let controls = Self {
            submenu,
            refresh,
            stop,
            status,
        };
        if let Ok(mut state) = app.state::<NativeState>().0.lock() {
            state.controls = Some(controls.clone());
        }
        Ok(controls)
    }
    fn stopped(&self) {
        let _ = self.status.set_text("Disabled — choose a window");
        let _ = self.stop.set_enabled(false);
    }
}

fn notice(app: &AppHandle, message: &str) {
    app.dialog()
        .message(message)
        .title("Computer use")
        .blocking_show();
}

fn run_listing(mut command: Command) -> Result<Vec<WindowChoice>, &'static str> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command.spawn().map_err(|_| "computer-list-unavailable")?;
    let stdout = child.stdout.take().ok_or("computer-list-unavailable")?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut data = Vec::new();
        let result = stdout
            .take((MAX_LIST_BYTES + 1) as u64)
            .read_to_end(&mut data)
            .map_err(|_| "computer-list-unavailable")
            .map(|_| data);
        let _ = tx.send(result);
    });
    let deadline = Instant::now() + Duration::from_secs(15);
    let result = loop {
        match rx.try_recv() {
            Ok(Ok(data)) => {
                if data.len() > MAX_LIST_BYTES {
                    break Err("computer-window-list-invalid");
                }
                let status = loop {
                    match child.try_wait() {
                        Ok(Some(status)) => break Ok(status),
                        Ok(None) if Instant::now() < deadline => {
                            std::thread::sleep(Duration::from_millis(20))
                        }
                        _ => break Err("computer-list-unavailable"),
                    }
                };
                break status.and_then(|status| {
                    if status.success() {
                        parse_listing(&data)
                    } else {
                        Err("computer-list-unavailable")
                    }
                });
            }
            Ok(Err(error)) => break Err(error),
            Err(mpsc::TryRecvError::Disconnected) => break Err("computer-list-unavailable"),
            Err(mpsc::TryRecvError::Empty) => {}
        }
        if Instant::now() >= deadline {
            break Err("computer-list-timeout");
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    if result.is_err() {
        let _ = child.kill();
        let _ = child.wait();
    }
    result
}

fn valid_ready(raw: &[u8], choice: &WindowChoice, now_ms: u64) -> bool {
    if raw.len() > MAX_STATUS_BYTES {
        return false;
    }
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(raw) else {
        return false;
    };
    let Some(object) = value.as_object() else {
        return false;
    };
    object.len() == 6
        && value["ready"] == true
        && value["enabled"] == true
        && value["windowId"].as_u64() == Some(u64::from(choice.id))
        && value["pid"].as_u64() == Some(u64::from(choice.pid))
        && value["leaseId"].as_str().is_some_and(|lease| {
            lease.len() == 32
                && lease
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
        && value["expiresAt"].as_u64().is_some_and(|expires| {
            expires > now_ms && expires <= now_ms.saturating_add(15 * 60 * 1000)
        })
}

#[derive(Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
enum FocusFrame {
    #[serde(rename = "focus-closed")]
    Closed {},
    #[serde(rename = "focus-register")]
    Register { ticket: computer_focus::Ticket },
    #[serde(rename = "focus-cancel")]
    Cancel { id: String },
}
fn focus_ack(data: &mut StateData, epoch: u64, kind: &str, id: &str) -> Result<(), &'static str> {
    let Some((active, process)) = data.process.as_mut() else {
        return Err("computer-focus-unavailable");
    };
    if *active != epoch
        || process
            .child
            .try_wait()
            .map_err(|_| "computer-focus-unavailable")?
            .is_some()
    {
        return Err("computer-focus-unavailable");
    }
    let input = process.stdin.as_mut().ok_or("computer-focus-unavailable")?;
    let frame = serde_json::json!({"type":kind,"id":id}).to_string() + "\n";
    input
        .write_all(frame.as_bytes())
        .map_err(|_| "computer-focus-unavailable")?;
    input.flush().map_err(|_| "computer-focus-unavailable")
}
fn accept_focus_frame(
    state: &NativeState,
    epoch: u64,
    raw: &[u8],
    now: u64,
) -> Result<(), &'static str> {
    if raw.len() > MAX_STATUS_BYTES {
        return Err("computer-status-invalid");
    }
    let frame: FocusFrame = serde_json::from_slice(raw).map_err(|_| "computer-status-invalid")?;
    let mut data = state.0.lock().map_err(|_| "computer-session-unavailable")?;
    if data.closed || data.epoch != epoch {
        return Err("computer-focus-unavailable");
    }
    match frame {
        FocusFrame::Closed {} => {
            data.focus = computer_focus::Pending::default();
            #[cfg(windows)]
            {
                data.selection = None;
            }
            Err("computer-focus-unavailable")
        }
        FocusFrame::Register { ticket } => {
            if !cfg!(windows) {
                return Err("computer-focus-unavailable");
            }
            let id = ticket.id.clone();
            data.focus.register(ticket, now)?;
            focus_ack(&mut data, epoch, "focus-registered", &id)
        }
        FocusFrame::Cancel { id } => data.focus.cancel(&id),
    }
}

/// The renderer supplies only a Host-registered, exact correlation ticket. It
/// cannot select a target, register a request, extend a lease or provide a PID.
#[tauri::command]
pub fn harness_computer_approve_focus(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, NativeState>,
    ticket: serde_json::Value,
) -> Result<(), String> {
    crate::account_bridge::admit_window(&window)?;
    #[cfg(not(windows))]
    {
        let _ = (state, ticket);
        Err("computer-focus-unavailable".to_owned())
    }
    #[cfg(windows)]
    {
        let ticket: computer_focus::Ticket = serde_json::from_value(ticket)
            .map_err(|_| "computer-focus-ticket-invalid".to_owned())?;
        let owner = window
            .hwnd()
            .map_err(|_| "computer-focus-owner-unavailable".to_owned())?
            .0;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "computer-clock-invalid".to_owned())?
            .as_millis() as u64;
        let mut data = state
            .0
            .lock()
            .map_err(|_| "computer-focus-unavailable".to_owned())?;
        let epoch = data.epoch;
        if data.closed {
            return Err("computer-focus-unavailable".to_owned());
        }
        data.focus.consume(&ticket, now).map_err(str::to_owned)?;
        let alive = match data.process.as_mut() {
            Some((active, process)) => {
                *active == epoch && matches!(process.child.try_wait(), Ok(None))
            }
            None => false,
        };
        let result = if alive {
            data.selection
                .as_ref()
                .ok_or("computer-focus-target-unavailable")
                .and_then(|selection| selection.focus(owner))
        } else {
            Err("computer-focus-unavailable")
        };
        let ack = focus_ack(
            &mut data,
            epoch,
            if result.is_ok() {
                "focus-approved"
            } else {
                "focus-denied"
            },
            &ticket.id,
        );
        if ack.is_err() {
            data.epoch = data.epoch.wrapping_add(1);
            data.focus = computer_focus::Pending::default();
            data.selection = None;
            let process = data.process.take().map(|(_, process)| process);
            let controls = data.controls.clone();
            drop(data);
            if let Some(controls) = controls {
                controls.stopped();
            }
            std::thread::spawn(move || drop(process));
            return Err("computer-focus-unavailable".to_owned());
        }
        result.map_err(str::to_owned)
    }
}

/// Stop always works, including during a pending list, startup or approval.
pub fn handle_event(
    action: &str,
    app: &AppHandle,
    exporter: &Exporter,
    controls: &Controls,
) -> bool {
    if action != REFRESH && action != STOP && !action.starts_with(CHOICE) {
        return false;
    }
    let state = app.state::<NativeState>().inner().clone();
    if action == STOP {
        let process = state.revoke(false);
        controls.stopped();
        std::thread::spawn(move || drop(process));
        return true;
    }
    if action == REFRESH {
        let generation = match state.0.lock() {
            Ok(mut data) if !data.closed => data.choices.invalidate(),
            _ => return true,
        };
        let _ = controls.refresh.set_enabled(false);
        let app = app.clone();
        let exporter = exporter.clone();
        let controls = controls.clone();
        std::thread::spawn(move || {
            let result = exporter.computer_list_command().and_then(run_listing);
            let _ = controls.refresh.set_enabled(true);
            match result {
                Ok(windows) => {
                    if windows.is_empty() { notice(&app, "No controllable windows are available."); return; }
                    let popup = (|| {
                        let popup = Submenu::with_id(&app, "computer-use-choices", "Choose one window", true).ok()?;
                        for (index, choice) in windows.iter().enumerate() {
                            let item = MenuItem::with_id(&app, format!("{CHOICE}{generation}-{index}"), window_label(choice), true, None::<&str>).ok()?;
                            popup.append(&item).ok()?;
                        }
                        let mut data = state.0.lock().ok()?;
                        if data.closed || !data.choices.install(generation, windows, Instant::now()) { return None; }
                        data.popup = Some(popup.clone()); Some(popup)
                    })();
                    if let Some(popup) = popup {
                        let shown = app.get_webview_window("workbench").is_some_and(|window| window.popup_menu(&popup).is_ok());
                        if !shown { if let Ok(mut data) = state.0.lock() { data.choices.invalidate(); } }
                    }
                }
                Err(_) => notice(&app, "Could not list windows. Check the operating system screen capture and accessibility permissions, then refresh."),
            }
        });
        return true;
    }
    let start = {
        let Ok(mut data) = state.0.lock() else {
            return true;
        };
        if data.closed {
            return true;
        }
        let Some(choice) = data.choices.take(action, Instant::now()) else {
            return true;
        };
        data.epoch = data.epoch.wrapping_add(1);
        data.focus = computer_focus::Pending::default();
        #[cfg(windows)]
        {
            data.selection = None;
        }
        Some((
            choice,
            data.epoch,
            data.process.take().map(|(_, process)| process),
        ))
    };
    let Some((choice, epoch, previous)) = start else {
        return true;
    };
    let _ = controls.status.set_text("Connecting selected window…");
    let _ = controls.stop.set_enabled(true);
    let app = app.clone();
    let exporter = exporter.clone();
    let controls = controls.clone();
    std::thread::spawn(move || {
        drop(previous);
        if !state.current(epoch) {
            return;
        }
        let result = start_session(&exporter, &choice, epoch, &state, &controls);
        if state.finish(epoch) {
            controls.stopped();
            if result.is_err() {
                notice(
                    &app,
                    "Computer use stopped. Refresh windows to select a window again.",
                );
            }
        }
    });
    true
}

fn start_session(
    exporter: &Exporter,
    choice: &WindowChoice,
    epoch: u64,
    state: &NativeState,
    controls: &Controls,
) -> Result<(), &'static str> {
    #[cfg(windows)]
    let selection = computer_focus::Selection::pin(choice.id, choice.pid)?;
    let mut command = exporter.computer_session_command(choice.id, choice.pid)?;
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut process = SessionProcess::spawn(&mut command)?;
    let stdout = process
        .child
        .stdout
        .take()
        .ok_or("computer-session-unavailable")?;
    {
        let mut data = state.0.lock().map_err(|_| "computer-session-unavailable")?;
        if data.closed || data.epoch != epoch {
            drop(data);
            drop(process);
            return Ok(());
        }
        data.process = Some((epoch, process));
        #[cfg(windows)]
        {
            data.selection = Some(selection);
        }
    }
    let (tx, rx) = mpsc::sync_channel(8);
    std::thread::spawn(move || {
        let mut stdout = std::io::BufReader::new(stdout);
        loop {
            let mut line = Vec::new();
            let mut complete = false;
            for byte in stdout.by_ref().take((MAX_STATUS_BYTES + 1) as u64).bytes() {
                match byte {
                    Ok(b'\n') => {
                        complete = true;
                        break;
                    }
                    Ok(byte) if line.len() < MAX_STATUS_BYTES => line.push(byte),
                    _ => break,
                }
            }
            // Only bounded, known frames are accepted below. EOF, oversized
            // output or a partial line revokes the native selection.
            if !complete {
                let _ = tx.send(Err("computer-status-invalid"));
                return;
            }
            if tx.send(Ok(line)).is_err() {
                return;
            }
        }
    });
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut ready = false;
    let mut active_deadline = None;
    loop {
        if !state.current(epoch) {
            return Ok(());
        }
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "computer-clock-invalid")?
            .as_millis() as u64;
        match rx.try_recv() {
            Ok(Ok(raw)) if !ready && valid_ready(&raw, choice, now_ms) => {
                ready = true;
                let receipt: serde_json::Value =
                    serde_json::from_slice(&raw).map_err(|_| "computer-status-invalid")?;
                let expires = receipt["expiresAt"]
                    .as_u64()
                    .ok_or("computer-status-invalid")?;
                active_deadline = Some(Instant::now() + Duration::from_millis(expires - now_ms));
                let lease = receipt["leaseId"]
                    .as_str()
                    .ok_or("computer-status-invalid")?;
                let mut data = state.0.lock().map_err(|_| "computer-session-unavailable")?;
                if data.epoch != epoch || data.closed {
                    return Ok(());
                }
                data.focus.ready(lease, expires)?;
                let _ = controls
                    .status
                    .set_text(format!("Active: {}", window_label(choice)));
            }
            Ok(Ok(raw)) if ready => accept_focus_frame(state, epoch, &raw, now_ms)?,
            Ok(_) => return Err("computer-status-invalid"),
            Err(mpsc::TryRecvError::Disconnected) if !ready => {
                return Err("computer-status-invalid")
            }
            Err(mpsc::TryRecvError::Disconnected) => {}
            Err(mpsc::TryRecvError::Empty) => {}
        }
        if !ready && Instant::now() >= deadline {
            return Err("computer-start-timeout");
        }
        if active_deadline.is_some_and(|deadline| Instant::now() >= deadline) {
            return Ok(());
        }
        let running = {
            let mut data = state.0.lock().map_err(|_| "computer-session-unavailable")?;
            match data.process.as_mut() {
                Some((active, process)) if *active == epoch => process
                    .child
                    .try_wait()
                    .map_err(|_| "computer-session-unavailable")?
                    .is_none(),
                _ => return Ok(()),
            }
        };
        if !running {
            return if ready {
                Ok(())
            } else {
                Err("computer-session-unavailable")
            };
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn focus_pipe_frames_are_exact_and_never_accept_a_target_from_renderer() {
        for raw in [
            r#"{"type":"focus-closed","id":"extra"}"#,
            r#"{"type":"focus-cancel","id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","pid":42}"#,
            r#"{"type":"focus-approved","id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"#,
            r#"{"ready":true,"windowId":23,"pid":42}"#,
        ] {
            assert!(serde_json::from_str::<FocusFrame>(raw).is_err());
        }
        assert!(serde_json::from_str::<FocusFrame>(r#"{"type":"focus-closed"}"#).is_ok());
    }
    fn choice() -> WindowChoice {
        WindowChoice {
            id: 23,
            pid: 42,
            title: "Fixture".into(),
            app: "fixture".into(),
            x: 0,
            y: 0,
            width: 320,
            height: 200,
            focused: true,
            minimized: false,
        }
    }
    fn listing() -> serde_json::Value {
        serde_json::json!({"schema":"uptokey.computer.windows.v1","platform":"windows","windows":[{"id":23,"pid":42,"title":"Fixture","app":"fixture","x":0,"y":0,"width":320,"height":200,"focused":true,"minimized":false}]})
    }
    #[test]
    fn listing_rejects_duplicate_identity_and_unbounded_or_unknown_data() {
        assert_eq!(
            parse_listing(&serde_json::to_vec(&listing()).unwrap()).unwrap()[0].id,
            23
        );
        let mut duplicate = listing();
        let row = duplicate["windows"][0].clone();
        duplicate["windows"].as_array_mut().unwrap().push(row);
        assert!(parse_listing(&serde_json::to_vec(&duplicate).unwrap()).is_err());
        for (key, value) in [
            ("pid", serde_json::json!(0)),
            ("title", serde_json::json!("x".repeat(4097))),
            ("unexpected", serde_json::json!(true)),
        ] {
            let mut invalid = listing();
            invalid["windows"][0][key] = value;
            assert!(parse_listing(&serde_json::to_vec(&invalid).unwrap()).is_err());
        }
    }
    #[test]
    fn native_selection_is_single_use_expires_and_cannot_be_replayed_after_refresh() {
        let mut choices = Choices::default();
        let now = Instant::now();
        let generation = choices.invalidate();
        assert!(choices.install(generation, vec![choice()], now));
        let action = format!("{CHOICE}{generation}-0");
        assert!(choices.take(&action, now).is_some());
        assert!(choices.take(&action, now).is_none());
        let generation = choices.invalidate();
        choices.install(generation, vec![choice()], now);
        assert!(choices
            .take(
                &format!("{CHOICE}{generation}-0"),
                now + SELECTION_TTL + Duration::from_millis(1)
            )
            .is_none());
        let old = choices.invalidate();
        let new = choices.invalidate();
        assert!(!choices.install(old, vec![choice()], now));
        assert!(choices.install(new, vec![choice()], now));
        assert!(choices.take(&format!("{CHOICE}{old}-0"), now).is_none());
    }
    #[test]
    fn stop_invalidates_inflight_start_and_shutdown_never_admits_a_late_selection() {
        let state = NativeState::default();
        assert!(state.current(0));
        state.shutdown(false);
        assert!(!state.current(0));
        assert!(state.current(1));
        state.shutdown(true);
        assert!(!state.current(2));
        let mut data = state.0.lock().unwrap();
        let generation = data.choices.invalidate();
        assert!(data.closed);
        assert!(data.process.is_none());
        assert!(data.choices.pending.is_none());
        assert!(generation > 0);
    }
    #[test]
    fn status_binds_exact_selected_window_and_does_not_accept_extra_fields() {
        let mut status = serde_json::json!({"ready":true,"enabled":true,"windowId":23,"pid":42,"expiresAt":15000,"leaseId":"a".repeat(32)});
        assert!(valid_ready(
            &serde_json::to_vec(&status).unwrap(),
            &choice(),
            10000
        ));
        assert!(!valid_ready(
            &serde_json::to_vec(&status).unwrap(),
            &choice(),
            15000
        ));
        status["expiresAt"] = serde_json::json!(910001);
        assert!(!valid_ready(
            &serde_json::to_vec(&status).unwrap(),
            &choice(),
            10000
        ));
        status["expiresAt"] = serde_json::json!(15000);
        status["pid"] = serde_json::json!(43);
        assert!(!valid_ready(
            &serde_json::to_vec(&status).unwrap(),
            &choice(),
            10000
        ));
        status["pid"] = serde_json::json!(42);
        status["token"] = serde_json::json!("not-allowed");
        assert!(!valid_ready(
            &serde_json::to_vec(&status).unwrap(),
            &choice(),
            10000
        ));
        assert!(!window_label(&WindowChoice {
            title: "A\n&\u{202e}B".into(),
            ..choice()
        })
        .contains('\n'));
    }
    #[test]
    fn process_shutdown_closes_stdin_before_waiting_for_exit() {
        #[cfg(windows)]
        let mut command = {
            let mut c = Command::new("cmd.exe");
            c.args(["/d", "/c", "more > nul"]);
            c
        };
        #[cfg(not(windows))]
        let mut command = {
            let mut c = Command::new("/bin/sh");
            c.args(["-c", "cat >/dev/null"]);
            c
        };
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut process = SessionProcess::spawn(&mut command).unwrap();
        let start = Instant::now();
        process.close();
        assert!(process.stdin.is_none());
        assert!(process.child.try_wait().unwrap().is_some());
        assert!(start.elapsed() < STOP_GRACE);
    }
}

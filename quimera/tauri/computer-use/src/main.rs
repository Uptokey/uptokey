use base64::{Engine, engine::general_purpose::STANDARD};
use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use rmcp::{
    ErrorData, RoleServer, ServerHandler, ServiceExt, model::*, service::RequestContext,
    transport::stdio,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    io::Cursor,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use uptokey_desktop_computer::*;
use xcap::Window;

#[cfg(windows)]
mod accessibility;
#[cfg(windows)]
mod fixture;
#[cfg(any(target_os = "macos", target_os = "linux", test))]
mod manual_focus;

type Result<T> = std::result::Result<T, &'static str>;

#[derive(Clone)]
struct Server {
    state: Arc<State>,
}
struct State {
    target: Option<Target>,
    observed: Mutex<Option<(Observation, Instant)>>,
    serial: Mutex<()>,
    sequence: AtomicU64,
    revoked: AtomicBool,
    started: Instant,
    #[cfg(windows)]
    process: Option<ProcessIdentity>,
}

#[cfg(windows)]
struct ProcessIdentity(isize);
#[cfg(windows)]
impl ProcessIdentity {
    fn open(pid: u32) -> Result<Self> {
        use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE};
        // A window grant needs only a stable kernel object for lifetime checks.
        // Querying process metadata is unnecessary and can be denied by an
        // otherwise valid target DACL. SYNCHRONIZE is the least-privilege right
        // that pins this exact process incarnation and supports a non-blocking
        // liveness check, so PID reuse cannot retarget the grant.
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
        if handle.is_null() {
            return Err("target_process_unavailable");
        }
        Ok(Self(handle as isize))
    }
    fn alive(&self) -> bool {
        use windows_sys::Win32::{
            Foundation::WAIT_TIMEOUT, System::Threading::WaitForSingleObject,
        };
        unsafe { WaitForSingleObject(self.0 as _, 0) == WAIT_TIMEOUT }
    }
}

#[cfg(all(test, windows))]
mod process_identity_tests {
    use super::ProcessIdentity;

    #[test]
    fn current_process_can_be_pinned_with_synchronize_only() {
        let identity = ProcessIdentity::open(std::process::id()).expect("current process pin");
        assert!(identity.alive());
    }
}
#[cfg(windows)]
impl Drop for ProcessIdentity {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0 as _);
        }
    }
}

fn info(w: &Window) -> Result<WindowInfo> {
    Ok(WindowInfo {
        id: w.id().map_err(|_| "window_metadata_unavailable")?,
        pid: w.pid().map_err(|_| "window_metadata_unavailable")?,
        title: w.title().map_err(|_| "window_metadata_unavailable")?,
        app: w.app_name().map_err(|_| "window_metadata_unavailable")?,
        x: w.x().map_err(|_| "window_metadata_unavailable")?,
        y: w.y().map_err(|_| "window_metadata_unavailable")?,
        width: w.width().map_err(|_| "window_metadata_unavailable")?,
        height: w.height().map_err(|_| "window_metadata_unavailable")?,
        focused: w.is_focused().map_err(|_| "window_focus_unavailable")?,
        minimized: w
            .is_minimized()
            .map_err(|_| "window_metadata_unavailable")?,
    })
}

fn windows() -> Result<Vec<WindowInfo>> {
    platform_supported()?;
    Ok(Window::all()
        .map_err(|_| "window_enumeration_denied")?
        .iter()
        .filter_map(|w| info(w).ok())
        .filter(|w| w.width > 0 && w.height > 0)
        .take(128)
        .collect())
}
fn platform_supported() -> Result<()> {
    #[cfg(target_os = "linux")]
    if std::env::var_os("WAYLAND_DISPLAY").is_some()
        || std::env::var("XDG_SESSION_TYPE").is_ok_and(|x| x == "wayland")
    {
        return Err("wayland_window_grants_unavailable_use_x11");
    }
    Ok(())
}

struct Frame {
    observation: Observation,
    png: Vec<u8>,
}
impl Frame {
    fn result(self, receipt: Value) -> CallToolResult {
        CallToolResult::success(vec![
            ContentBlock::text(
                json!({"observation":self.observation,"receipt":receipt}).to_string(),
            ),
            ContentBlock::image(STANDARD.encode(self.png), "image/png"),
        ])
    }
}

impl Server {
    fn new(target: Option<Target>) -> Result<Self> {
        platform_supported()?;
        #[cfg(windows)]
        let process = target.map(|t| ProcessIdentity::open(t.pid)).transpose()?;
        let server = Self {
            state: Arc::new(State {
                target,
                observed: Mutex::new(None),
                serial: Mutex::new(()),
                sequence: AtomicU64::new(0),
                revoked: AtomicBool::new(false),
                started: Instant::now(),
                #[cfg(windows)]
                process,
            }),
        };
        if target.is_some() {
            server.window(false)?;
        }
        Ok(server)
    }
    fn window(&self, input: bool) -> Result<(Window, WindowInfo)> {
        if self.state.revoked.load(Ordering::Acquire) {
            return Err("grant_revoked");
        }
        if self.state.started.elapsed() > Duration::from_secs(15 * 60) {
            return Err("grant_expired_select_window_again");
        }
        let target = self
            .state
            .target
            .ok_or("no_window_grant_select_in_native_ui")?;
        #[cfg(windows)]
        if !self
            .state
            .process
            .as_ref()
            .is_some_and(ProcessIdentity::alive)
        {
            return Err("target_process_exited");
        }
        let all = Window::all().map_err(|_| "window_enumeration_denied")?;
        // XCap's macOS focus predicate identifies the foreground application. Also
        // require its foremost window to be the grant, so a sibling cannot receive typing.
        #[cfg(target_os = "macos")]
        let foremost_window = all
            .iter()
            .find(|w| w.pid().ok() == Some(target.pid))
            .and_then(|w| w.id().ok());
        let w = all
            .into_iter()
            .find(|w| w.id().ok() == Some(target.id) && w.pid().ok() == Some(target.pid))
            .ok_or("target_window_closed")?;
        let meta = info(&w)?;
        validate_window(target, &meta, input)?;
        // A missing/replaced/invisible target is terminal even while waiting
        // for a manual return; only an existing target may wait for foreground.
        #[cfg(target_os = "macos")]
        if input && foremost_window != Some(target.id) {
            return Err("target_not_foreground");
        }
        Ok((w, meta))
    }
    fn frame(&self, input: bool) -> Result<Frame> {
        let (w, meta) = self.window(input)?;
        let image = w.capture_image().map_err(|_| "window_capture_denied")?;
        // Never return pixels if target identity or geometry changed during capture.
        let (_, after) = self.window(input)?;
        if meta.id != after.id
            || meta.pid != after.pid
            || meta.x != after.x
            || meta.y != after.y
            || meta.width != after.width
            || meta.height != after.height
        {
            return Err("target_changed_during_capture");
        }
        if image.width() == 0
            || image.height() == 0
            || u64::from(image.width()) * u64::from(image.height()) > MAX_SOURCE_PIXELS
        {
            return Err("capture_dimensions_out_of_range");
        }
        let image = image::DynamicImage::ImageRgba8(image);
        let image = if image.width() > MAX_FRAME_WIDTH || image.height() > MAX_FRAME_HEIGHT {
            image.thumbnail(MAX_FRAME_WIDTH, MAX_FRAME_HEIGHT)
        } else {
            image
        };
        let hash = format!("{:x}", Sha256::digest(image.as_bytes()));
        let mut png = Cursor::new(Vec::new());
        image
            .write_to(&mut png, image::ImageFormat::Png)
            .map_err(|_| "capture_encoding_failed")?;
        let png = png.into_inner();
        if png.len() > MAX_PNG_BYTES {
            return Err("capture_too_large");
        }
        let seq = self.state.sequence.fetch_add(1, Ordering::Relaxed) + 1;
        let observation = Observation {
            token: format!("{seq}-{}", &hash[..16]),
            target: Target {
                id: meta.id,
                pid: meta.pid,
            },
            x: meta.x,
            y: meta.y,
            width: meta.width,
            height: meta.height,
            image_width: image.width(),
            image_height: image.height(),
            sha256: hash,
        };
        Ok(Frame { observation, png })
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    fn focus_granted_target(&self) -> Result<()> {
        let (_, meta) = self.window(false)?;
        if meta.focused {
            return Ok(());
        }
        #[cfg(windows)]
        {
            use windows_sys::Win32::UI::WindowsAndMessaging::{
                GetForegroundWindow, SetForegroundWindow,
            };
            let hwnd = meta.id as usize as _;
            // Request normal OS focus for the exact grant. No input attachment,
            // foreground-lock change, privilege change or synthetic shortcut fallback.
            unsafe {
                SetForegroundWindow(hwnd);
            }
            std::thread::sleep(Duration::from_millis(40));
            if unsafe { GetForegroundWindow() } != hwnd {
                return Err("os_refused_target_focus");
            }
            self.window(true)?;
            return Ok(());
        }
        #[cfg(not(windows))]
        {
            Err("target_not_foreground")
        }
    }
    fn execute(
        &self,
        name: &str,
        args: Value,
        context: &RequestContext<RoleServer>,
    ) -> Result<CallToolResult> {
        let _serial = self.state.serial.try_lock().map_err(|_| "computer_busy")?;
        if name == "computer_windows" {
            exact_fields(&args, &[])?;
            let granted = self.window(false).ok().map(|(_, i)| i);
            return Ok(CallToolResult::success(vec![ContentBlock::text(json!({"schema":"uptokey.computer.windows.v1","windows":granted.into_iter().collect::<Vec<_>>(),"granted":self.state.target,"platform":std::env::consts::OS}).to_string())]));
        }
        let target = self
            .state
            .target
            .ok_or("no_window_grant_select_in_native_ui")?;
        if args.get("window_id").and_then(Value::as_u64) != Some(u64::from(target.id)) {
            return Err("window_not_granted");
        }
        if context.ct.is_cancelled() {
            return Err("request_cancelled");
        }
        if name == "computer_snapshot" {
            exact_fields(&args, &["window_id"])?;
            let (_, meta) = self.window(false)?;
            #[cfg(windows)]
            {
                let snapshot = accessibility::snapshot(target, &meta, || {
                    context.ct.is_cancelled() || self.state.revoked.load(Ordering::Acquire)
                })?;
                self.window(false)?;
                return Ok(CallToolResult::success(vec![ContentBlock::text(
                    snapshot.to_string(),
                )]));
            }
            #[cfg(not(windows))]
            {
                let _ = meta;
                return Err("accessibility_backend_unavailable_use_screenshot");
            }
        }
        if name == "computer_screenshot" {
            exact_fields(&args, &["window_id"])?;
            let frame = self.frame(false)?;
            *self
                .state
                .observed
                .lock()
                .map_err(|_| "state_unavailable")? =
                Some((frame.observation.clone(), Instant::now()));
            return Ok(frame.result(json!({"action":"screenshot","input_dispatched":false})));
        }
        match name {
            "computer_click" => {
                exact_fields(&args, &["window_id", "observation", "x", "y", "button"])
            }
            "computer_scroll" => exact_fields(
                &args,
                &["window_id", "observation", "x", "y", "amount", "axis"],
            ),
            "computer_type" => exact_fields(&args, &["window_id", "observation", "text"]),
            "computer_key" => exact_fields(&args, &["window_id", "observation", "key"]),
            _ => Err("unknown_tool"),
        }?;
        // Validate the complete request before moving a pointer or consuming an observation.
        match name {
            "computer_click" => {
                integer(&args, "x")?;
                integer(&args, "y")?;
                if !["left", "right", "middle"]
                    .contains(&args.get("button").and_then(Value::as_str).unwrap_or("left"))
                {
                    return Err("button_not_allowed");
                }
            }
            "computer_scroll" => {
                integer(&args, "x")?;
                integer(&args, "y")?;
                let amount = integer(&args, "amount")?;
                if !(-10..=10).contains(&amount) || amount == 0 {
                    return Err("scroll_amount_out_of_range");
                }
                if !["vertical", "horizontal"].contains(
                    &args
                        .get("axis")
                        .and_then(Value::as_str)
                        .unwrap_or("vertical"),
                ) {
                    return Err("scroll_axis_not_allowed");
                }
            }
            "computer_type" => validate_text(
                args.get("text")
                    .and_then(Value::as_str)
                    .ok_or("text_required")?,
            )?,
            "computer_key" => {
                if !key_names().contains(
                    &args
                        .get("key")
                        .and_then(Value::as_str)
                        .ok_or("key_required")?,
                ) {
                    return Err("key_not_allowed");
                }
            }
            _ => {}
        }
        let token = args
            .get("observation")
            .and_then(Value::as_str)
            .ok_or("observation_required")?;
        let (prior, observed_at) = self
            .state
            .observed
            .lock()
            .map_err(|_| "state_unavailable")?
            .clone()
            .ok_or("screenshot_required")?;
        if prior.token != token {
            return Err("observation_not_current");
        }
        if observed_at.elapsed() > Duration::from_secs(5 * 60) {
            return Err("observation_expired_recapture_required");
        }
        let check_lifetime = || -> Result<()> {
            if context.ct.is_cancelled() {
                return Err("request_cancelled");
            }
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            {
                if self.state.revoked.load(Ordering::Acquire) {
                    return Err("grant_revoked");
                }
                if self.state.started.elapsed() > Duration::from_secs(15 * 60) {
                    return Err("grant_expired_select_window_again");
                }
                if observed_at.elapsed() > Duration::from_secs(5 * 60) {
                    return Err("observation_expired_recapture_required");
                }
            }
            Ok(())
        };
        let check = || -> Result<()> {
            check_lifetime()?;
            self.window(true)?;
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            check_lifetime()?;
            Ok(())
        };
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        self.focus_granted_target()?;
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            // The existing approval may leave Uptokey foreground. Consume this
            // attempt before waiting; timeout/cancel never silently retries it.
            *self
                .state
                .observed
                .lock()
                .map_err(|_| "state_unavailable")? = None;
            let waiting_since = Instant::now();
            manual_focus::wait_for_manual_foreground(
                check_lifetime,
                || self.window(true).map(|_| ()),
                || waiting_since.elapsed(),
                std::thread::sleep,
            )?;
        }
        let before = self.frame(true)?;
        validate_observation(&prior, &before.observation, token)?;
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        if observed_at.elapsed() > Duration::from_secs(5 * 60) {
            return Err("observation_expired_recapture_required");
        }
        let mut enigo = Enigo::new(&Settings::default()).map_err(|_| "input_permission_denied")?;
        check()?;
        // Consume the observation before input: any failure after dispatch requires recapture.
        *self
            .state
            .observed
            .lock()
            .map_err(|_| "state_unavailable")? = None;
        match name {
            "computer_click" | "computer_scroll" => {
                let x = integer(&args, "x")?;
                let y = integer(&args, "y")?;
                let (px, py) = point(&prior, x, y)?;
                point_owned(target, px, py)?;
                #[cfg(any(target_os = "macos", target_os = "linux"))]
                check_lifetime()?;
                enigo
                    .move_mouse(px, py, Coordinate::Abs)
                    .map_err(|_| "input_dispatch_failed")?;
                check()?;
                point_owned(target, px, py)?;
                #[cfg(any(target_os = "macos", target_os = "linux"))]
                check_lifetime()?;
                if name == "computer_click" {
                    let button = match args.get("button").and_then(Value::as_str).unwrap_or("left")
                    {
                        "left" => Button::Left,
                        "right" => Button::Right,
                        "middle" => Button::Middle,
                        _ => return Err("button_not_allowed"),
                    };
                    enigo
                        .button(button, Direction::Click)
                        .map_err(|_| "input_dispatch_failed")?;
                } else {
                    let amount = integer(&args, "amount")?;
                    if !(-10..=10).contains(&amount) || amount == 0 {
                        return Err("scroll_amount_out_of_range");
                    }
                    let axis = match args
                        .get("axis")
                        .and_then(Value::as_str)
                        .unwrap_or("vertical")
                    {
                        "vertical" => Axis::Vertical,
                        "horizontal" => Axis::Horizontal,
                        _ => return Err("scroll_axis_not_allowed"),
                    };
                    enigo
                        .scroll(amount, axis)
                        .map_err(|_| "input_dispatch_failed")?;
                }
            }
            "computer_type" => {
                let text = args
                    .get("text")
                    .and_then(Value::as_str)
                    .ok_or("text_required")?;
                validate_text(text)?;
                // Revalidate focus and cancellation before each character; no clipboard is used.
                for ch in text.chars() {
                    check()?;
                    enigo
                        .text(&ch.to_string())
                        .map_err(|_| "input_dispatch_failed")?;
                }
            }
            "computer_key" => {
                let name = args
                    .get("key")
                    .and_then(Value::as_str)
                    .ok_or("key_required")?;
                if name == "select_all" {
                    #[cfg(target_os = "macos")]
                    let modifier = Key::Meta;
                    #[cfg(not(target_os = "macos"))]
                    let modifier = Key::Control;
                    enigo
                        .key(modifier, Direction::Press)
                        .map_err(|_| "input_dispatch_failed")?;
                    let action = enigo.key(Key::Unicode('a'), Direction::Click);
                    let release = enigo.key(modifier, Direction::Release);
                    action.and(release).map_err(|_| "input_dispatch_failed")?;
                } else {
                    enigo
                        .key(key(name)?, Direction::Click)
                        .map_err(|_| "input_dispatch_failed")?;
                }
            }
            _ => unreachable!(),
        }
        drop(enigo);
        std::thread::sleep(Duration::from_millis(100));
        if context.ct.is_cancelled() {
            return Err("cancelled_after_dispatch_recapture_required");
        }
        let after = self
            .frame(false)
            .map_err(|_| "input_dispatched_recapture_required")?;
        let receipt = json!({"action":name,"input_dispatched":true,"approved_observation_sha256":prior.sha256,"observation_changed_since_capture":prior.sha256!=before.observation.sha256,"before_sha256":before.observation.sha256,"after_sha256":after.observation.sha256,"visual_change":before.observation.sha256!=after.observation.sha256,"semantic_success":"inspect_screenshot"});
        *self
            .state
            .observed
            .lock()
            .map_err(|_| "state_unavailable")? = Some((after.observation.clone(), Instant::now()));
        Ok(after.result(receipt))
    }
}

fn integer(args: &Value, key: &str) -> Result<i32> {
    args.get(key)
        .and_then(Value::as_i64)
        .and_then(|n| i32::try_from(n).ok())
        .ok_or("integer_argument_required")
}
fn exact_fields(args: &Value, fields: &[&str]) -> Result<()> {
    let object = args.as_object().ok_or("arguments_object_required")?;
    if object.keys().any(|key| !fields.contains(&key.as_str())) {
        return Err("unexpected_argument");
    }
    Ok(())
}
fn key(name: &str) -> Result<Key> {
    Ok(match name {
        "enter" => Key::Return,
        "tab" => Key::Tab,
        "escape" => Key::Escape,
        "backspace" => Key::Backspace,
        "delete" => Key::Delete,
        "left" => Key::LeftArrow,
        "right" => Key::RightArrow,
        "up" => Key::UpArrow,
        "down" => Key::DownArrow,
        "home" => Key::Home,
        "end" => Key::End,
        "pageup" => Key::PageUp,
        "pagedown" => Key::PageDown,
        _ => return Err("key_not_allowed"),
    })
}

fn point_owned(target: Target, x: i32, y: i32) -> Result<()> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::{
            Foundation::POINT,
            UI::WindowsAndMessaging::{GA_ROOT, GetAncestor, WindowFromPoint},
        };
        let root = unsafe { GetAncestor(WindowFromPoint(POINT { x, y }), GA_ROOT) };
        if root as usize as u32 != target.id {
            return Err("point_occluded_by_other_window");
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        // XCap returns front-to-back window order on X11 and macOS.
        // Conservatively refuse a point covered by another observable top-level window.
        let all = Window::all().map_err(|_| "point_ownership_unavailable")?;
        for window in all {
            let meta = info(&window)?;
            if meta.minimized {
                continue;
            }
            let inside = i64::from(x) >= i64::from(meta.x)
                && i64::from(y) >= i64::from(meta.y)
                && i64::from(x) < i64::from(meta.x) + i64::from(meta.width)
                && i64::from(y) < i64::from(meta.y) + i64::from(meta.height);
            if inside {
                return if meta.id == target.id && meta.pid == target.pid {
                    Ok(())
                } else {
                    Err("point_occluded_by_other_window")
                };
            }
        }
        Err("point_ownership_unavailable")
    }
}

impl ServerHandler for Server {
    fn get_info(&self) -> ServerConfig {
        let instructions = "Only the window explicitly selected in native Uptokey UI is granted, for 15 minutes. Take a screenshot first, then use its observation token and screenshot-relative coordinates. The window must remain foreground for input. Closing the native session revokes all access. Screenshots may be sent to the chosen model; no global zero knowledge is promised.";
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        let instructions = format!(
            "{instructions} On macOS/X11, tell the user before requesting approval: after Allow once, manually bring the selected target window forward. The action waits up to 15 seconds; timeout sends no input. No focus is forced. Timeout or cancellation requires a new screenshot and approval."
        );
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new(
                "uptokey-computer-mcp",
                env!("CARGO_PKG_VERSION"),
            ))
            .with_instructions(instructions)
    }
    async fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> std::result::Result<ListToolsResult, ErrorData> {
        let tools = tool_specs()
            .into_iter()
            .map(serde_json::from_value::<Tool>)
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|_| ErrorData::internal_error("tool_schema_invalid", None))?;
        Ok(ListToolsResult::with_all_items(tools))
    }
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> std::result::Result<CallToolResponse, ErrorData> {
        let server = self.clone();
        let result = tokio::task::spawn_blocking(move || {
            server.execute(
                &request.name,
                Value::Object(request.arguments.unwrap_or_default()),
                &context,
            )
        })
        .await;
        Ok(match result {Ok(Ok(result))=>result,Ok(Err(code))=>CallToolResult::error(vec![ContentBlock::text(json!({"error":code,"retry":if ["target_not_foreground","os_refused_target_focus"].contains(&code){"The OS did not make the granted target foreground. Bring that selected window forward and capture it again; no privilege or focus-lock bypass was attempted."}else{"capture_current_window_before_next_action"}}).to_string())]),Err(_)=>CallToolResult::error(vec![ContentBlock::text("computer_worker_failed")])}.into())
    }
}

#[tokio::main]
async fn main() {
    if let Err(code) = run().await {
        eprintln!("{code}");
        std::process::exit(1);
    }
}
async fn run() -> Result<()> {
    #[cfg(windows)]
    unsafe {
        windows_sys::Win32::UI::HiDpi::SetProcessDpiAwarenessContext(
            windows_sys::Win32::UI::HiDpi::DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
        );
    }
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args == ["--tools-json"] {
        println!("{}", json!({"tools":tool_specs()}));
        return Ok(());
    }
    if args == ["--list-windows"] {
        println!(
            "{}",
            json!({"schema":"uptokey.computer.windows.v1","windows":windows()?,"platform":std::env::consts::OS})
        );
        return Ok(());
    }
    #[cfg(windows)]
    if args == ["--fixture"] {
        return fixture::run();
    }
    let target = if args.is_empty() {
        None
    } else if args.len() == 4 && args[0] == "--window-id" && args[2] == "--pid" {
        Some(Target {
            id: args[1].parse().map_err(|_| "invalid_window_id")?,
            pid: args[3].parse().map_err(|_| "invalid_pid")?,
        })
    } else {
        return Err("usage: --list-windows | --tools-json | --window-id ID --pid PID");
    };
    let server = Server::new(target)?;
    let state = server.state.clone();
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let transport = {
        let (reader, writer) = stdio();
        let closing = state.clone();
        (
            manual_focus::RevokeOnClose::new(reader, move || {
                closing.revoked.store(true, Ordering::Release);
            }),
            writer,
        )
    };
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let transport = stdio();
    let running = server
        .serve(transport)
        .await
        .map_err(|_| "mcp_initialization_failed")?;
    let result = running.waiting().await;
    state.revoked.store(true, Ordering::Release);
    result.map_err(|_| "mcp_service_failed")?;
    Ok(())
}

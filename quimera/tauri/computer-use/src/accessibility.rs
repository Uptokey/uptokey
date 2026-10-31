use serde_json::{Value, json};
use std::time::{Duration, Instant};
use uptokey_desktop_computer::{Target, WindowInfo};
use windows::{
    Win32::{
        Foundation::HWND,
        System::Com::{
            CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx,
            CoUninitialize,
        },
        UI::Accessibility::{CUIAutomation8, IUIAutomation, IUIAutomation2, IUIAutomationElement},
    },
    core::Interface,
};

struct Com;
impl Drop for Com {
    fn drop(&mut self) {
        unsafe { CoUninitialize() }
    }
}

/// Only walks the selected HWND. No desktop root, global search, value pattern or clipboard.
pub fn snapshot(
    target: Target,
    window: &WindowInfo,
    cancelled: impl Fn() -> bool,
) -> Result<Value, &'static str> {
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED)
            .ok()
            .map_err(|_| "accessibility_com_unavailable")?;
        let _com = Com;
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER)
                .map_err(|_| "accessibility_unavailable")?;
        let limits: IUIAutomation2 = automation
            .cast()
            .map_err(|_| "accessibility_timeouts_unavailable")?;
        limits
            .SetConnectionTimeout(500)
            .map_err(|_| "accessibility_timeout_setup_failed")?;
        limits
            .SetTransactionTimeout(500)
            .map_err(|_| "accessibility_timeout_setup_failed")?;
        let root = automation
            .ElementFromHandle(HWND(target.id as usize as _))
            .map_err(|_| "accessibility_target_unavailable")?;
        if root
            .CurrentProcessId()
            .map_err(|_| "accessibility_identity_unavailable")? as u32
            != target.pid
        {
            return Err("accessibility_identity_changed");
        }
        let walker = automation
            .ControlViewWalker()
            .map_err(|_| "accessibility_tree_unavailable")?;
        let start = Instant::now();
        let mut nodes = Vec::new();
        let mut stack: Vec<(IUIAutomationElement, usize, Option<usize>)> = vec![(root, 0, None)];
        let mut truncated = false;
        while let Some((element, depth, parent)) = stack.pop() {
            if cancelled() {
                return Err("request_cancelled");
            }
            if nodes.len() >= 128 || start.elapsed() > Duration::from_secs(3) {
                truncated = true;
                break;
            }
            if depth > 10 {
                truncated = true;
                continue;
            }
            if element.CurrentProcessId().ok() != Some(target.pid as i32) {
                continue;
            }
            let password = element
                .CurrentIsPassword()
                .map(|b| b.as_bool())
                .unwrap_or(true);
            let bounds = element
                .CurrentBoundingRectangle()
                .map_err(|_| "accessibility_bounds_unavailable")?;
            // Exclude popup/foreign surfaces extending beyond the granted window.
            if depth > 0
                && (bounds.left < window.x
                    || bounds.top < window.y
                    || bounds.right > window.x + window.width as i32
                    || bounds.bottom > window.y + window.height as i32)
            {
                continue;
            }
            let index = nodes.len();
            nodes.push(json!({"index":index,"parent":parent,"depth":depth,"role":element.CurrentControlType().map(|x|x.0).unwrap_or_default(),"name":if password{"[protected]".to_string()}else{element.CurrentName().map(|s|s.to_string().chars().take(240).collect::<String>()).unwrap_or_default()},"automation_id":if password{String::new()}else{element.CurrentAutomationId().map(|s|s.to_string().chars().take(128).collect::<String>()).unwrap_or_default()},"password":password,"enabled":element.CurrentIsEnabled().map(|b|b.as_bool()).unwrap_or(false),"focused":element.CurrentHasKeyboardFocus().map(|b|b.as_bool()).unwrap_or(false),"bounds":{"x":bounds.left-window.x,"y":bounds.top-window.y,"width":bounds.right-bounds.left,"height":bounds.bottom-bounds.top}}));
            if password {
                continue;
            }
            let mut children = Vec::new();
            if let Ok(first) = walker.GetFirstChildElement(&element) {
                let mut child = first;
                loop {
                    if cancelled() {
                        return Err("request_cancelled");
                    }
                    if children.len() >= 128 || start.elapsed() > Duration::from_secs(3) {
                        truncated = true;
                        break;
                    }
                    let next = walker.GetNextSiblingElement(&child);
                    children.push(child);
                    match next {
                        Ok(value) => child = value,
                        Err(_) => break,
                    }
                }
            }
            stack.extend(
                children
                    .into_iter()
                    .rev()
                    .map(|child| (child, depth + 1, Some(index))),
            );
        }
        Ok(
            json!({"schema":"uptokey.computer.accessibility.v1","backend":"windows-uia","window_id":target.id,"pid":target.pid,"nodes":nodes,"truncated":truncated,"coordinate_space":"window-relative-native-pixels","password_values_read":false}),
        )
    }
}

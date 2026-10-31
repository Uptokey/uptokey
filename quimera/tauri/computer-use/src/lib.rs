use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub const MAX_TEXT_CHARS: usize = 1024;
pub const MAX_SOURCE_PIXELS: u64 = 33_177_600;
pub const MAX_PNG_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_FRAME_WIDTH: u32 = 1600;
pub const MAX_FRAME_HEIGHT: u32 = 1000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Target {
    pub id: u32,
    pub pid: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct WindowInfo {
    pub id: u32,
    pub pid: u32,
    pub title: String,
    pub app: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub focused: bool,
    pub minimized: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Observation {
    pub token: String,
    pub target: Target,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub image_width: u32,
    pub image_height: u32,
    pub sha256: String,
}

pub fn validate_window(
    target: Target,
    actual: &WindowInfo,
    input: bool,
) -> Result<(), &'static str> {
    if target.id != actual.id || target.pid != actual.pid {
        return Err("target_identity_changed");
    }
    if actual.minimized || actual.width == 0 || actual.height == 0 {
        return Err("target_not_visible");
    }
    if u64::from(actual.width) * u64::from(actual.height) > MAX_SOURCE_PIXELS {
        return Err("target_too_large");
    }
    if input && !actual.focused {
        return Err("target_not_foreground");
    }
    Ok(())
}

pub fn validate_observation(
    old: &Observation,
    new: &Observation,
    token: &str,
) -> Result<(), &'static str> {
    if old.token != token {
        return Err("observation_not_current");
    }
    if old.target != new.target
        || old.x != new.x
        || old.y != new.y
        || old.width != new.width
        || old.height != new.height
    {
        return Err("target_geometry_changed");
    }
    Ok(())
}

pub fn point(observation: &Observation, x: i32, y: i32) -> Result<(i32, i32), &'static str> {
    if x < 0 || y < 0 || x as u32 >= observation.image_width || y as u32 >= observation.image_height
    {
        return Err("point_outside_target");
    }
    let px = i64::from(observation.x)
        + i64::from(x) * i64::from(observation.width) / i64::from(observation.image_width);
    let py = i64::from(observation.y)
        + i64::from(y) * i64::from(observation.height) / i64::from(observation.image_height);
    Ok((
        i32::try_from(px).map_err(|_| "point_overflow")?,
        i32::try_from(py).map_err(|_| "point_overflow")?,
    ))
}

pub fn validate_text(text: &str) -> Result<(), &'static str> {
    if text.is_empty() || text.chars().count() > MAX_TEXT_CHARS {
        return Err("text_length_out_of_range");
    }
    // Newlines and tabs must be explicit key actions; no accidental form submission.
    if text.chars().any(char::is_control) {
        return Err("text_control_character");
    }
    Ok(())
}

pub fn key_names() -> Vec<&'static str> {
    vec![
        "enter",
        "tab",
        "escape",
        "backspace",
        "delete",
        "left",
        "right",
        "up",
        "down",
        "home",
        "end",
        "pageup",
        "pagedown",
        "select_all",
    ]
}

pub fn tool_specs() -> Vec<Value> {
    let observation = json!({"type":"string","description":"Current observation token returned by screenshot or last successful action."});
    let target = json!({"type":"integer","minimum":1,"description":"ID of the window selected in the native desktop UI."});
    let mut specs = Vec::new();
    for (name, description, properties, required, read_only) in [
        (
            "computer_windows",
            "Metadata of the single window granted by the native user. Use the native chooser to select a different target.",
            json!({}),
            vec![],
            true,
        ),
        (
            "computer_screenshot",
            "Capture only the granted window. Returns a bounded PNG and observation token. Never captures the entire desktop.",
            json!({"window_id":target.clone()}),
            vec!["window_id"],
            true,
        ),
        (
            "computer_snapshot",
            "Read the granted window's bounded accessibility tree (Windows UI Automation). Password controls are redacted; no value/clipboard extraction. Other platforms return an explicit unsupported state; screenshot remains available.",
            json!({"window_id":target.clone()}),
            vec!["window_id"],
            true,
        ),
        (
            "computer_click",
            "Click a point relative to the latest screenshot of the granted window. On Windows the approved call first restores focus to that exact target. Returns a fresh screenshot and before/after receipt; old tokens or changed geometry are rejected.",
            json!({"window_id":target.clone(),"observation":observation.clone(),"x":{"type":"integer","minimum":0},"y":{"type":"integer","minimum":0},"button":{"type":"string","enum":["left","right","middle"],"default":"left"}}),
            vec!["window_id", "observation", "x", "y"],
            false,
        ),
        (
            "computer_type",
            "Type up to 1024 printable characters in the granted foreground window; no clipboard, newline or tab. Capture and inspect the result before the next action.",
            json!({"window_id":target.clone(),"observation":observation.clone(),"text":{"type":"string","minLength":1,"maxLength":1024}}),
            vec!["window_id", "observation", "text"],
            false,
        ),
        (
            "computer_key",
            "Send one allowlisted editing/navigation key to the granted foreground window. No system shortcuts or arbitrary chord execution.",
            json!({"window_id":target.clone(),"observation":observation.clone(),"key":{"type":"string","enum":key_names()}}),
            vec!["window_id", "observation", "key"],
            false,
        ),
        (
            "computer_scroll",
            "Scroll at a screenshot-relative point in the granted foreground window, bounded to 10 wheel units. Returns an observation receipt.",
            json!({"window_id":target,"observation":observation,"x":{"type":"integer","minimum":0},"y":{"type":"integer","minimum":0},"amount":{"type":"integer","minimum":-10,"maximum":10},"axis":{"type":"string","enum":["vertical","horizontal"],"default":"vertical"}}),
            vec!["window_id", "observation", "x", "y", "amount"],
            false,
        ),
    ] {
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        let description = if read_only {
            description.to_owned()
        } else {
            format!(
                "{description} Before approval, tell the user: after Allow once, manually bring this selected target forward. The action waits up to 15 seconds; timeout sends no input. No activation is forced; timeout/cancellation requires a fresh screenshot and approval."
            )
        };
        specs.push(json!({"name":name,"description":description,"inputSchema":{"type":"object","properties":properties,"required":required,"additionalProperties":false},"annotations":{"readOnlyHint":read_only,"destructiveHint":!read_only,"idempotentHint":read_only,"openWorldHint":true}}));
    }
    specs
}

#[cfg(test)]
mod tests {
    use super::*;
    fn obs() -> Observation {
        Observation {
            token: "1".into(),
            target: Target { id: 10, pid: 20 },
            x: -100,
            y: 50,
            width: 200,
            height: 100,
            image_width: 100,
            image_height: 50,
            sha256: "a".into(),
        }
    }
    #[test]
    fn coordinates_are_relative_bounded_and_scaled() {
        assert_eq!(point(&obs(), 99, 49), Ok((98, 148)));
        assert!(point(&obs(), 100, 0).is_err());
        assert!(point(&obs(), -1, 0).is_err());
    }
    #[test]
    fn old_tokens_and_geometry_are_rejected_but_animation_is_allowed() {
        let a = obs();
        let mut b = a.clone();
        b.sha256 = "b".into();
        assert_eq!(validate_observation(&a, &b, "1"), Ok(()));
        b = a.clone();
        b.x += 1;
        assert_eq!(
            validate_observation(&a, &b, "1"),
            Err("target_geometry_changed")
        );
        assert_eq!(
            validate_observation(&a, &a, "0"),
            Err("observation_not_current")
        );
    }
    #[test]
    fn text_cannot_submit_a_form_implicitly() {
        assert!(validate_text("olá 世界").is_ok());
        assert!(validate_text("bad\n").is_err());
        assert!(validate_text("bad\t").is_err());
        assert!(validate_text(&"x".repeat(1025)).is_err());
    }
    #[test]
    fn target_identity_and_focus_are_required() {
        let mut w = WindowInfo {
            id: 1,
            pid: 2,
            title: String::new(),
            app: String::new(),
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            focused: false,
            minimized: false,
        };
        assert_eq!(
            validate_window(Target { id: 1, pid: 2 }, &w, true),
            Err("target_not_foreground")
        );
        w.focused = true;
        assert!(validate_window(Target { id: 1, pid: 2 }, &w, true).is_ok());
        assert!(validate_window(Target { id: 2, pid: 2 }, &w, true).is_err());
    }
}

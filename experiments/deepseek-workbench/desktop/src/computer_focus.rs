//! Correlation state for the existing approval waterfall. A ticket is registered
//! only by the private owned-process pipe, never by a renderer command.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Ticket {
    pub id: String,
    pub lease_id: String,
    pub session_id: String,
    pub call_id: String,
    pub tool_name: String,
    pub fingerprint: String,
    pub expires_at: u64,
}
fn hex(value: &str, size: usize) -> bool {
    value.len() == size
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && value.bytes().all(|byte| byte > 0x20 && byte != 0x7f)
}
impl Ticket {
    fn valid(&self, lease: &str, expiry: u64, now: u64) -> bool {
        hex(&self.id, 32)
            && self.lease_id == lease
            && identifier(&self.session_id)
            && identifier(&self.call_id)
            && hex(&self.fingerprint, 64)
            && matches!(
                self.tool_name.as_str(),
                "mcp__computer__computer_click"
                    | "mcp__computer__computer_type"
                    | "mcp__computer__computer_key"
                    | "mcp__computer__computer_scroll"
            )
            && self.expires_at > now
            && self.expires_at <= expiry
            && self.expires_at <= now.saturating_add(60_000)
    }
}

#[derive(Default)]
pub(super) struct Pending {
    lease: Option<(String, u64)>,
    tickets: HashMap<String, Ticket>,
}
impl Pending {
    pub fn ready(&mut self, lease: &str, expiry: u64) -> Result<(), &'static str> {
        if self.lease.is_some() || !hex(lease, 32) {
            return Err("computer-focus-lease-invalid");
        }
        self.lease = Some((lease.to_owned(), expiry));
        Ok(())
    }
    pub fn register(&mut self, ticket: Ticket, now: u64) -> Result<(), &'static str> {
        self.tickets.retain(|_, ticket| ticket.expires_at > now);
        let (lease, expiry) = self.lease.as_ref().ok_or("computer-focus-unavailable")?;
        if self.tickets.len() >= 8
            || !ticket.valid(lease, *expiry, now)
            || self.tickets.contains_key(&ticket.id)
        {
            return Err("computer-focus-ticket-invalid");
        }
        self.tickets.insert(ticket.id.clone(), ticket);
        Ok(())
    }
    pub fn cancel(&mut self, id: &str) -> Result<(), &'static str> {
        if !hex(id, 32) {
            return Err("computer-focus-ticket-invalid");
        }
        self.tickets.remove(id);
        Ok(())
    }
    #[cfg(any(windows, test))]
    pub fn consume(&mut self, ticket: &Ticket, now: u64) -> Result<(), &'static str> {
        // Remove before checking or doing any OS effect. Even a mismatched or
        // denied attempt cannot recycle a ticket or race a second IPC call.
        let registered = self
            .tickets
            .remove(&ticket.id)
            .ok_or("computer-focus-unavailable")?;
        let (lease, expiry) = self.lease.as_ref().ok_or("computer-focus-unavailable")?;
        if registered != *ticket || !ticket.valid(lease, *expiry, now) {
            return Err("computer-focus-ticket-invalid");
        }
        Ok(())
    }
}

#[cfg(windows)]
pub(super) struct Selection {
    window: u32,
    pid: u32,
    process: std::os::windows::io::OwnedHandle,
}
#[cfg(windows)]
impl Selection {
    pub fn pin(window: u32, pid: u32) -> Result<Self, &'static str> {
        use std::os::windows::io::FromRawHandle;
        use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE};
        let raw = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
        if raw.is_null() {
            return Err("computer-focus-target-unavailable");
        }
        let value = Self {
            window,
            pid,
            process: unsafe { std::os::windows::io::OwnedHandle::from_raw_handle(raw) },
        };
        value.validate()?;
        Ok(value)
    }
    fn validate(&self) -> Result<(), &'static str> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::{
            Foundation::WAIT_TIMEOUT,
            System::Threading::WaitForSingleObject,
            UI::WindowsAndMessaging::{GetWindowThreadProcessId, IsIconic, IsWindowVisible},
        };
        let window = self.window as usize as *mut std::ffi::c_void;
        let mut pid = 0;
        unsafe {
            if WaitForSingleObject(self.process.as_raw_handle(), 0) != WAIT_TIMEOUT
                || GetWindowThreadProcessId(window, &mut pid) == 0
                || pid != self.pid
                || IsWindowVisible(window) == 0
                || IsIconic(window) != 0
            {
                return Err("computer-focus-target-unavailable");
            }
        }
        Ok(())
    }
    pub fn focus(&self, owner: *mut std::ffi::c_void) -> Result<(), &'static str> {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GetForegroundWindow, SetForegroundWindow,
        };
        self.validate()?;
        let target = self.window as usize as *mut std::ffi::c_void;
        unsafe {
            if owner.is_null() || GetForegroundWindow() != owner {
                return Err("computer-focus-owner-not-foreground");
            }
            // Normal documented foreground operation by the foreground host.
            // No permission is delegated, no lock/input/integrity is changed.
            if SetForegroundWindow(target) == 0 {
                return Err("os_refused_target_focus");
            }
            self.validate()?;
            if GetForegroundWindow() != target {
                return Err("os_refused_target_focus");
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ticket() -> Ticket {
        Ticket {
            id: "1".repeat(32),
            lease_id: "2".repeat(32),
            session_id: "session-one".into(),
            call_id: "call-one".into(),
            tool_name: "mcp__computer__computer_click".into(),
            fingerprint: "a".repeat(64),
            expires_at: 2000,
        }
    }
    fn pending() -> Pending {
        let mut p = Pending::default();
        p.ready(&"2".repeat(32), 3000).unwrap();
        p
    }
    #[test]
    fn exact_one_shot() {
        let mut p = pending();
        let t = ticket();
        p.register(t.clone(), 1000).unwrap();
        p.consume(&t, 1100).unwrap();
        assert!(p.consume(&t, 1100).is_err());
    }
    #[test]
    fn renderer_cannot_register_or_change_scope() {
        let t = ticket();
        assert!(pending().consume(&t, 1000).is_err());
        for field in ["call", "session", "tool", "fingerprint", "lease"] {
            let mut p = pending();
            p.register(t.clone(), 1000).unwrap();
            let mut changed = t.clone();
            match field {
                "call" => changed.call_id = "other".into(),
                "session" => changed.session_id = "other".into(),
                "tool" => changed.tool_name = "mcp__computer__computer_type".into(),
                "fingerprint" => changed.fingerprint = "b".repeat(64),
                _ => changed.lease_id = "3".repeat(32),
            }
            assert!(p.consume(&changed, 1001).is_err());
            assert!(p.consume(&t, 1002).is_err());
        }
    }
    #[test]
    fn cancelled_expired_or_replaced_epoch_cannot_focus() {
        let mut p = pending();
        let t = ticket();
        p.register(t.clone(), 1000).unwrap();
        p.cancel(&t.id).unwrap();
        p.cancel(&t.id).unwrap();
        assert!(p.consume(&t, 1100).is_err());
        p.register(t.clone(), 1100).unwrap();
        assert!(p.consume(&t, 2000).is_err());
        assert!(Pending::default().consume(&t, 1100).is_err());
        assert!(p.ready(&"3".repeat(32), 3000).is_err());
    }
    #[test]
    fn bounds_and_unknown_fields() {
        let mut p = pending();
        for n in 0..8 {
            let mut t = ticket();
            t.id = format!("{n:032x}");
            p.register(t, 1000).unwrap()
        }
        let mut t = ticket();
        assert!(p.register(t.clone(), 1000).is_err());
        t.tool_name = "mcp__computer__computer_snapshot".into();
        assert!(pending().register(t, 1000).is_err());
        let mut v = serde_json::to_value(ticket()).unwrap();
        v["pid"] = 123.into();
        assert!(serde_json::from_value::<Ticket>(v).is_err());
    }
}

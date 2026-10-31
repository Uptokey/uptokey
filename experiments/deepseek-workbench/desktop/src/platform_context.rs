use std::process::Command;

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct PlatformContext {
    pub(crate) platform: &'static str,
    pub(crate) identity: String,
    pub(crate) elevated: Option<bool>,
}

fn successful_output(mut command: Command) -> Result<String, &'static str> {
    let output = command.output().map_err(|_| "context-failed")?;
    if !output.status.success() {
        return Err("context-failed");
    }
    String::from_utf8(output.stdout)
        .map(|value| value.trim().to_owned())
        .map_err(|_| "context-failed")
}

#[cfg(windows)]
pub(crate) fn current() -> Result<PlatformContext, &'static str> {
    let mut command = Command::new("whoami.exe");
    command.arg("/groups");
    let output = successful_output(command)?;
    let identity = output
        .split_whitespace()
        .find(|part| part.starts_with("S-1-16-"))
        .ok_or("context-failed")?
        .to_owned();
    Ok(PlatformContext { platform: "windows", identity, elevated: None })
}

#[cfg(unix)]
pub(crate) fn current() -> Result<PlatformContext, &'static str> {
    // macOS and supported Linux distributions expose the effective numeric
    // identity through this fixed system binary. No shell, profile or user
    // controlled PATH participates in the diagnostic.
    let mut command = Command::new("/usr/bin/id");
    command.arg("-u");
    let identity = successful_output(command)?;
    let uid = identity.parse::<u32>().map_err(|_| "context-failed")?;
    Ok(PlatformContext {
        platform: if cfg!(target_os = "macos") { "macos" } else { "linux" },
        identity,
        elevated: Some(uid == 0),
    })
}

#[cfg(not(any(windows, unix)))]
pub(crate) fn current() -> Result<PlatformContext, &'static str> {
    Err("context-platform-unsupported")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_output_requires_success_and_utf8() {
        #[cfg(windows)]
        let command = { let mut value = Command::new("cmd.exe"); value.args(["/d", "/s", "/c", "exit 7"]); value };
        #[cfg(unix)]
        let command = { let mut value = Command::new("/bin/sh"); value.args(["-c", "exit 7"]); value };
        assert_eq!(successful_output(command).unwrap_err(), "context-failed");
    }

    #[test]
    fn native_context_has_a_bounded_identity() {
        let context = current().unwrap();
        assert!(!context.identity.is_empty());
        assert!(context.identity.len() <= 64);
        #[cfg(windows)]
        assert!(context.identity.starts_with("S-1-16-"));
        #[cfg(unix)]
        assert!(context.identity.bytes().all(|byte| byte.is_ascii_digit()));
    }
}

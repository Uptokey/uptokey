//! Launch already-validated web destinations through the user's browser.
//!
//! On Windows, resolve and validate the selected handler first, then ask the
//! shell to dispatch the literal URL asynchronously. Chromium launchers can
//! terminate with a breakpoint status after a successful existing-instance
//! handoff, so their process exit code is not a reliable dispatch receipt.
use std::path::{Path, PathBuf};
#[cfg(any(unix, test))]
use std::process::{Command, Stdio};
use std::time::Duration;
#[cfg(any(unix, test))]
use std::time::Instant;

const UNAVAILABLE: &str = "account_browser_unavailable";
#[cfg(any(unix, test))]
const START_OBSERVATION: Duration = Duration::from_millis(500);

fn failure_code(stage: &str, code: Option<i32>, diagnostics: bool) -> String {
    if !diagnostics {
        return UNAVAILABLE.into();
    }
    // Only a fixed stage and a numeric OS/HRESULT/exit value are exposed. URLs,
    // arguments, paths, environment contents and process output never cross IPC.
    match code {
        Some(code) => format!("account_browser_{stage}_{:08x}", code as u32),
        None => format!("account_browser_{stage}"),
    }
}

fn failure(stage: &str, code: Option<i32>) -> String {
    failure_code(
        stage,
        code,
        std::env::var("UPTOKEY_BROWSER_DIAGNOSTICS").as_deref() == Ok("1"),
    )
}

fn web_protocol(protocol: &str) -> Result<(), String> {
    if matches!(protocol, "http" | "https") {
        Ok(())
    } else {
        Err(failure("protocol_invalid", None))
    }
}

#[cfg(any(unix, test))]
fn browser_command(executable: &Path, url: &tauri::Url) -> Result<Command, String> {
    web_protocol(url.scheme())?;
    let mut command = Command::new(executable);
    // Command quotes the one argument for CreateProcess; &, quotes and percent
    // escapes in a validated URL cannot become shell syntax or extra arguments.
    command
        .arg(url.as_str())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    Ok(command)
}

#[cfg(any(unix, test))]
fn start(mut command: Command) -> Result<(), String> {
    let mut child = command
        .spawn()
        .map_err(|error| failure("spawn_failed", error.raw_os_error()))?;
    let deadline = Instant::now() + START_OBSERVATION;
    loop {
        match child
            .try_wait()
            .map_err(|error| failure("wait_failed", error.raw_os_error()))?
        {
            Some(status) => {
                return if status.success() {
                    Ok(())
                } else {
                    Err(failure("exit_failed", status.code()))
                }
            }
            None if Instant::now() >= deadline => {
                // Unix retains an exited child until it is waited for. Detach
                // that wait from the UI budget without terminating the browser.
                #[cfg(unix)]
                drop(
                    std::thread::Builder::new()
                        .name("uptokey-browser-reaper".into())
                        .spawn(move || {
                            let _ = child.wait();
                        })
                        .map_err(|error| failure("reaper_failed", error.raw_os_error()))?,
                );
                return Ok(());
            }
            None => std::thread::sleep(Duration::from_millis(20)),
        }
    }
    // A running browser or successful existing-instance handoff is accepted.
    // This is process-start evidence, not proof of authentication or page load.
}

#[cfg(windows)]
fn selected_browser(protocol: &str) -> Result<PathBuf, String> {
    web_protocol(protocol)?;
    let protocol = protocol.to_owned();
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("uptokey-browser-association".into())
        .spawn(move || {
            let _ = sender.send(query_browser(&protocol));
        })
        .map_err(|error| failure("association_worker_failed", error.raw_os_error()))?;
    // The query worker never launches anything: a late reply after this timeout
    // cannot open a discarded challenge or duplicate the user's retry.
    receiver
        .recv_timeout(Duration::from_secs(3))
        .map_err(|error| {
            failure(
                match error {
                    std::sync::mpsc::RecvTimeoutError::Timeout => "association_timeout",
                    std::sync::mpsc::RecvTimeoutError::Disconnected => "association_worker_closed",
                },
                None,
            )
        })?
}

#[cfg(windows)]
fn query_browser(protocol: &str) -> Result<PathBuf, String> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::UI::Shell::{
        AssocQueryStringW, ASSOCF_IS_PROTOCOL, ASSOCF_NOTRUNCATE, ASSOCSTR_EXECUTABLE,
    };
    web_protocol(protocol)?;
    let association: Vec<u16> = protocol.encode_utf16().chain(Some(0)).collect();
    let verb: Vec<u16> = "open".encode_utf16().chain(Some(0)).collect();
    let mut buffer = vec![0u16; 32_768];
    let mut count = buffer.len() as u32;
    // All pointers refer to live, bounded UTF-16 buffers. The API returns the
    // executable association, never a command template requiring interpolation.
    let result = unsafe {
        AssocQueryStringW(
            ASSOCF_IS_PROTOCOL | ASSOCF_NOTRUNCATE,
            ASSOCSTR_EXECUTABLE,
            association.as_ptr(),
            verb.as_ptr(),
            buffer.as_mut_ptr(),
            &mut count,
        )
    };
    if result != 0 {
        return Err(failure("association_query_failed", Some(result)));
    }
    if count < 2 || count as usize > buffer.len() {
        return Err(failure("association_response_invalid", None));
    }
    let end = count as usize - 1;
    if buffer[end] != 0
        || buffer[..end]
            .iter()
            .any(|unit| *unit < 0x20 || *unit == 0x7f)
    {
        return Err(failure("association_response_invalid", None));
    }
    let executable = PathBuf::from(OsString::from_wide(&buffer[..end]));
    validate_browser_executable(&executable)?;
    Ok(executable)
}

#[cfg(windows)]
fn shell_open(url: &tauri::Url) -> Result<(), String> {
    use windows_sys_harness::Win32::UI::Shell::{
        ShellExecuteExW, SEE_MASK_ASYNCOK, SEE_MASK_FLAG_NO_UI, SHELLEXECUTEINFOW,
    };
    web_protocol(url.scheme())?;
    // Fail closed if the current protocol association is not a regular local
    // executable. ShellExecute receives no command template or parameters.
    selected_browser(url.scheme())?;
    let verb: Vec<u16> = "open".encode_utf16().chain(Some(0)).collect();
    let target: Vec<u16> = url.as_str().encode_utf16().chain(Some(0)).collect();
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_ASYNCOK | SEE_MASK_FLAG_NO_UI,
        lpVerb: verb.as_ptr(),
        lpFile: target.as_ptr(),
        nShow: 1,
        ..Default::default()
    };
    let dispatched = unsafe { ShellExecuteExW(&mut info) };
    if dispatched == 0 {
        Err(failure(
            "shell_execute_failed",
            std::io::Error::last_os_error().raw_os_error(),
        ))
    } else {
        Ok(())
    }
}

#[cfg(windows)]
fn validate_browser_executable(path: &Path) -> Result<(), String> {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    // A broken association must not turn a web destination into a script,
    // shell command, URL.dll proxy or device/UNC activation.
    if !path.is_absolute()
        || !matches!(path.components().next(), Some(std::path::Component::Prefix(prefix)) if matches!(prefix.kind(), std::path::Prefix::Disk(_)))
        || path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| !value.eq_ignore_ascii_case("exe"))
            .unwrap_or(true)
        || [
            "cmd.exe",
            "powershell.exe",
            "pwsh.exe",
            "rundll32.exe",
            "mshta.exe",
            "wscript.exe",
            "cscript.exe",
        ]
        .contains(&name.as_str())
        || !path.is_file()
    {
        return Err(failure("association_path_invalid", None));
    }
    Ok(())
}

pub(super) fn open(url: &tauri::Url) -> Result<(), String> {
    web_protocol(url.scheme())?;
    #[cfg(windows)]
    {
        shell_open(url)
    }
    #[cfg(target_os = "macos")]
    {
        start(browser_command(&PathBuf::from("/usr/bin/open"), url)?)
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        start(browser_command(&PathBuf::from("/usr/bin/xdg-open"), url)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostics_preserve_default_error_and_never_reflect_process_data() {
        assert_eq!(failure_code("spawn_failed", Some(5), false), UNAVAILABLE);
        assert_eq!(
            failure_code("exit_failed", Some(-1_073_741_502), false),
            UNAVAILABLE
        );
        assert_eq!(
            failure_code("spawn_failed", Some(5), true),
            "account_browser_spawn_failed_00000005"
        );
        assert_eq!(
            failure_code("exit_failed", Some(-1_073_741_502), true),
            "account_browser_exit_failed_c0000142"
        );
        assert_eq!(
            failure_code("association_timeout", None, true),
            "account_browser_association_timeout"
        );
        for stage in [
            "protocol_invalid",
            "spawn_failed",
            "wait_failed",
            "exit_failed",
            "reaper_failed",
            "association_worker_failed",
            "association_timeout",
            "association_worker_closed",
            "association_query_failed",
            "association_response_invalid",
            "association_path_invalid",
            "shell_execute_failed",
        ] {
            let code = failure_code(stage, Some(i32::MIN), true);
            assert!(
                code.len() <= 100
                    && code.bytes().all(|byte| byte.is_ascii_lowercase()
                        || byte.is_ascii_digit()
                        || byte == b'_')
            );
        }
    }

    #[test]
    fn verified_url_is_one_literal_process_argument() {
        let path = PathBuf::from("C:/Program Files/Synthetic Browser/browser.exe");
        let url =
            tauri::Url::parse("https://example.invalid/path?value=%22%26calc.exe&lang=en").unwrap();
        let command = browser_command(&path, &url).unwrap();
        assert_eq!(command.get_program(), path.as_os_str());
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            vec![std::ffi::OsStr::new(url.as_str())]
        );
        for value in ["file:///C:/test", "javascript:alert(1)", "cmd:run"] {
            assert!(browser_command(&path, &tauri::Url::parse(value).unwrap()).is_err());
        }
    }

    #[test]
    fn process_start_does_not_accept_a_missing_executable() {
        assert_eq!(
            start(Command::new("/uptokey-synthetic-missing-browser")),
            Err(UNAVAILABLE.into())
        );
    }

    fn probe(mode: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .arg("--exact")
            .arg("bridge::browser::tests::startup_probe_child")
            .arg("--nocapture")
            .env("UPTOKEY_TEST_BROWSER_START_PROBE", mode)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command
    }

    #[test]
    fn failed_start_is_not_reported_as_browser_opened() {
        assert_eq!(start(probe("fail")), Err(UNAVAILABLE.into()));
    }

    #[test]
    fn existing_instance_handoff_and_running_browser_finish_without_waiting_for_close() {
        assert!(start(probe("handoff")).is_ok());
        let started = Instant::now();
        assert!(start(probe("running")).is_ok());
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn startup_probe_child() {
        match std::env::var("UPTOKEY_TEST_BROWSER_START_PROBE").as_deref() {
            Ok("fail") => std::process::exit(9),
            Ok("handoff") => std::process::exit(0),
            Ok("running") => std::thread::sleep(Duration::from_secs(3)),
            _ => (),
        }
    }

    #[cfg(windows)]
    #[test]
    fn association_validation_rejects_shell_scripts_relative_paths_and_non_web_protocols() {
        for value in [
            "cmd.exe",
            "C:/Windows/System32/cmd.exe",
            "C:/Windows/System32/rundll32.exe",
            "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
            "C:/browser.cmd",
            "\\\\host\\share\\browser.exe",
        ] {
            assert!(validate_browser_executable(Path::new(value)).is_err());
        }
        for protocol in ["", "file", "javascript", "https\0cmd", "HTTPS"] {
            assert_eq!(selected_browser(protocol), Err(UNAVAILABLE.into()));
        }
    }
}

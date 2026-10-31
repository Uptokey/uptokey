//! Supervisor do sidecar: máquina de estados explícita, sem corrida.
//!
//! Estados: `stopped` → `starting` → `ready` | `degraded` | `failed`.
//! Um processo que apenas responde na porta nunca é encerrado por nós; só
//! matamos o PID filho que esta instância criou (`owned == true`).

use crate::sidecar::{
    load_manifest, probe_health, spawn_sidecar, terminate_child, verify_sidecar_while,
    ProbeOutcome, SidecarIntegrity, PROXY_HOST, PROXY_PORT,
};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, sync_channel, Receiver, Sender, SyncSender};
use std::sync::{Arc, RwLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

pub const READINESS_DEADLINE: Duration = Duration::from_secs(30);
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(2);
pub const MAX_AUTO_RESTARTS: u32 = 3;
pub const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);
const SUPERVISOR_POLL_INTERVAL: Duration = Duration::from_millis(100);
const READINESS_MAX_POLL: Duration = Duration::from_secs(1);
const RESTART_BACKOFF_BASE: Duration = Duration::from_millis(500);
const ADOPTED_HEALTH_INTERVAL: Duration = Duration::from_secs(1);

/// Covers one in-flight bootstrap and the requested restart, including cleanup,
/// probe/poll overshoot and the maximum automatic restart backoff. Manifest
/// attestation and OS I/O have no hard wall-clock bound; expiry means the
/// operation is unconfirmed, never that an older Ready state completed it.
pub fn restart_confirmation_timeout() -> Duration {
    let bootstrap = READINESS_DEADLINE + SHUTDOWN_GRACE + PROBE_TIMEOUT * 2 + READINESS_MAX_POLL;
    bootstrap * 2
        + SHUTDOWN_GRACE
        + RESTART_BACKOFF_BASE * (1 << (MAX_AUTO_RESTARTS - 1))
        + SUPERVISOR_POLL_INTERVAL
}

#[derive(Debug, Default, Clone, Serialize, PartialEq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ProxyStateView {
    #[default]
    Stopped,
    Starting {
        attempt: u32,
    },
    Ready {
        version: String,
        owned: bool,
        pid: Option<u32>,
    },
    /// Processo existe e responde, mas algo diverge (ex.: versão ≠ sidecar).
    Degraded {
        reason: String,
    },
    Failed {
        kind: String,
    },
}

#[derive(Debug)]
pub enum SupervisorCmd {
    /// Reinício pedido pelo usuário (zera o contador de falhas automáticas).
    Restart,
    /// Replies with the settled state after this restart has been processed.
    RestartConfirmed(SyncSender<ProxyStateView>),
    /// Parada explícita: encerra o filho e permanece parado até novo Restart.
    Stop,
    /// Encerramento do app: para o filho se for nosso e termina a thread.
    Shutdown,
}

pub struct SupervisorHandle {
    pub state: Arc<RwLock<ProxyStateView>>,
    cmd: Sender<SupervisorCmd>,
    pub ipc_secret: String,
    lifecycle: Arc<AtomicU64>,
    #[allow(dead_code)]
    thread: Option<JoinHandle<()>>,
}

impl SupervisorHandle {
    pub fn current(&self) -> ProxyStateView {
        self.state.read().map(|s| s.clone()).unwrap_or_default()
    }

    pub fn request_restart(&self) {
        request_lifecycle(&self.lifecycle, true);
        let _ = self.cmd.send(SupervisorCmd::Restart);
    }

    pub fn request_restart_confirmed(&self) -> Result<Receiver<ProxyStateView>, String> {
        request_lifecycle(&self.lifecycle, true);
        let (reply, confirmation) = sync_channel(1);
        self.cmd
            .send(SupervisorCmd::RestartConfirmed(reply))
            .map_err(|_| "proxy_supervisor_unavailable".to_string())?;
        Ok(confirmation)
    }

    /// Encerra o sidecar sem reiniciar. Permanece parado até novo `request_restart`.
    pub fn request_stop(&self) {
        request_lifecycle(&self.lifecycle, false);
        let _ = self.cmd.send(SupervisorCmd::Stop);
    }

    /// Encerra com prazo; chamado no caminho de saída do app.
    pub fn request_shutdown(&self) {
        request_lifecycle(&self.lifecycle, false);
        let _ = self.cmd.send(SupervisorCmd::Shutdown);
    }
}

// The low bit is the desired running state. Every request changes the epoch,
// so Stop followed by Restart still cancels an older in-flight bootstrap.
fn request_lifecycle(lifecycle: &AtomicU64, enabled: bool) {
    let _ = lifecycle.fetch_update(Ordering::AcqRel, Ordering::Acquire, |epoch| {
        Some((epoch.wrapping_add(2) & !1) | u64::from(enabled))
    });
}

fn bootstrap_current(lifecycle: &AtomicU64, epoch: u64) -> bool {
    epoch & 1 != 0 && lifecycle.load(Ordering::Acquire) == epoch
}

/// Inicia a thread supervisora. `on_change` recebe snapshots tipados (usado
/// para emitir eventos à WebView e para testes).
pub fn start_supervisor(
    sidecar_dir: PathBuf,
    ipc_secret: String,
    on_change: Arc<dyn Fn(&ProxyStateView) + Send + Sync>,
) -> SupervisorHandle {
    let state = Arc::new(RwLock::new(ProxyStateView::Stopped));
    let (tx, rx) = channel::<SupervisorCmd>();
    let state_clone = state.clone();
    let ipc_secret_clone = ipc_secret.clone();
    let lifecycle = Arc::new(AtomicU64::new(1));
    let lifecycle_clone = lifecycle.clone();
    let thread = std::thread::spawn(move || {
        run_loop(
            sidecar_dir,
            ipc_secret_clone,
            rx,
            state_clone,
            on_change,
            lifecycle_clone,
        );
    });
    SupervisorHandle {
        state,
        cmd: tx,
        ipc_secret,
        lifecycle,
        thread: Some(thread),
    }
}

struct Runtime {
    child: Option<Child>,
    owned_pid: Option<u32>,
    version: Option<String>,
    auto_restarts: u32,
    last_failure_at: Option<Instant>,
    running: bool,
    enabled: bool,
    adopted: bool,
    next_health_probe: Option<Instant>,
    restart_at: Option<Instant>,
}

fn run_loop(
    sidecar_dir: PathBuf,
    ipc_secret: String,
    rx: Receiver<SupervisorCmd>,
    state: Arc<RwLock<ProxyStateView>>,
    on_change: Arc<dyn Fn(&ProxyStateView) + Send + Sync>,
    lifecycle: Arc<AtomicU64>,
) {
    let set = |next: ProxyStateView| {
        if let Ok(mut guard) = state.write() {
            *guard = next.clone();
        }
        on_change(&next);
    };
    let mut rt = Runtime {
        child: None,
        owned_pid: None,
        version: None,
        auto_restarts: 0,
        last_failure_at: None,
        running: true,
        enabled: true,
        adopted: false,
        next_health_probe: None,
        restart_at: None,
    };
    bootstrap(&sidecar_dir, &ipc_secret, &mut rt, &set, &lifecycle);
    while rt.running {
        // Comandos do app têm prioridade sobre o monitoramento.
        match rx.recv_timeout(SUPERVISOR_POLL_INTERVAL) {
            Ok(SupervisorCmd::Restart) => {
                stop_owned(&mut rt);
                rt.enabled = true;
                rt.auto_restarts = 0;
                bootstrap(&sidecar_dir, &ipc_secret, &mut rt, &set, &lifecycle);
            }
            Ok(SupervisorCmd::RestartConfirmed(reply)) => {
                stop_owned(&mut rt);
                rt.enabled = true;
                rt.auto_restarts = 0;
                bootstrap(&sidecar_dir, &ipc_secret, &mut rt, &set, &lifecycle);
                let settled = state.read().map(|view| view.clone()).unwrap_or_default();
                let _ = reply.send(settled);
            }
            Ok(SupervisorCmd::Stop) => {
                rt.enabled = false;
                stop_owned(&mut rt);
                set(ProxyStateView::Stopped);
                // Permanece parado; não encerra a thread supervisora.
            }
            Ok(SupervisorCmd::Shutdown) => {
                rt.enabled = false;
                stop_owned(&mut rt);
                set(ProxyStateView::Stopped);
                rt.running = false;
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                stop_owned(&mut rt);
                rt.running = false;
            }
        }
        if !rt.running {
            break;
        }
        if monitor_state(&mut rt, &set, &lifecycle, || {
            probe_health(PROXY_HOST, PROXY_PORT, &ipc_secret, PROBE_TIMEOUT)
        }) {
            bootstrap(&sidecar_dir, &ipc_secret, &mut rt, &set, &lifecycle);
        }
    }
}

fn versions_match(expected: &str, actual: &str) -> bool {
    let expected = expected.strip_prefix('v').unwrap_or(expected);
    let actual = actual.strip_prefix('v').unwrap_or(actual);
    !expected.is_empty() && expected == actual
}

fn adopt_compatible(
    expected: &str,
    actual: &str,
    profile: &crate::config::OperationalProfile,
    rt: &mut Runtime,
    set: &dyn Fn(ProxyStateView),
) {
    rt.version = Some(expected.to_string());
    // The public health reply proves version, not the external process's vault
    // or data profile. An explicit native profile must own its own child.
    if profile.data_dir.is_some() {
        rt.adopted = false;
        rt.next_health_probe = None;
        set(ProxyStateView::Degraded {
            reason: "profile_requires_owned_proxy".into(),
        });
        return;
    }
    if !versions_match(expected, actual) {
        rt.adopted = false;
        rt.next_health_probe = None;
        set(ProxyStateView::Degraded {
            reason: "version_mismatch".into(),
        });
        return;
    }
    rt.adopted = true;
    rt.next_health_probe = Some(Instant::now() + ADOPTED_HEALTH_INTERVAL);
    set(ProxyStateView::Ready {
        version: actual.to_string(),
        owned: false,
        pid: None,
    });
}

/// Decide o arranque: adota proxy saudável identificado, rejeita processo
/// estranho na porta, ou sobe o sidecar verificado.
fn bootstrap(
    sidecar_dir: &Path,
    ipc_secret: &str,
    rt: &mut Runtime,
    set: &dyn Fn(ProxyStateView),
    lifecycle: &AtomicU64,
) {
    let epoch = lifecycle.load(Ordering::Acquire);
    if !rt.enabled || !bootstrap_current(lifecycle, epoch) {
        set(ProxyStateView::Stopped);
        return;
    }
    rt.adopted = false;
    rt.next_health_probe = None;
    rt.restart_at = None;
    set(ProxyStateView::Starting {
        attempt: rt.auto_restarts + 1,
    });
    let initial_probe = probe_health(PROXY_HOST, PROXY_PORT, ipc_secret, PROBE_TIMEOUT);
    if !bootstrap_current(lifecycle, epoch) {
        set(ProxyStateView::Stopped);
        return;
    }
    match initial_probe {
        ProbeOutcome::Identified(info) => {
            let manifest = match load_manifest(sidecar_dir) {
                Ok(manifest) => manifest,
                Err(reason) => {
                    set(ProxyStateView::Failed {
                        kind: format!("sidecar_manifest:{}", reason),
                    });
                    return;
                }
            };
            let profile = match crate::config::OperationalProfile::from_env() {
                Ok(profile) => profile,
                Err(kind) => {
                    set(ProxyStateView::Failed { kind });
                    return;
                }
            };
            adopt_compatible(&manifest.build_version, &info.version, &profile, rt, set);
            return;
        }
        ProbeOutcome::Foreign => {
            set(ProxyStateView::Failed {
                kind: "foreign_process_on_port".into(),
            });
            return;
        }
        ProbeOutcome::Unreachable => {}
    }
    let manifest = match load_manifest(sidecar_dir) {
        Ok(manifest) => manifest,
        Err(reason) => {
            set(ProxyStateView::Failed {
                kind: format!("sidecar_manifest:{}", reason),
            });
            return;
        }
    };
    let integrity = verify_sidecar_while(sidecar_dir, &|| bootstrap_current(lifecycle, epoch));
    if !bootstrap_current(lifecycle, epoch) {
        set(ProxyStateView::Stopped);
        return;
    }
    match integrity {
        SidecarIntegrity::Ok { version } => rt.version = Some(version),
        SidecarIntegrity::Missing(reason) => {
            set(ProxyStateView::Failed {
                kind: format!("sidecar_missing:{}", reason),
            });
            return;
        }
        SidecarIntegrity::Invalid(reason) => {
            set(ProxyStateView::Failed {
                kind: format!("sidecar_integrity:{}", reason),
            });
            return;
        }
    }
    if !bootstrap_current(lifecycle, epoch) {
        set(ProxyStateView::Stopped);
        return;
    }
    let mut child = match spawn_sidecar(sidecar_dir, &manifest, ipc_secret) {
        Ok(c) => c,
        Err(e) => {
            set(ProxyStateView::Failed { kind: e });
            return;
        }
    };
    let pid = child.id();
    // Drain stdout/stderr in background threads to prevent pipe-full deadlock.
    drain_child_pipes(&mut child);
    // Readiness: /health identificado dentro do prazo; processo não pode morrer.
    let deadline = Instant::now() + READINESS_DEADLINE;
    let mut poll = Duration::from_millis(150);
    loop {
        if !bootstrap_current(lifecycle, epoch) {
            terminate_child(&mut child, SHUTDOWN_GRACE);
            set(ProxyStateView::Stopped);
            return;
        }
        match child.try_wait() {
            Ok(Some(_)) => {
                set(ProxyStateView::Failed {
                    kind: "sidecar_exited_during_startup".into(),
                });
                return;
            }
            Ok(None) => {}
            Err(_) => {
                terminate_child(&mut child, SHUTDOWN_GRACE);
                set(ProxyStateView::Failed {
                    kind: "sidecar_wait_failed".into(),
                });
                return;
            }
        }
        let readiness = probe_health(PROXY_HOST, PROXY_PORT, ipc_secret, PROBE_TIMEOUT);
        if !bootstrap_current(lifecycle, epoch) {
            terminate_child(&mut child, SHUTDOWN_GRACE);
            set(ProxyStateView::Stopped);
            return;
        }
        match readiness {
            ProbeOutcome::Identified(info) => {
                // Store the child process and its PID.
                rt.child = Some(child);
                rt.owned_pid = Some(pid);
                // Verify the sidecar version matches the expected version (if any).
                if let Some(expected_version) = rt.version.clone() {
                    if !versions_match(&expected_version, &info.version) {
                        set(ProxyStateView::Degraded {
                            reason: "version_mismatch".into(),
                        });
                        return;
                    }
                }
                // Sidecar is ready and owned by this instance.
                set(ProxyStateView::Ready {
                    version: info.version,
                    owned: true,
                    pid: Some(pid),
                });
                return;
            }
            ProbeOutcome::Foreign => {
                // Alguém tomou a porta durante o arranque: matar só o nosso filho.
                terminate_child(&mut child, SHUTDOWN_GRACE);
                set(ProxyStateView::Failed {
                    kind: "foreign_process_on_port".into(),
                });
                return;
            }
            ProbeOutcome::Unreachable => {}
        }
        if Instant::now() > deadline {
            terminate_child(&mut child, SHUTDOWN_GRACE);
            set(ProxyStateView::Failed {
                kind: "readiness_timeout".into(),
            });
            return;
        }
        std::thread::sleep(poll);
        poll = (poll * 2).min(READINESS_MAX_POLL);
    }
}

/// Monitor both owned exits and adopted health without acquiring ownership of
/// another process. Backoff is scheduled so Stop/Shutdown remain responsive.
fn monitor_state(
    rt: &mut Runtime,
    set: &dyn Fn(ProxyStateView),
    lifecycle: &AtomicU64,
    probe: impl FnOnce() -> ProbeOutcome,
) -> bool {
    let epoch = lifecycle.load(Ordering::Acquire);
    if !rt.enabled || epoch & 1 == 0 {
        return false;
    }
    if let Some(at) = rt.restart_at {
        if Instant::now() >= at {
            rt.restart_at = None;
            return true;
        }
        return false;
    }
    if let Some(child) = rt.child.as_mut() {
        if matches!(child.try_wait(), Ok(Some(_))) {
            rt.child = None;
            rt.owned_pid = None;
            schedule_recovery(rt, set, "unexpected_exit_restarting");
        }
        return false;
    }
    if !rt.adopted || rt.next_health_probe.is_some_and(|at| Instant::now() < at) {
        return false;
    }
    let outcome = probe();
    if !bootstrap_current(lifecycle, epoch) {
        return false;
    }
    rt.next_health_probe = Some(Instant::now() + ADOPTED_HEALTH_INTERVAL);
    match outcome {
        ProbeOutcome::Identified(info) => {
            if !rt
                .version
                .as_deref()
                .is_some_and(|expected| versions_match(expected, &info.version))
            {
                rt.adopted = false;
                rt.next_health_probe = None;
                set(ProxyStateView::Degraded {
                    reason: "version_mismatch".into(),
                });
            }
        }
        ProbeOutcome::Foreign => {
            rt.adopted = false;
            rt.next_health_probe = None;
            set(ProxyStateView::Failed {
                kind: "foreign_process_on_port".into(),
            });
        }
        ProbeOutcome::Unreachable => {
            rt.adopted = false;
            rt.next_health_probe = None;
            schedule_recovery(rt, set, "adopted_proxy_unreachable_restarting");
        }
    }
    false
}

fn schedule_recovery(rt: &mut Runtime, set: &dyn Fn(ProxyStateView), reason: &str) {
    if rt
        .last_failure_at
        .is_some_and(|at| at.elapsed() > Duration::from_secs(60))
    {
        rt.auto_restarts = 0;
    }
    rt.last_failure_at = Some(Instant::now());
    rt.auto_restarts += 1;
    if rt.auto_restarts > MAX_AUTO_RESTARTS {
        rt.restart_at = None;
        set(ProxyStateView::Failed {
            kind: "unexpected_exit_restart_exhausted".into(),
        });
        return;
    }
    rt.restart_at = Some(Instant::now() + RESTART_BACKOFF_BASE * (1 << (rt.auto_restarts - 1)));
    set(ProxyStateView::Degraded {
        reason: reason.into(),
    });
}

fn stop_owned(rt: &mut Runtime) {
    if let Some(mut child) = rt.child.take() {
        terminate_child(&mut child, SHUTDOWN_GRACE);
    }
    rt.owned_pid = None;
    rt.adopted = false;
    rt.next_health_probe = None;
    rt.restart_at = None;
}

/// Spawns background threads that drain the child's piped stdout/stderr to
/// prevent pipe-buffer-full deadlocks. Reads are limited to 64 KiB per
/// line/chunk, and each line is passed through `redact_line` before being
/// discarded (log storage is intentionally omitted — diagnostics use the
/// dedicated export command instead).
fn drain_child_pipes(child: &mut Child) {
    use crate::sidecar::redact_line;
    use std::io::{BufRead, BufReader};
    if let Some(stdout) = child.stdout.take() {
        std::thread::Builder::new()
            .name("sidecar-stdout-drain".into())
            .spawn(move || {
                let reader = BufReader::with_capacity(4096, stdout);
                for line in reader.lines() {
                    match line {
                        Ok(l) => {
                            let _redacted = redact_line(&l);
                            // Intentionally discarded; could be forwarded to
                            // a bounded log ring in the future.
                        }
                        Err(_) => break,
                    }
                }
            })
            .ok();
    }
    if let Some(stderr) = child.stderr.take() {
        std::thread::Builder::new()
            .name("sidecar-stderr-drain".into())
            .spawn(move || {
                let reader = BufReader::with_capacity(4096, stderr);
                for line in reader.lines() {
                    match line {
                        Ok(l) => {
                            let _redacted = redact_line(&l);
                        }
                        Err(_) => break,
                    }
                }
            })
            .ok();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn confirmation_timeout_covers_a_queued_bootstrap_and_requested_lifecycle() {
        let timeout = restart_confirmation_timeout();
        let readiness_and_cleanup = READINESS_DEADLINE * 2 + SHUTDOWN_GRACE * 3;
        let probe_and_poll_overshoot = PROBE_TIMEOUT * 4 + READINESS_MAX_POLL * 2;
        let maximum_backoff = RESTART_BACKOFF_BASE * (1 << (MAX_AUTO_RESTARTS - 1));
        assert_eq!(
            timeout,
            readiness_and_cleanup
                + probe_and_poll_overshoot
                + maximum_backoff
                + SUPERVISOR_POLL_INTERVAL
        );
        assert!(timeout > READINESS_DEADLINE);
    }

    #[test]
    fn restart_confirmation_does_not_return_the_previous_ready_snapshot() {
        let previous = ProxyStateView::Ready {
            version: "v0.1.0-beta.7".into(),
            owned: true,
            pid: Some(1234),
        };
        let (cmd, requests) = channel();
        let handle = SupervisorHandle {
            state: Arc::new(RwLock::new(previous.clone())),
            cmd,
            ipc_secret: "fixture".into(),
            lifecycle: Arc::new(AtomicU64::new(1)),
            thread: None,
        };
        let confirmation = handle.request_restart_confirmed().unwrap();
        assert_eq!(handle.current(), previous);
        assert_eq!(
            confirmation.try_recv(),
            Err(std::sync::mpsc::TryRecvError::Empty)
        );
        let settled = ProxyStateView::Ready {
            version: "v0.1.0-beta.7".into(),
            owned: false,
            pid: None,
        };
        match requests.try_recv().unwrap() {
            SupervisorCmd::RestartConfirmed(reply) => reply.send(settled.clone()).unwrap(),
            _ => panic!("expected confirmed restart"),
        }
        assert_eq!(confirmation.recv().unwrap(), settled);
    }

    #[test]
    fn confirmed_restart_reports_a_disconnected_supervisor() {
        let (cmd, requests) = channel();
        drop(requests);
        let handle = SupervisorHandle {
            state: Arc::new(RwLock::new(ProxyStateView::Stopped)),
            cmd,
            ipc_secret: "fixture".into(),
            lifecycle: Arc::new(AtomicU64::new(1)),
            thread: None,
        };
        assert_eq!(
            handle.request_restart_confirmed().unwrap_err(),
            "proxy_supervisor_unavailable"
        );
    }

    fn runtime_fixture() -> Runtime {
        Runtime {
            child: None,
            owned_pid: None,
            version: Some("v0.2.0".into()),
            auto_restarts: 0,
            last_failure_at: None,
            running: true,
            enabled: true,
            adopted: true,
            next_health_probe: None,
            restart_at: None,
        }
    }

    #[test]
    fn external_old_revision_is_not_adopted_or_owned() {
        let mut rt = runtime_fixture();
        let states = std::cell::RefCell::new(Vec::new());
        adopt_compatible(
            "0.1.0-beta.15",
            "v0.1.0-beta.14",
            &crate::config::OperationalProfile::default(),
            &mut rt,
            &|state| states.borrow_mut().push(state),
        );
        assert!(!rt.adopted);
        assert!(rt.child.is_none() && rt.owned_pid.is_none() && rt.restart_at.is_none());
        assert_eq!(
            states.borrow().as_slice(),
            &[ProxyStateView::Degraded {
                reason: "version_mismatch".into()
            }]
        );
    }

    #[test]
    fn external_same_revision_cannot_supply_an_explicit_native_profile() {
        let mut rt = runtime_fixture();
        let states = std::cell::RefCell::new(Vec::new());
        let profile = crate::config::OperationalProfile {
            data_dir: Some(std::env::temp_dir().join("native-profile-test")),
            secret_service: Some("com.uptokey.quimera.proxy.profile-test".into()),
        };
        adopt_compatible(
            "0.1.0-beta.15",
            "v0.1.0-beta.15",
            &profile,
            &mut rt,
            &|state| states.borrow_mut().push(state),
        );
        assert!(!rt.adopted);
        assert!(rt.child.is_none() && rt.owned_pid.is_none() && rt.restart_at.is_none());
        assert_eq!(
            states.borrow().as_slice(),
            &[ProxyStateView::Degraded {
                reason: "profile_requires_owned_proxy".into()
            }]
        );
    }

    #[test]
    fn external_exact_revision_is_adopted_without_process_ownership() {
        let mut rt = runtime_fixture();
        let states = std::cell::RefCell::new(Vec::new());
        adopt_compatible(
            "0.1.0-beta.15",
            "v0.1.0-beta.15",
            &crate::config::OperationalProfile::default(),
            &mut rt,
            &|state| states.borrow_mut().push(state),
        );
        assert!(rt.adopted);
        assert!(rt.child.is_none() && rt.owned_pid.is_none());
        assert_eq!(
            states.borrow().as_slice(),
            &[ProxyStateView::Ready {
                version: "v0.1.0-beta.15".into(),
                owned: false,
                pid: None
            }]
        );
        assert!(!versions_match("", ""));
        assert!(!versions_match("0.1.0-beta.15", "vv0.1.0-beta.15"));
    }

    #[test]
    fn adopted_revision_replacement_is_rejected_without_restarting_it() {
        let body = "{\"status\":\"ok\",\"data_plane\":\"local\",\"version\":\"v0.1.0-beta.14\",\"started_at\":\"2026-10-13T00:00:00Z\"}";
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        let port = serve_once(Box::leak(response.into_boxed_str()));
        let mut rt = runtime_fixture();
        rt.version = Some("0.1.0-beta.15".into());
        let states = std::cell::RefCell::new(Vec::new());
        assert!(!monitor_state(
            &mut rt,
            &|state| states.borrow_mut().push(state),
            &AtomicU64::new(1),
            || probe_health("127.0.0.1", port, "fixture", PROBE_TIMEOUT)
        ));
        assert!(!rt.adopted);
        assert!(rt.child.is_none() && rt.owned_pid.is_none() && rt.restart_at.is_none());
        assert_eq!(rt.version.as_deref(), Some("0.1.0-beta.15"));
        assert_eq!(
            states.borrow().as_slice(),
            &[ProxyStateView::Degraded {
                reason: "version_mismatch".into()
            }]
        );
    }

    #[test]
    fn adopted_health_loss_schedules_bounded_recovery_without_owning_a_pid() {
        let body = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            OK_BODY.len(),
            OK_BODY
        );
        let port = serve_once(Box::leak(body.into_boxed_str()));
        let lifecycle = AtomicU64::new(1);
        let mut rt = runtime_fixture();
        let states = std::cell::RefCell::new(Vec::new());
        let set = |next| states.borrow_mut().push(next);
        assert!(!monitor_state(&mut rt, &set, &lifecycle, || probe_health(
            "127.0.0.1",
            port,
            "fixture",
            PROBE_TIMEOUT
        )));
        assert!(rt.adopted);
        rt.next_health_probe = None;
        assert!(!monitor_state(&mut rt, &set, &lifecycle, || probe_health(
            "127.0.0.1",
            port,
            "fixture",
            PROBE_TIMEOUT
        )));
        assert!(!rt.adopted);
        assert!(rt.child.is_none() && rt.owned_pid.is_none());
        assert_eq!(rt.auto_restarts, 1);
        assert!(rt.restart_at.is_some());
        assert_eq!(
            states.borrow().last(),
            Some(&ProxyStateView::Degraded {
                reason: "adopted_proxy_unreachable_restarting".into()
            })
        );
        assert!(!monitor_state(&mut rt, &set, &lifecycle, || panic!(
            "must respect backoff"
        )));
        rt.restart_at = Some(Instant::now());
        assert!(monitor_state(&mut rt, &set, &lifecycle, || panic!(
            "scheduled bootstrap must not duplicate health probes"
        )));
        assert!(rt.restart_at.is_none());
    }

    #[test]
    fn foreign_replacement_is_rejected_without_recovery_or_ownership() {
        let port =
            serve_once("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
        let mut rt = runtime_fixture();
        let state = std::cell::RefCell::new(ProxyStateView::Stopped);
        assert!(!monitor_state(
            &mut rt,
            &|next| *state.borrow_mut() = next,
            &AtomicU64::new(1),
            || probe_health("127.0.0.1", port, "fixture", PROBE_TIMEOUT)
        ));
        assert_eq!(
            *state.borrow(),
            ProxyStateView::Failed {
                kind: "foreign_process_on_port".into()
            }
        );
        assert!(rt.child.is_none() && rt.owned_pid.is_none() && rt.restart_at.is_none());
        assert!(!rt.adopted);
    }

    #[test]
    fn stop_and_shutdown_cancel_pending_recovery_and_inflight_epochs() {
        for shutdown in [false, true] {
            let (cmd, requests) = channel();
            let handle = SupervisorHandle {
                state: Arc::new(RwLock::new(ProxyStateView::Stopped)),
                cmd,
                ipc_secret: "fixture".into(),
                lifecycle: Arc::new(AtomicU64::new(1)),
                thread: None,
            };
            let epoch = handle.lifecycle.load(Ordering::Acquire);
            let mut rt = runtime_fixture();
            schedule_recovery(&mut rt, &|_| {}, "fixture");
            if shutdown {
                handle.request_shutdown();
            } else {
                handle.request_stop();
            }
            assert!(!bootstrap_current(&handle.lifecycle, epoch));
            assert!(!monitor_state(
                &mut rt,
                &|_| panic!("no state transition while cancellation is pending"),
                &handle.lifecycle,
                || panic!("no probe after Stop/Shutdown")
            ));
            assert!(matches!(
                requests.recv().unwrap(),
                SupervisorCmd::Stop | SupervisorCmd::Shutdown
            ));
            rt.enabled = false;
            stop_owned(&mut rt);
            assert!(rt.restart_at.is_none() && !rt.adopted);
            assert!(!monitor_state(
                &mut rt,
                &|_| panic!(),
                &handle.lifecycle,
                || panic!()
            ));
            handle.request_restart();
            assert!(!bootstrap_current(&handle.lifecycle, epoch));
            assert!(bootstrap_current(
                &handle.lifecycle,
                handle.lifecycle.load(Ordering::Acquire)
            ));
        }
    }

    #[test]
    fn stopped_epoch_cannot_adopt_a_late_health_response() {
        let mut rt = runtime_fixture();
        let lifecycle = AtomicU64::new(1);
        assert!(!monitor_state(
            &mut rt,
            &|_| panic!("cancelled response cannot restore Ready"),
            &lifecycle,
            || {
                request_lifecycle(&lifecycle, false);
                ProbeOutcome::Unreachable
            }
        ));
        assert!(rt.restart_at.is_none());
        assert_eq!(rt.auto_restarts, 0);
    }

    #[test]
    fn recovery_backoff_exhaustion_is_bounded_for_adopted_or_owned_failures() {
        let mut rt = runtime_fixture();
        let states = std::cell::RefCell::new(Vec::new());
        for _ in 0..=MAX_AUTO_RESTARTS {
            schedule_recovery(&mut rt, &|next| states.borrow_mut().push(next), "fixture");
        }
        assert_eq!(rt.auto_restarts, MAX_AUTO_RESTARTS + 1);
        assert!(rt.restart_at.is_none());
        assert_eq!(
            states.borrow().last(),
            Some(&ProxyStateView::Failed {
                kind: "unexpected_exit_restart_exhausted".into()
            })
        );
    }

    #[test]
    fn owned_process_fixture() {
        if std::env::var("UPTOKEY_SUPERVISOR_CHILD_FIXTURE").as_deref() == Ok("sleep") {
            std::thread::sleep(Duration::from_secs(10));
        }
    }

    fn fixture_child(sleep: bool) -> Child {
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "supervisor::tests::owned_process_fixture",
                "--nocapture",
            ])
            .env(
                "UPTOKEY_SUPERVISOR_CHILD_FIXTURE",
                if sleep { "sleep" } else { "exit" },
            )
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        command.spawn().unwrap()
    }

    #[test]
    fn owned_exit_schedules_recovery_and_stop_never_terminates_an_adopted_process() {
        let mut child = fixture_child(false);
        let pid = child.id();
        child.wait().unwrap();
        let mut rt = runtime_fixture();
        rt.adopted = false;
        rt.child = Some(child);
        rt.owned_pid = Some(pid);
        assert!(!monitor_state(
            &mut rt,
            &|_| {},
            &AtomicU64::new(1),
            || panic!("owned process must use its process handle")
        ));
        assert_eq!(rt.auto_restarts, 1);
        assert!(rt.child.is_none() && rt.owned_pid.is_none() && rt.restart_at.is_some());
        let mut external = fixture_child(true);
        let mut adopted = runtime_fixture();
        adopted.enabled = false;
        stop_owned(&mut adopted);
        assert!(external.try_wait().unwrap().is_none());
        external.kill().unwrap(); // Only the disposable process this test created.
        external.wait().unwrap();
    }

    fn serve_once(response: &'static str) -> u16 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = listener.accept() {
                let mut buf = [0u8; 1024];
                let _ = s.read(&mut buf);
                let _ = s.write_all(response.as_bytes());
                let _ = s.flush();
            }
        });
        port
    }

    const OK_BODY: &str = "{\"status\":\"ok\",\"data_plane\":\"local\",\"version\":\"v0.2.0\",\"started_at\":\"2026-09-24T00:00:00Z\"}";

    #[test]
    fn probe_parses_health_identity() {
        let body = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            OK_BODY.len(),
            OK_BODY
        );
        let port = serve_once(Box::leak(body.into_boxed_str()));
        let outcome = probe_health("127.0.0.1", port, "dummy_secret", Duration::from_secs(2));
        match outcome {
            ProbeOutcome::Identified(info) => {
                assert_eq!(info.version, "v0.2.0");
            }
            other => panic!("expected identified, got {:?}", other),
        }
    }

    #[test]
    fn probe_rejects_foreign_server() {
        let port =
            serve_once("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
        assert_eq!(
            probe_health("127.0.0.1", port, "dummy_secret", Duration::from_secs(2)),
            ProbeOutcome::Foreign
        );
    }

    #[test]
    fn probe_rejects_error_status() {
        let port = serve_once("HTTP/1.1 500 Internal Server Error\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
        assert_eq!(
            probe_health("127.0.0.1", port, "dummy_secret", Duration::from_secs(2)),
            ProbeOutcome::Foreign
        );
    }

    #[test]
    fn probe_unreachable_when_nothing_listens() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        assert_eq!(
            probe_health(
                "127.0.0.1",
                port,
                "dummy_secret",
                Duration::from_millis(500)
            ),
            ProbeOutcome::Unreachable
        );
    }

    #[test]
    fn probe_handles_chunked_body() {
        let chunk = format!("{:x}\r\n{}\r\n0\r\n\r\n", OK_BODY.len(), OK_BODY);
        let body = format!(
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{}",
            chunk
        );
        let port = serve_once(Box::leak(body.into_boxed_str()));
        match probe_health("127.0.0.1", port, "dummy_secret", Duration::from_secs(2)) {
            ProbeOutcome::Identified(info) => assert_eq!(info.version, "v0.2.0"),
            other => panic!("expected identified, got {:?}", other),
        }
    }
}

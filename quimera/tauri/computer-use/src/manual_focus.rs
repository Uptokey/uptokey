//! Bounded manual return to the already granted target after canonical approval.
//! The probe observes only; this module cannot activate windows or dispatch input.
use std::time::Duration;
use std::{
    io,
    pin::Pin,
    task::{Context, Poll},
};
use tokio::io::{AsyncRead, ReadBuf};

pub const MANUAL_FOCUS_TIMEOUT: Duration = Duration::from_secs(15);
const POLL_INTERVAL: Duration = Duration::from_millis(100);

// rmcp drains in-flight responses before cancelling their contexts on EOF.
// Observe closure in the original stdin reader, before that drain can start.
pub struct RevokeOnClose<R, F: FnMut()> {
    inner: R,
    on_close: F,
    closed: bool,
}
impl<R, F: FnMut()> RevokeOnClose<R, F> {
    pub fn new(inner: R, on_close: F) -> Self {
        Self {
            inner,
            on_close,
            closed: false,
        }
    }
    fn revoke(&mut self) {
        if !self.closed {
            self.closed = true;
            (self.on_close)();
        }
    }
}
impl<R: AsyncRead + Unpin, F: FnMut() + Unpin> AsyncRead for RevokeOnClose<R, F> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let available = buf.remaining();
        let before = buf.filled().len();
        let result = Pin::new(&mut this.inner).poll_read(cx, buf);
        if matches!(result, Poll::Ready(Err(_)))
            || (matches!(result, Poll::Ready(Ok(())))
                && available > 0
                && buf.filled().len() == before)
        {
            this.revoke();
        }
        result
    }
}
impl<R, F: FnMut()> Drop for RevokeOnClose<R, F> {
    fn drop(&mut self) {
        self.revoke();
    }
}

pub fn wait_for_manual_foreground(
    mut check: impl FnMut() -> Result<(), &'static str>,
    mut probe: impl FnMut() -> Result<(), &'static str>,
    mut elapsed: impl FnMut() -> Duration,
    mut pause: impl FnMut(Duration),
) -> Result<(), &'static str> {
    loop {
        check()?;
        if elapsed() >= MANUAL_FOCUS_TIMEOUT {
            return Err("manual_focus_timeout_recapture_required");
        }
        let result = probe();
        // Cancellation/revocation can arrive during native window enumeration.
        check()?;
        let spent = elapsed();
        if spent >= MANUAL_FOCUS_TIMEOUT {
            return Err("manual_focus_timeout_recapture_required");
        }
        match result {
            Ok(()) => return Ok(()),
            Err("target_not_foreground") => {
                pause(POLL_INTERVAL.min(MANUAL_FOCUS_TIMEOUT - spent));
            }
            Err(code) => return Err(code),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::{
        rc::Rc,
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        },
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn stdin_eof_revokes_before_return_and_prevents_resumed_input() {
        let revoked = Arc::new(AtomicBool::new(false));
        let closing = revoked.clone();
        let mut reader = RevokeOnClose::new(tokio::io::empty(), move || {
            closing.store(true, Ordering::Release)
        });
        assert_eq!(reader.read(&mut [0u8; 1]).await.unwrap(), 0);
        assert!(revoked.load(Ordering::Acquire));
        assert_eq!(
            wait_for_manual_foreground(
                || if revoked.load(Ordering::Acquire) {
                    Err("grant_revoked")
                } else {
                    Ok(())
                },
                || panic!("EOF must prevent even a foreground probe"),
                || Duration::ZERO,
                |_| panic!("unexpected pause")
            ),
            Err("grant_revoked")
        );
    }

    #[tokio::test]
    async fn data_and_pending_reads_do_not_revoke_but_later_eof_does_once() {
        let count = Rc::new(Cell::new(0));
        let closing = count.clone();
        let (reader, mut writer) = tokio::io::duplex(8);
        let mut reader = RevokeOnClose::new(reader, move || closing.set(closing.get() + 1));
        let waker = std::task::Waker::noop();
        let mut cx = Context::from_waker(waker);
        let mut byte = [0u8; 1];
        assert!(
            Pin::new(&mut reader)
                .poll_read(&mut cx, &mut ReadBuf::new(&mut byte))
                .is_pending()
        );
        assert_eq!(count.get(), 0);
        writer.write_all(b"x").await.unwrap();
        reader.read_exact(&mut byte).await.unwrap();
        assert_eq!(byte, *b"x");
        assert_eq!(count.get(), 0);
        drop(writer);
        assert_eq!(reader.read(&mut byte).await.unwrap(), 0);
        assert_eq!(count.get(), 1);
        drop(reader);
        assert_eq!(count.get(), 1);
    }

    #[test]
    fn zero_capacity_read_is_not_eof_and_drop_still_revokes() {
        let count = Cell::new(0);
        let mut reader = RevokeOnClose::new(tokio::io::empty(), || count.set(count.get() + 1));
        let mut cx = Context::from_waker(std::task::Waker::noop());
        assert!(matches!(
            Pin::new(&mut reader).poll_read(&mut cx, &mut ReadBuf::new(&mut [])),
            Poll::Ready(Ok(()))
        ));
        assert_eq!(count.get(), 0);
        drop(reader);
        assert_eq!(count.get(), 1);
    }

    #[test]
    fn read_error_revokes_before_return_even_with_zero_capacity() {
        struct Broken;
        impl AsyncRead for Broken {
            fn poll_read(
                self: Pin<&mut Self>,
                _: &mut Context<'_>,
                _: &mut ReadBuf<'_>,
            ) -> Poll<io::Result<()>> {
                Poll::Ready(Err(io::Error::other("synthetic read error")))
            }
        }
        let count = Cell::new(0);
        let mut reader = RevokeOnClose::new(Broken, || count.set(count.get() + 1));
        let mut cx = Context::from_waker(std::task::Waker::noop());
        assert!(matches!(
            Pin::new(&mut reader).poll_read(&mut cx, &mut ReadBuf::new(&mut [])),
            Poll::Ready(Err(_))
        ));
        assert_eq!(count.get(), 1);
    }

    #[test]
    fn already_foreground_needs_no_pause() {
        assert_eq!(
            wait_for_manual_foreground(
                || Ok(()),
                || Ok(()),
                || Duration::ZERO,
                |_| panic!("unexpected pause")
            ),
            Ok(())
        );
    }

    #[test]
    fn waits_only_for_foreground_with_bounded_intervals() {
        let ticks = Cell::new(Duration::ZERO);
        let probes = Cell::new(0);
        let result = wait_for_manual_foreground(
            || Ok(()),
            || {
                probes.set(probes.get() + 1);
                if probes.get() == 3 {
                    Ok(())
                } else {
                    Err("target_not_foreground")
                }
            },
            || ticks.get(),
            |duration| {
                assert_eq!(duration, POLL_INTERVAL);
                ticks.set(ticks.get() + duration);
            },
        );
        assert_eq!(result, Ok(()));
        assert_eq!(ticks.get(), Duration::from_millis(200));
        assert_eq!(probes.get(), 3);
    }

    #[test]
    fn timeout_never_probes_or_waits_past_deadline() {
        let ticks = Cell::new(Duration::ZERO);
        let probes = Cell::new(0);
        let result = wait_for_manual_foreground(
            || Ok(()),
            || {
                probes.set(probes.get() + 1);
                Err("target_not_foreground")
            },
            || ticks.get(),
            |duration| {
                assert!(duration <= POLL_INTERVAL);
                ticks.set(ticks.get() + duration);
            },
        );
        assert_eq!(result, Err("manual_focus_timeout_recapture_required"));
        assert_eq!(ticks.get(), MANUAL_FOCUS_TIMEOUT);
        assert_eq!(probes.get(), 150);
    }

    #[test]
    fn cancellation_or_revocation_before_probe_has_no_effect() {
        for code in [
            "request_cancelled",
            "grant_revoked",
            "observation_expired_recapture_required",
        ] {
            assert_eq!(
                wait_for_manual_foreground(
                    || Err(code),
                    || panic!("unexpected probe"),
                    || Duration::ZERO,
                    |_| panic!("unexpected pause")
                ),
                Err(code)
            );
        }
    }

    #[test]
    fn cancellation_revocation_or_expiry_during_probe_wins_over_new_foreground() {
        for code in [
            "request_cancelled",
            "grant_revoked",
            "observation_expired_recapture_required",
        ] {
            let cancelled = Cell::new(false);
            assert_eq!(
                wait_for_manual_foreground(
                    || if cancelled.get() { Err(code) } else { Ok(()) },
                    || {
                        cancelled.set(true);
                        Ok(())
                    },
                    || Duration::ZERO,
                    |_| panic!("unexpected pause")
                ),
                Err(code)
            );
        }
    }

    #[test]
    fn foreground_report_after_deadline_is_rejected() {
        let ticks = Cell::new(Duration::ZERO);
        assert_eq!(
            wait_for_manual_foreground(
                || Ok(()),
                || {
                    ticks.set(MANUAL_FOCUS_TIMEOUT);
                    Ok(())
                },
                || ticks.get(),
                |_| panic!("unexpected pause")
            ),
            Err("manual_focus_timeout_recapture_required")
        );
    }

    #[test]
    fn identity_permission_visibility_and_grant_failures_are_terminal() {
        for code in [
            "target_identity_changed",
            "target_window_closed",
            "window_enumeration_denied",
            "target_not_visible",
            "grant_expired_select_window_again",
            "grant_revoked",
        ] {
            assert_eq!(
                wait_for_manual_foreground(
                    || Ok(()),
                    || Err(code),
                    || Duration::ZERO,
                    |_| panic!("unexpected retry")
                ),
                Err(code)
            );
        }
    }
}

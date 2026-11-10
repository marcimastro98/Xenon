//! The ScreenCast portal behind a recording on GNOME and KDE (Wayland): their
//! compositors hand the screen only to the desktop's own dialog, which asks
//! the user once which screen to share; the answer is kept (a restore token
//! in ~/.local/state/xenon) so the next recordings start without asking until
//! the user revokes it. The session lives on its own thread for as long as the
//! returned `Session` does, and the PipeWire connection it opens is handed to
//! gst-launch (portal_plan.rs). When the desktop closes the session (the user
//! pressed "stop sharing"), `Stream::closed` says so.

use std::os::fd::OwnedFd;
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex};
use std::task::{Poll, Waker};
use std::time::Duration;

use ashpd::zbus::export::futures_core::Stream as Signals;

use ashpd::desktop::screencast::{CursorMode, Screencast, SelectSourcesOptions, SourceType};
use ashpd::desktop::{PersistMode, ResponseError};

use crate::proto::Fail;

/// How long the user has to pick a screen in the desktop's dialog.
const ASK: Duration = Duration::from_secs(120);
/// A restore token is short; anything longer is not one.
const TOKEN_MAX: usize = 512;

/// The shared screen, as a PipeWire stream.
pub struct Stream {
    pub node: u32,
    /// The screen's size, when the portal says.
    pub size: Option<(i64, i64)>,
    /// The PipeWire connection that may read `node`.
    pub fd: OwnedFd,
    /// Gets one message when the desktop closed the session; disconnected
    /// when the session ended from this side.
    pub closed: mpsc::Receiver<()>,
}

/// Keeps the portal session open; dropping it closes the session (the
/// desktop's "sharing your screen" indicator goes away).
pub struct Session {
    end: Arc<Mutex<End>>,
}

/// This side's end of the session, which the session thread awaits.
#[derive(Default)]
struct End {
    done: bool,
    waker: Option<Waker>,
}

impl Drop for Session {
    fn drop(&mut self) {
        if let Ok(mut end) = self.end.lock() {
            end.done = true;
            if let Some(w) = end.waker.take() {
                w.wake();
            }
        }
    }
}

/// Asks for the screen, through the dialog the first time. "cancelled" when
/// the user closed the dialog or did not answer in time.
pub fn open() -> Result<(Stream, Session), Fail> {
    let (tx, rx) = mpsc::channel();
    let end = Arc::new(Mutex::new(End::default()));
    let ended = end.clone();
    std::thread::spawn(move || {
        ashpd::zbus::block_on(async move {
            let proxy = match Screencast::new().await {
                Ok(p) => p,
                Err(e) => {
                    let _ = tx.send(Err(fail(e)));
                    return;
                }
            };
            let session = match proxy.create_session(Default::default()).await {
                Ok(s) => s,
                Err(e) => {
                    let _ = tx.send(Err(fail(e)));
                    return;
                }
            };
            // Listened to from the start, so a close is never missed.
            let closing = session.receive_closed().await.ok();
            let started = async {
                let cursor = proxy
                    .available_cursor_modes()
                    .await
                    .is_ok_and(|m| m.contains(CursorMode::Embedded));
                let token = read_token();
                let mut options = SelectSourcesOptions::default()
                    .set_sources(ashpd::enumflags2::BitFlags::from(SourceType::Monitor))
                    .set_multiple(false)
                    .set_persist_mode(PersistMode::ExplicitlyRevoked)
                    .set_restore_token(token.as_deref());
                if cursor {
                    options = options.set_cursor_mode(CursorMode::Embedded);
                }
                proxy.select_sources(&session, options).await?;
                let streams = proxy.start(&session, None, Default::default()).await?.response()?;
                if let Some(t) = streams.restore_token() {
                    save_token(t);
                }
                let first = streams.streams().first().cloned();
                let fd = proxy.open_pipe_wire_remote(&session, Default::default()).await?;
                Ok::<_, ashpd::Error>((first, fd))
            };
            match started.await {
                Ok((Some(s), fd)) => {
                    let size = s.size().map(|(w, h)| (i64::from(w), i64::from(h)));
                    let (closed_tx, closed) = mpsc::channel();
                    let stream = Stream { node: s.pipe_wire_node_id(), size, fd, closed };
                    // Until the recording ends (the Session is dropped) or the desktop closes it.
                    if tx.send(Ok(stream)).is_ok() && until_end(closing, &ended).await {
                        let _ = closed_tx.send(());
                    }
                }
                Ok((None, _)) => {
                    let _ = tx.send(Err(Fail::code("cancelled")));
                }
                Err(e) => {
                    let _ = tx.send(Err(fail(e)));
                }
            }
            let _ = session.close().await;
        });
    });
    match rx.recv_timeout(ASK) {
        Ok(Ok(stream)) => Ok((stream, Session { end })),
        Ok(Err(f)) => Err(f),
        // The dialog is still open: the thread closes the session when it ends.
        Err(_) => Err(Fail::code("cancelled")),
    }
}

/// Waits for the `Session` to be dropped (false) or for the desktop's Closed
/// signal (true). Without the signal (`closing` None) only the first counts.
async fn until_end<S: Signals>(closing: Option<S>, end: &Mutex<End>) -> bool {
    let mut closing = closing.map(Box::pin);
    std::future::poll_fn(|cx| {
        match end.lock() {
            Ok(mut e) if !e.done => e.waker = Some(cx.waker().clone()),
            _ => return Poll::Ready(false),
        }
        if let Some(signals) = closing.as_mut() {
            match signals.as_mut().poll_next(cx) {
                Poll::Ready(Some(_)) => return Poll::Ready(true),
                // The bus went away: only this side can end it now.
                Poll::Ready(None) => closing = None,
                Poll::Pending => {}
            }
        }
        Poll::Pending
    })
    .await
}

fn fail(e: ashpd::Error) -> Fail {
    match e {
        ashpd::Error::Response(ResponseError::Cancelled) => Fail::code("cancelled"),
        e => Fail::new("capture_failed", e),
    }
}

/// ~/.local/state/xenon/screencast-token (or under XDG_STATE_HOME).
fn token_path() -> Option<PathBuf> {
    let state = std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| {
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .filter(|p| p.is_absolute())
                .map(|h| h.join(".local/state"))
        })?;
    Some(state.join("xenon").join("screencast-token"))
}

fn read_token() -> Option<String> {
    let t = std::fs::read_to_string(token_path()?).ok()?;
    let t = t.trim();
    (!t.is_empty() && t.len() <= TOKEN_MAX && t.chars().all(|c| c.is_ascii_graphic())).then(|| t.to_owned())
}

fn save_token(token: &str) {
    let Some(path) = token_path() else { return };
    if token.len() > TOKEN_MAX {
        return;
    }
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let part = path.with_extension("part");
    if std::fs::write(&part, token).is_ok() && std::fs::rename(&part, &path).is_err() {
        let _ = std::fs::remove_file(&part);
    }
}

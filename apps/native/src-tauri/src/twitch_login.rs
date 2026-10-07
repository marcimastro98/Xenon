//! Sign in to Twitch inside the kiosk, so the player in the Twitch watching tile
//! knows who is watching.
//!
//! The tile's player is Twitch's own embed (player.twitch.tv in an iframe). It
//! recognises a viewer only through Twitch's cookies in the browser that renders
//! it, and the kiosk's WebView2 profile never had any: the account connected in
//! Settings → Streaming is an API token the SERVER holds for the lists, and the
//! embed cannot see it. So on the Edge every stream played as a guest, while the
//! same embed in a desktop Chrome where the user is signed in to twitch.tv
//! announced the account (measured: its `twitch-embed` `authenticate` message
//! arrives there). Subscriptions and Turbo, and the ad rules Twitch applies to a
//! signed-in viewer, never reached the tile.
//!
//! This window loads twitch.tv's own sign-in page in the SAME WebView2 profile as
//! the dashboard, so the cookies it leaves are the ones the embed reads. Xenon
//! never sees the password: the user types it into Twitch's page. The window has
//! no IPC (capabilities/default.json lists only "main") and no init script.
//!
//! Choreography is scheme-driven like the rest of this shell: the dashboard
//! navigates `xenon-app:twitch-login`, lib.rs opens this window from a plain
//! thread, and the first top-level navigation that leaves the sign-in pages
//! means Twitch is done: the window closes and the dashboard is told, so the tile
//! reloads its player with the new session.
//!
//! Windows only (the dashboard is told through the `twitchLogin` capability):
//! WebKit on macOS and Linux blocks third-party cookies outright, so the same
//! window there would sign in to a session the embed can never read.

use tauri::{AppHandle, LogicalPosition, Manager, Url, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "twitch-login";
const URL: &str = "https://www.twitch.tv/login";
const W: f64 = 520.0;
const H: f64 = 800.0;

/// Centered on the PRIMARY monitor, where the keyboard is: a sign-in form on a
/// 720px-tall touch strip is the wrong place to type a password.
fn place(app: &AppHandle) -> (f64, f64, f64) {
    if let Some(mon) = crate::monitor::app_primary(app) {
        let scale = mon.scale_factor();
        let mw = mon.size().width as f64 / scale;
        let mh = mon.size().height as f64 / scale;
        let mx = mon.position().x as f64 / scale;
        let my = mon.position().y as f64 / scale;
        let h = H.min(mh - 80.0).max(480.0);
        return (mx + (mw - W) / 2.0, my + (mh - h) / 2.0, h);
    }
    (200.0, 100.0, H)
}

/// The sign-in flow lives on /login (and /signup, and Twitch's passport and id
/// hosts). The first navigation on twitch.tv that is none of those is Twitch
/// sending a signed-in user on to the site.
fn signed_in(url: &Url) -> bool {
    let host = url.host_str().unwrap_or("");
    let on_site = host == "www.twitch.tv" || host == "twitch.tv" || host == "m.twitch.tv";
    if !on_site {
        return false;
    }
    let path = url.path();
    !(path.starts_with("/login") || path.starts_with("/signup") || path.starts_with("/passport"))
}

fn finish(app: &AppHandle) {
    // Off the event-loop thread: on_navigation runs inside it, and closing a
    // window or evaluating script waits on that loop (see the spotlight-open
    // note in lib.rs).
    let h = app.clone();
    std::thread::spawn(move || {
        crate::crash_log::note("twitch-login", "signed in, player reloads");
        if let Some(main) = h.get_webview_window("main") {
            let _ = main.eval("try{window.dispatchEvent(new CustomEvent('xenon:twitch-login'))}catch(e){}");
        }
        if let Some(win) = h.get_webview_window(LABEL) {
            let _ = win.close();
        }
    });
}

pub fn open(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }
    let (x, y, h) = place(app);
    let handle = app.clone();
    let builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(URL.parse().unwrap()))
        .title("Twitch")
        .background_color(tauri::window::Color(14, 14, 16, 255))
        .inner_size(W, h)
        .position(x, y)
        .resizable(true)
        // Over the kiosk, which is itself always on top on its own screen.
        .always_on_top(true)
        .visible(true)
        .focused(true)
        .on_navigation(move |url| {
            // Nothing but https: no file:, no custom schemes, no plain http.
            if url.scheme() != "https" {
                return false;
            }
            if signed_in(url) {
                finish(&handle);
                return false;
            }
            true
        });
    // SAME browser args as every other webview here, or WebView2 refuses the
    // window silently (see `crate::browser_args`). And the same profile is the
    // whole point: it is where the embed in the dashboard reads its cookies.
    #[cfg(windows)]
    let builder = builder.additional_browser_args(&crate::browser_args(crate::gpu::applied()));
    match builder.build() {
        Ok(win) => {
            let _ = win.set_position(LogicalPosition::new(x, y));
        }
        Err(e) => crate::crash_log::note("twitch-login", &format!("window failed: {e:?}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_sign_in_pages_are_not_the_end() {
        for u in [
            "https://www.twitch.tv/login",
            "https://www.twitch.tv/login?no-reload=true",
            "https://www.twitch.tv/signup",
            "https://passport.twitch.tv/login",
            "https://id.twitch.tv/oauth2/authorize",
            "https://www.google.com/",
        ] {
            assert!(!signed_in(&u.parse().unwrap()), "{u}");
        }
    }

    #[test]
    fn landing_on_the_site_is() {
        for u in ["https://www.twitch.tv/", "https://www.twitch.tv/?no-reload=true", "https://www.twitch.tv/directory"] {
            assert!(signed_in(&u.parse().unwrap()), "{u}");
        }
    }
}

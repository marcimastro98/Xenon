// The dashboard asking the app about screens: the list it gets back and the signal it sends to move the window.

use crate::{monitor, prefs};

/// Build the JS that hands the dashboard the current monitor list and placement.
///
/// Deliberately NOT the retry loop the update helpers use: that carries an
/// EVENT, which must arrive, while this carries STATE, and re-firing a snapshot
/// that a later push has already superseded would be wrong. The assignment works
/// whether or not the page's scripts have run yet, and the callback is a
/// best-effort nudge for a page that is already listening.
///
/// This is also why the shell needs no Tauri command for the screen picker. A
/// `#[tauri::command]` would mean granting IPC to the `127.0.0.1:3030` origin —
/// the same document that hosts sandboxed third-party widgets and that is served
/// to paired phones — and `capabilities/default.json` says in as many words that
/// the dashboard needs no IPC. One-way state in, one-way intent out.
pub(crate) fn display_state_js(state: &serde_json::Value) -> String {
    format!(
        "(function(s){{try{{window.__XENON_NATIVE_CAPS__=Object.assign(window.__XENON_NATIVE_CAPS__||{{}},s);}}catch(e){{}}\
         try{{if(window.XenonNative&&window.XenonNative.onDisplaysChanged)window.XenonNative.onDisplaysChanged(s);}}catch(e){{}}}})({state});"
    )
}

/// Handle one `xenon-display:` signal. Runs on a spawned thread — never on the
/// WebView UI thread the navigation hook is called from.
pub(crate) fn apply_display_signal(app: &tauri::AppHandle, path: &str, query: Option<&str>) {
    // Tiny query reader: the dashboard sends at most two params and encodes the
    // monitor id with encodeURIComponent.
    let param = |key: &str| -> Option<String> {
        let q = query?;
        q.split('&').find_map(|pair| {
            let (k, v) = pair.split_once('=')?;
            if k != key {
                return None;
            }
            Some(percent_decode(v))
        })
    };
    match path {
        "auto" => monitor::set_placement(app, prefs::Placement::Auto, false),
        // `now=1` is the phone guide's closing button: a paired device exists and
        // the user asked for this PC to stop showing the dashboard right away.
        // Without it the choice is recorded and applied at the next launch, which
        // is what every other caller wants.
        "phone" => monitor::set_placement(
            app,
            prefs::Placement::Phone,
            param("now").as_deref() == Some("1"),
        ),
        "screen" => {
            // Bounded before the lookup so a hostile page cannot make us allocate
            // on an id that was never going to resolve.
            let Some(id) = param("id").filter(|s| !s.is_empty() && s.len() <= 256) else { return };
            if let Some(on) = param("fullscreen") {
                let want = on == "1";
                let mut snapshot = prefs::DisplayPrefs::default();
                prefs::update(app, |p| {
                    p.fullscreen = want;
                    snapshot = p.clone();
                });
                monitor::set_placement_cache(&snapshot);
            }
            // Validation lives here: an id that does not resolve against the live
            // monitor list is never written. It reconciles autostart itself, so
            // every caller — this one and the tray — gets it.
            monitor::move_to_named_monitor(app, &id);
        }
        "fullscreen" => {
            let Some(on) = param("on") else { return };
            monitor::set_fullscreen_pref(app, on == "1");
        }
        _ => {}
    }
}

/// Percent-decode a query value. `tauri::Url` hands us the raw query, and the
/// monitor ids we round-trip are Windows device names full of backslashes.
fn percent_decode(raw: &str) -> String {
    // Percent escapes ONLY. `+` means a literal plus here, not a space: the sole
    // producer of these query strings is `encodeURIComponent` in native-bridge.js,
    // which writes a space as `%20` and never as `+`. Treating `+` as a space is
    // the `application/x-www-form-urlencoded` rule, which no caller here uses —
    // and it would corrupt a display id, since an unnamed screen is identified as
    // `fp:2560x1440@1+1920,0` (see monitor::display_ids). A mangled id does not
    // fail loudly: it resolves to no monitor, which reads as "the screen you chose
    // is unplugged" and hides the window.
    let bytes = raw.as_bytes().to_vec();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(byte) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

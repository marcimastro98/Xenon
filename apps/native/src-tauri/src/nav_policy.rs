//! What the MAIN webview's navigation hook (lib.rs `on_navigation`) lets through.
//!
//! That hook is the shell's whole control surface: the dashboard asks for a
//! restart, a screen change, the update install, … by navigating to a `xenon-*:`
//! URL the hook cancels and acts on. It is not only the dashboard that can
//! navigate, though. On macOS (WKWebView) and Linux (WebKitGTK) the hook also
//! fires for navigations INSIDE iframes, and every community widget runs in one
//! (`sandbox="allow-scripts"`). A widget could therefore `location.href =
//! 'xenon-app:restart'` its own frame and the shell would obey, or name any
//! other scheme (`search-ms:`, `ms-settings:`, `vscode://`, `smb://`, `file:`)
//! and the hook used to hand it to the OS opener, which launches whatever
//! handler is registered for it.
//!
//! Three rules close that:
//!
//! - Signals carry a per-launch random nonce (`xn=` in the query). The page gets
//!   it from an initialization script that only defines it in the top-level
//!   document of the shell's own origins, so a widget frame never sees it and
//!   its signals are dropped. The hook strips the nonce before acting, so the
//!   handlers see exactly the URLs they always did.
//! - Only `http`, `https`, `mailto` and `tel` go to the OS opener, the same
//!   short list the layer windows use (layers/mod.rs). Anything else is dropped.
//! - Loopback is the shell's own page only on the configured port: another
//!   local service is just another external site.

use tauri::Url;

/// Query key the nonce travels under. Short and unlikely to collide with any
/// real parameter a signal carries (`d`, `id`, `on`, `z`, `fullscreen`, …).
const NONCE_KEY: &str = "xn";

/// Where `tauri dev` serves the splash, its default port. Debug builds only: a
/// shipped shell loads the splash from `tauri.localhost` and must keep treating
/// every other local service as an outside site.
const DEV_SERVER_PORT: u16 = 1430;

/// 128 random bits as hex, fresh every launch. A page from a previous launch
/// (or anything that saw one) holds a nonce that no longer works.
pub fn new_nonce() -> String {
    let mut buf = [0u8; 16];
    if getrandom::fill(&mut buf).is_err() {
        // No OS randomness is not something to paper over with a guessable
        // value: an empty nonce matches nothing, so signals simply stop
        // working rather than becoming forgeable.
        return String::new();
    }
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// The origins the main webview's own pages are served from: the bundled
/// splash (`tauri://localhost` on macOS/Linux, `http(s)://tauri.localhost` on
/// Windows) and the loopback dashboard on the configured port.
fn own_origins(port: u16) -> Vec<String> {
    let mut v = vec![
        "tauri://localhost".to_string(),
        "http://tauri.localhost".to_string(),
        "https://tauri.localhost".to_string(),
    ];
    if cfg!(debug_assertions) {
        v.push(format!("http://127.0.0.1:{DEV_SERVER_PORT}"));
    }
    for host in ["127.0.0.1", "localhost", "[::1]"] {
        // `location.origin` leaves out the scheme's default port.
        if port == 80 {
            v.push(format!("http://{host}"));
        } else {
            v.push(format!("http://{host}:{port}"));
        }
    }
    v
}

/// The initialization script that hands the page `window.__xenonSignal(url)`,
/// which appends the nonce to a signal URL. Defined only in the top-level
/// document (on Windows WebView2 runs initialization scripts in every frame,
/// the sandboxed widget frames included) and only on the shell's own origins
/// (the main frame may briefly show a YouTube embed or other allowed page,
/// which must not learn it either). Non-writable and non-configurable so later
/// page script cannot swap it for one that leaks or drops the nonce.
pub fn nonce_script(nonce: &str, port: u16) -> String {
    let n = serde_json::to_string(nonce).unwrap_or_else(|_| "\"\"".to_string());
    let origins = serde_json::to_string(&own_origins(port)).unwrap_or_else(|_| "[]".to_string());
    format!(
        "(function(n,o){{try{{if(window.top!==window)return;if(o.indexOf(location.origin)<0)return;\
         Object.defineProperty(window,'__xenonSignal',{{value:function(u){{u=String(u);\
         return u+(u.indexOf('?')<0?'?':'&')+'{NONCE_KEY}='+n;}},writable:false,configurable:false,enumerable:false}});\
         }}catch(e){{}}}})({n},{origins});"
    )
}

/// Every `xenon-*` scheme is a shell signal and never a page or an app to open.
pub fn is_signal(url: &Url) -> bool {
    url.scheme().starts_with("xenon-")
}

/// The signal with its nonce removed, when the nonce is present and right;
/// `None` otherwise (the caller drops the navigation). The rest of the query is
/// kept byte for byte, so `d=`-style payloads decode exactly as before.
pub fn verified_signal(url: &Url, nonce: &str) -> Option<Url> {
    if nonce.is_empty() {
        return None;
    }
    let query = url.query()?;
    let mut ok = false;
    let mut rest: Vec<&str> = Vec::new();
    for part in query.split('&') {
        match part.split_once('=') {
            Some((k, v)) if k == NONCE_KEY => {
                // Every nonce in the URL must match: a forged one appended next
                // to nothing is no different from no nonce at all.
                if !eq_ct(v.as_bytes(), nonce.as_bytes()) {
                    return None;
                }
                ok = true;
            }
            _ if part == NONCE_KEY => return None,
            _ => rest.push(part),
        }
    }
    if !ok {
        return None;
    }
    let mut clean = url.clone();
    if rest.is_empty() {
        clean.set_query(None);
    } else {
        clean.set_query(Some(&rest.join("&")));
    }
    Some(clean)
}

/// Compare without stopping at the first difference, so how long a rejection
/// takes says nothing about how much of a guess was right.
fn eq_ct(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// The shell's own pages: the loopback dashboard on the configured port, and
/// the bundled splash on Windows (`tauri.localhost`, default port only).
pub fn is_own_page(url: &Url, port: u16) -> bool {
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    match url.host_str() {
        Some("127.0.0.1") if cfg!(debug_assertions) && url.port() == Some(DEV_SERVER_PORT) => true,
        Some("127.0.0.1") | Some("localhost") | Some("[::1]") | Some("::1") => {
            url.port_or_known_default() == Some(port)
        }
        Some("tauri.localhost") => url.port().is_none(),
        _ => false,
    }
}

/// A page the backend served. Narrower than `is_own_page`: the splash is not one,
/// and it arrives as `tauri://localhost` on macOS and Linux and from the dev
/// server on 127.0.0.1 in a dev run, so the host alone cannot tell them apart.
pub fn is_backend_page(url: &Url, port: u16) -> bool {
    matches!(url.scheme(), "http" | "https")
        && matches!(url.host_str(), Some("127.0.0.1") | Some("localhost"))
        && url.port_or_known_default() == Some(port)
}

/// What may be handed to the OS opener: web links and the two link kinds the
/// external-link shim treats as external. Every other scheme names a local
/// handler (a shell, a search, a file share, an editor), and launching one is
/// not something a page in this webview gets to ask for.
pub fn opens_externally(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "mailto" | "tel")
}

#[cfg(test)]
mod tests {
    use super::*;

    const N: &str = "0123456789abcdef0123456789abcdef";

    fn u(s: &str) -> Url {
        s.parse().unwrap()
    }

    #[test]
    fn a_fresh_nonce_is_128_random_bits_and_never_repeats() {
        let a = new_nonce();
        let b = new_nonce();
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn a_signal_with_the_right_nonce_comes_back_without_it() {
        let got = verified_signal(&u(&format!("xenon-app:restart?xn={N}")), N).unwrap();
        assert_eq!(got.as_str(), "xenon-app:restart");
        assert_eq!(got.path(), "restart");
        let got = verified_signal(&u(&format!("xenon-display:screen?id=%5C%5C.%5CDISPLAY2&fullscreen=1&xn={N}")), N).unwrap();
        assert_eq!(got.query(), Some("id=%5C%5C.%5CDISPLAY2&fullscreen=1"));
        let pairs: Vec<(String, String)> = got.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
        assert_eq!(pairs, vec![("id".into(), "\\\\.\\DISPLAY2".into()), ("fullscreen".into(), "1".into())]);
        let got = verified_signal(&u(&format!("xenon-app:layers-sync?d=%7B%22a%22%3A1%7D&xn={N}")), N).unwrap();
        assert_eq!(got.query(), Some("d=%7B%22a%22%3A1%7D"));
    }

    #[test]
    fn a_signal_without_the_nonce_or_with_a_wrong_one_is_refused() {
        assert!(verified_signal(&u("xenon-app:restart"), N).is_none());
        assert!(verified_signal(&u("xenon-app:restart?xn="), N).is_none());
        assert!(verified_signal(&u("xenon-app:restart?xn"), N).is_none());
        assert!(verified_signal(&u("xenon-app:restart?xn=0123456789abcdef0123456789abcdee"), N).is_none());
        assert!(verified_signal(&u(&format!("xenon-app:restart?xn={N}0")), N).is_none());
        assert!(verified_signal(&u(&format!("xenon-app:restart?xn=bad&xn={N}")), N).is_none());
        assert!(verified_signal(&u(&format!("xenon-app:restart?xn={N}&xn=bad")), N).is_none());
        // An empty nonce (no OS randomness) matches nothing, not everything.
        assert!(verified_signal(&u("xenon-app:restart?xn="), "").is_none());
    }

    #[test]
    fn every_xenon_scheme_is_a_signal() {
        for s in ["xenon-app:restart", "xenon-home:go", "xenon-display:auto", "xenon-update:install", "xenon-whatever:x"] {
            assert!(is_signal(&u(s)), "{s}");
        }
        assert!(!is_signal(&u("https://xenon-app.com/")));
        assert!(!is_signal(&u("http://127.0.0.1:3030/")));
    }

    #[test]
    fn loopback_is_our_page_only_on_our_port() {
        assert!(is_own_page(&u("http://127.0.0.1:3030/?shell=main"), 3030));
        assert!(is_own_page(&u("http://localhost:3030/"), 3030));
        assert!(is_own_page(&u("http://[::1]:3030/"), 3030));
        assert!(is_own_page(&u("http://127.0.0.1:4040/"), 4040));
        assert!(is_own_page(&u("http://tauri.localhost/index.html"), 3030));
        assert!(!is_own_page(&u("http://127.0.0.1:8080/"), 3030));
        assert!(!is_own_page(&u("http://127.0.0.1/"), 3030));
        assert!(!is_own_page(&u("http://localhost:3031/"), 3030));
        assert!(!is_own_page(&u("http://tauri.localhost:9999/"), 3030));
        assert!(is_backend_page(&u("http://127.0.0.1:3030/shell-driver"), 3030));
        assert!(is_backend_page(&u("http://localhost:3030/?shell=main"), 3030));
        assert!(!is_backend_page(&u("tauri://localhost/index.html"), 3030));
        assert!(!is_backend_page(&u("http://tauri.localhost/index.html"), 3030));
        assert!(!is_backend_page(&u(&format!("http://127.0.0.1:{DEV_SERVER_PORT}/")), 3030));
        assert!(!is_own_page(&u("https://example.com/"), 3030));
        assert!(!is_own_page(&u("file:///C:/Windows/System32/calc.exe"), 3030));
        // `tauri dev` serves the splash here: without this the first page went to
        // the OS browser and the window stayed on about:blank. Tests are debug builds.
        assert!(is_own_page(&u("http://127.0.0.1:1430/"), 3030));
        assert!(!is_own_page(&u("http://localhost:1430/"), 3030));
    }

    #[test]
    fn only_web_and_contact_links_reach_the_os_opener() {
        for ok in ["https://example.com/", "http://example.com/", "mailto:a@b.c", "tel:+3912345"] {
            assert!(opens_externally(&u(ok)), "{ok}");
        }
        for no in [
            "search-ms:query=x&crumb=location:\\\\evil\\share",
            "ms-settings:display",
            "ms-msdt:/id",
            "vscode://file/c:/x",
            "smb://evil/share",
            "file:///C:/Windows/System32/calc.exe",
            "javascript:alert(1)",
            "steam://run/1",
        ] {
            assert!(!opens_externally(&u(no)), "{no}");
        }
    }

    #[test]
    fn the_nonce_script_guards_frame_and_origin() {
        let js = nonce_script(N, 3030);
        assert!(js.contains("window.top!==window"));
        assert!(js.contains("\"http://127.0.0.1:3030\""));
        assert!(js.contains("\"tauri://localhost\""));
        assert!(js.contains("\"http://tauri.localhost\""));
        assert!(js.contains(&format!("\"{N}\"")));
        assert!(js.contains("writable:false,configurable:false"));
        assert!(nonce_script(N, 80).contains("\"http://127.0.0.1\""));
    }
}

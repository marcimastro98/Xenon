//! Which external page the kiosk lets load inside its own webview.
//!
//! lib.rs `on_navigation` hands every external https link to the default browser.
//! On Linux (WebKitGTK) that hook also fires for navigation inside an iframe, so
//! the YouTube player embedded in a tile was sent to the browser and never played.
//! Only the player's own embed address is let through; a click on "Watch on
//! YouTube" goes to `/watch` and still opens in the browser.

use tauri::Url;

const YOUTUBE_EMBED_HOSTS: [&str; 2] = ["www.youtube.com", "www.youtube-nocookie.com"];

pub fn is_youtube_embed(url: &Url) -> bool {
    url.scheme() == "https"
        && url.port().is_none()
        && url.host_str().is_some_and(|h| YOUTUBE_EMBED_HOSTS.contains(&h))
        && url.path().starts_with("/embed/")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn embed(u: &str) -> bool {
        is_youtube_embed(&u.parse().unwrap())
    }

    #[test]
    fn the_player_embed_loads_in_the_tile() {
        assert!(embed("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"));
        assert!(embed("https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0"));
        assert!(embed("https://www.youtube.com/embed/videoseries?list=PL123"));
    }

    #[test]
    fn everything_else_on_youtube_still_goes_to_the_browser() {
        assert!(!embed("https://www.youtube.com/watch?v=dQw4w9WgXcQ"));
        assert!(!embed("https://www.youtube.com/"));
        assert!(!embed("https://www.youtube.com/embed"));
        assert!(!embed("https://www.youtube.com/embedded/x"));
        assert!(!embed("https://www.youtube.com/embed/../watch?v=x"));
    }

    #[test]
    fn only_the_two_player_hosts_and_plain_https_count() {
        assert!(!embed("http://www.youtube.com/embed/x"));
        assert!(!embed("https://youtube.com/embed/x"));
        assert!(!embed("https://m.youtube.com/embed/x"));
        assert!(!embed("https://www.youtube.com.evil.example/embed/x"));
        assert!(!embed("https://evil.example/www.youtube.com/embed/x"));
        assert!(!embed("https://www.youtube.com@evil.example/embed/x"));
        assert!(!embed("https://www.youtube.com:8443/embed/x"));
    }
}

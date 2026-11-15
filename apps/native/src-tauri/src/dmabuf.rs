//! Linux: when WebKitGTK's DMABUF renderer is turned off before GTK starts.

/// On Hyprland (and so Omarchy) WebKitGTK's DMABUF renderer can make the
/// compositor drop the window with protocol error 71, "Missing acquire
/// timeline". Turning the renderer off avoids it, at the price of copying every
/// frame on the CPU, which on GNOME made the whole dashboard lag (#157). So it
/// is turned off only on Hyprland drawn through Wayland, where the
/// error was seen; every other desktop keeps WebKit's own choice. Under X11
/// (including a forced GDK_BACKEND=x11) nothing changes. A value the user
/// already set always wins: "=1" turns it off anywhere, "=0" keeps it on.
#[cfg(target_os = "linux")]
pub fn disable_dmabuf_on_hyprland() {
    const VAR: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
    let session = DmabufSession {
        wayland: std::env::var_os("WAYLAND_DISPLAY").is_some_and(|v| !v.is_empty()),
        gdk_backend: std::env::var("GDK_BACKEND").unwrap_or_default(),
        hyprland_instance: std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_some_and(|v| !v.is_empty()),
        desktop: std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default(),
        user_set: std::env::var_os(VAR).is_some(),
    };
    if session.should_disable_dmabuf() {
        std::env::set_var(VAR, "1");
    }
}

/// What `disable_dmabuf_on_hyprland` reads from the environment, kept apart so
/// the decision is testable on any OS.
#[cfg_attr(not(any(test, target_os = "linux")), allow(dead_code))]
struct DmabufSession {
    wayland: bool,
    gdk_backend: String,
    hyprland_instance: bool,
    desktop: String,
    user_set: bool,
}

#[cfg_attr(not(any(test, target_os = "linux")), allow(dead_code))]
impl DmabufSession {
    fn should_disable_dmabuf(&self) -> bool {
        if self.user_set || !self.wayland || self.gdk_backend.trim_start().starts_with("x11") {
            return false;
        }
        // XDG_CURRENT_DESKTOP is a colon-separated list ("Hyprland", or
        // "Hyprland:wlroots" under some launchers).
        self.hyprland_instance
            || self.desktop.split(':').any(|d| d.trim().eq_ignore_ascii_case("hyprland"))
    }
}

#[cfg(test)]
mod dmabuf_tests {
    use super::DmabufSession;

    fn session(desktop: &str) -> DmabufSession {
        DmabufSession {
            wayland: true,
            gdk_backend: String::new(),
            hyprland_instance: false,
            desktop: desktop.to_string(),
            user_set: false,
        }
    }

    #[test]
    fn hyprland_on_wayland_turns_the_renderer_off() {
        assert!(session("Hyprland").should_disable_dmabuf());
        assert!(session("Hyprland:wlroots").should_disable_dmabuf());
        let by_signature = DmabufSession { hyprland_instance: true, ..session("") };
        assert!(by_signature.should_disable_dmabuf());
    }

    #[test]
    fn gnome_and_kde_keep_webkits_own_choice() {
        assert!(!session("GNOME").should_disable_dmabuf());
        assert!(!session("ubuntu:GNOME").should_disable_dmabuf());
        assert!(!session("KDE").should_disable_dmabuf());
        assert!(!session("").should_disable_dmabuf());
    }

    #[test]
    fn x11_and_a_value_the_user_set_are_left_alone() {
        assert!(!DmabufSession { wayland: false, ..session("Hyprland") }.should_disable_dmabuf());
        assert!(!DmabufSession { gdk_backend: "x11".into(), ..session("Hyprland") }.should_disable_dmabuf());
        assert!(!DmabufSession { user_set: true, ..session("Hyprland") }.should_disable_dmabuf());
    }
}

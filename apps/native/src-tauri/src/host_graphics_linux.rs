// Linux: an AppImage must draw with the host's graphics libraries, not the ones it carries.

/// The libraries an AppImage must NOT be allowed to shadow, and why this exists
/// at all.
///
/// The AppImage is built on Ubuntu 22.04 and bundles the whole GTK/WebKit stack,
/// which drags `libwayland-client.so.0` in with it. The graphics DRIVER, though,
/// is always the host's: `libEGL_mesa.so` is dlopened out of /usr/lib, and it
/// carries a DT_NEEDED on that same soname — which the loader then resolves to
/// the AppImage's copy, because AppRun put the mount first on LD_LIBRARY_PATH.
/// On any host whose Mesa is newer than the build machine's wayland (Fedora 43:
/// Mesa 25.3 against wayland 1.25, wanting `wl_proxy_get_display`,
/// `wl_fixes_interface`, …) that dlopen fails, so `eglGetDisplay` returns
/// EGL_NO_DISPLAY, and WebKit — which treats a missing EGL display as fatal —
/// prints "Could not create default EGL display: EGL_BAD_PARAMETER. Aborting..."
/// and kills its web process before it paints. The window is up, titled, empty,
/// and stays that way forever: no error reaches the user, and the splash it was
/// meant to show (which is also the "finish installing" offer) never renders.
///
/// The rule is the fix: a library the host's own drivers link against has to come
/// from the host, whatever the AppImage brought. Only sonames the AppImage
/// actually bundles AND the host actually has are redirected, so this is a no-op
/// on a host missing any of them, and the direction is always
/// bundled(old) → host(new) because the host is what the driver was built for.
#[cfg(target_os = "linux")]
const HOST_OWNED_LIBS: &[&str] = &[
    "libwayland-client.so.0",
    "libwayland-cursor.so.0",
    "libwayland-egl.so.1",
    "libwayland-server.so.0",
    "libgbm.so.1",
    "libdrm.so.2",
];

/// Put the host's copy of every [`HOST_OWNED_LIBS`] soname ahead of the
/// AppImage's, by re-exec'ing ourselves with a directory of symlinks prepended to
/// LD_LIBRARY_PATH.
///
/// A re-exec and not a `dlopen`: by the time `main` runs, the loader has already
/// bound the bundled copy through GTK's own DT_NEEDED, and a second copy loaded
/// by path would not win the soname lookup that Mesa later does. Only a fresh
/// process with a fixed search path can. It happens before Tauri builds anything,
/// costs one exec on AppImage launches only, and is guarded by an environment
/// variable so the second process never does it again.
///
/// Every failure here is silent and non-fatal: this is a repair, and a machine it
/// cannot be applied to must still get whatever the unrepaired app manages.
#[cfg(target_os = "linux")]
pub(crate) fn prefer_host_graphics_libs() {
    use std::os::unix::process::CommandExt;

    const GUARD: &str = "XENON_HOST_LIBS_FIXED";
    if std::env::var_os(GUARD).is_some() {
        return;
    }
    let Some(appdir) = std::env::var_os("APPDIR").map(std::path::PathBuf::from) else {
        return; // not an AppImage — the host's libraries are already the only ones
    };
    // Where AppRun's LD_LIBRARY_PATH points, i.e. where a bundled soname would be
    // found. Listing the whole path rather than guessing one lib dir: linuxdeploy
    // uses usr/lib on some builds and usr/lib/x86_64-linux-gnu on others.
    let bundled_dirs: Vec<std::path::PathBuf> = std::env::var_os("LD_LIBRARY_PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    const HOST_DIRS: &[&str] = &[
        "/usr/lib64",
        "/usr/lib/x86_64-linux-gnu",
        "/usr/lib",
        "/lib64",
        "/lib/x86_64-linux-gnu",
    ];

    // Per-user and per-boot: the symlinks must be refreshed after a host library
    // upgrade, and they must never be writable by another user. See
    // `host_libs_shim_dir` for why the old fixed /tmp fallback was dangerous.
    let Some(shim) = host_libs_shim_dir() else {
        return;
    };

    let mut linked = 0;
    for soname in HOST_OWNED_LIBS {
        let bundled = bundled_dirs
            .iter()
            .any(|dir| dir.starts_with(&appdir) && dir.join(soname).exists());
        if !bundled {
            continue;
        }
        let Some(host) = HOST_DIRS
            .iter()
            .map(|dir| std::path::Path::new(dir).join(soname))
            .find(|p| p.exists())
        else {
            continue;
        };
        let link = shim.join(soname);
        let _ = std::fs::remove_file(&link);
        if std::os::unix::fs::symlink(&host, &link).is_ok() {
            linked += 1;
        }
    }
    if linked == 0 {
        return; // nothing to shadow: leave the process exactly as it is
    }

    let mut search = vec![shim];
    search.extend(bundled_dirs);
    let Ok(joined) = std::env::join_paths(search) else {
        return;
    };
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    // exec, so the pid the AppImage runtime is waiting on stays ours. Returns
    // only on failure, and then the app simply carries on unrepaired.
    let error = std::process::Command::new(exe)
        .args(std::env::args_os().skip(1))
        .env("LD_LIBRARY_PATH", joined)
        .env(GUARD, "1")
        .exec();
    let _ = error;
}

/// The directory of soname symlinks that LD_LIBRARY_PATH will point at FIRST.
///
/// Whoever controls this directory controls what code the loader maps into
/// Xenon, so it must be ours alone. The old code fell back to a fixed
/// `/tmp/xenon-host-libs` and happily reused an existing one: another local
/// user could create that directory first (or a symlink by that name) and fill
/// it with a `libEGL.so.1` of their own, which we would then load.
///
/// `$XDG_RUNTIME_DIR` is used only when it really is a private per-user
/// directory: a real directory (not a symlink), owned by our uid, mode 0700.
/// Otherwise a fresh, randomly named 0700 directory is created under the temp
/// dir; `create` (never `create_dir_all`) fails if the name already exists, so
/// we never adopt somebody else's. Either way the result is checked with
/// lstat before use. Returns None to skip the repair (fail closed).
#[cfg(target_os = "linux")]
fn host_libs_shim_dir() -> Option<std::path::PathBuf> {
    extern "C" {
        fn getuid() -> u32;
    }
    // SAFETY: getuid(2) takes no arguments, has no preconditions and cannot fail.
    let uid = unsafe { getuid() };
    shim_dir_in(
        std::env::var_os("XDG_RUNTIME_DIR").map(std::path::PathBuf::from),
        std::env::temp_dir(),
        uid,
    )
}

/// lstat-based: a symlink, a directory owned by someone else, or one that
/// group/others can enter or write is not private.
#[cfg(target_os = "linux")]
fn is_private_dir(p: &std::path::Path, uid: u32) -> bool {
    use std::os::unix::fs::MetadataExt;
    match std::fs::symlink_metadata(p) {
        Ok(m) => m.file_type().is_dir() && m.uid() == uid && (m.mode() & 0o777) == 0o700,
        Err(_) => false,
    }
}

#[cfg(target_os = "linux")]
fn shim_dir_in(
    runtime: Option<std::path::PathBuf>,
    tmp: std::path::PathBuf,
    uid: u32,
) -> Option<std::path::PathBuf> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};

    if let Some(rt) = runtime.filter(|rt| rt.is_absolute() && is_private_dir(rt, uid)) {
        // Inside a private runtime dir nobody else can have created the shim,
        // so reusing it across launches is safe (and avoids litter).
        let shim = rt.join("xenon-host-libs");
        match std::fs::DirBuilder::new().mode(0o700).create(&shim) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                // A shim made by an older build may be 0755: ours, so tighten it.
                if let Ok(m) = std::fs::symlink_metadata(&shim) {
                    if m.file_type().is_dir() && m.uid() == uid && (m.mode() & 0o777) != 0o700 {
                        let _ = std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o700));
                    }
                }
            }
            Err(_) => return None,
        }
        return is_private_dir(&shim, uid).then_some(shim);
    }

    // No trustworthy runtime dir: a brand-new directory with an unguessable
    // name. It must outlive this process's exec (the loader and Mesa resolve
    // through it for the app's whole life), so it is left for the OS's temp
    // cleanup rather than removed.
    let mut rnd = [0u8; 12];
    getrandom::fill(&mut rnd).ok()?;
    let suffix: String = rnd.iter().map(|b| format!("{b:02x}")).collect();
    let shim = tmp.join(format!("xenon-host-libs-{suffix}"));
    std::fs::DirBuilder::new().mode(0o700).create(&shim).ok()?;
    is_private_dir(&shim, uid).then_some(shim)
}

#[cfg(all(test, target_os = "linux"))]
mod host_libs_shim_tests {
    use super::*;
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};

    fn scratch(tag: &str) -> std::path::PathBuf {
        let mut rnd = [0u8; 8];
        getrandom::fill(&mut rnd).unwrap();
        let name: String = rnd.iter().map(|b| format!("{b:02x}")).collect();
        let d = std::env::temp_dir().join(format!("xenon-shim-test-{tag}-{name}"));
        std::fs::DirBuilder::new().mode(0o700).create(&d).unwrap();
        d
    }

    fn me(p: &std::path::Path) -> u32 {
        std::fs::metadata(p).unwrap().uid()
    }

    #[test]
    fn private_runtime_dir_is_used_and_shim_is_0700() {
        let rt = scratch("rt");
        let tmp = scratch("tmp");
        let uid = me(&rt);
        let shim = shim_dir_in(Some(rt.clone()), tmp.clone(), uid).unwrap();
        assert_eq!(shim, rt.join("xenon-host-libs"));
        assert!(is_private_dir(&shim, uid));
        // Reused on the next launch.
        assert_eq!(shim_dir_in(Some(rt.clone()), tmp.clone(), uid).unwrap(), shim);
        let _ = std::fs::remove_dir_all(&rt);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn an_old_0755_shim_in_our_runtime_dir_is_tightened() {
        let rt = scratch("rt755");
        let tmp = scratch("tmp755");
        let uid = me(&rt);
        let old = rt.join("xenon-host-libs");
        std::fs::create_dir(&old).unwrap();
        std::fs::set_permissions(&old, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(shim_dir_in(Some(rt.clone()), tmp.clone(), uid).unwrap(), old);
        assert!(is_private_dir(&old, uid));
        let _ = std::fs::remove_dir_all(&rt);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn shared_or_symlinked_runtime_dir_falls_back_to_a_fresh_private_dir() {
        let tmp = scratch("tmpfb");
        let uid = me(&tmp);
        let open = scratch("open");
        std::fs::set_permissions(&open, std::fs::Permissions::from_mode(0o1777)).unwrap();
        let a = shim_dir_in(Some(open.clone()), tmp.clone(), uid).unwrap();
        assert!(a.starts_with(&tmp), "a world-writable runtime dir is not trusted");
        assert!(is_private_dir(&a, uid));

        let real = scratch("real");
        let link = tmp.join("rt-link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let b = shim_dir_in(Some(link), tmp.clone(), uid).unwrap();
        assert!(b.starts_with(&tmp) && b != a, "a symlinked runtime dir is not trusted; names are unique");

        // Relative or missing values are ignored too.
        assert!(shim_dir_in(Some("relative".into()), tmp.clone(), uid).unwrap().starts_with(&tmp));
        assert!(shim_dir_in(None, tmp.clone(), uid).unwrap().starts_with(&tmp));
        for d in [&tmp, &open, &real] {
            let _ = std::fs::remove_dir_all(d);
        }
    }

    #[test]
    fn a_runtime_dir_owned_by_someone_else_is_never_used() {
        let rt = scratch("other");
        let tmp = scratch("tmpother");
        let uid = me(&rt);
        // Pretend we are another uid: neither the runtime dir nor the fresh
        // directory passes the ownership check, so the repair is skipped.
        assert!(shim_dir_in(Some(rt.clone()), tmp.clone(), uid.wrapping_add(1)).is_none());
        assert!(!rt.join("xenon-host-libs").exists());
        let _ = std::fs::remove_dir_all(&rt);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}

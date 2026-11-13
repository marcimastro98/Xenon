//! Screen targeting + kiosk watchdog.
//!
//! Where the window goes is decided in ONE place — `resolve()` — from the user's
//! saved `placement` and the live monitor list. Three outcomes:
//!
//!   * `Auto` (default): the Xeneon Edge if one is attached (it reports its
//!     native panel size, in either orientation, which is how we find it),
//!     otherwise an ordinary window on the preferred/primary display. A watchdog
//!     upgrades to the kiosk the moment an Edge appears, and re-pins after
//!     display reorders, replug or resume from standby.
//!   * `Screen`: the user NAMED a display and it wins, Edge attached or not. If
//!     that display is gone the window HIDES rather than reappearing somewhere
//!     the user did not ask for; the watchdog restores it when the screen is back.
//!   * `Phone`: nothing on this PC at all.
//!
//! Before v4.11 the Edge always won and the choice did not exist, which is why
//! the tray's monitor picker was greyed out on every machine that had one.

use std::sync::atomic::AtomicBool;
use std::sync::Mutex;
use std::time::Duration;

use crate::prefs::Placement;

mod driver;
mod screens;
mod ids;
mod pick;
mod target;
mod reveal;
mod home;
mod placement;
mod watch_notes;
mod watchdog;
mod visibility;
mod repin;
mod edge;
mod place;
mod initial;
mod foreground;
mod display_info;

pub use driver::{end_visit, opened_to_nothing, seed_driver, set_driver, started_by_hand};
pub(crate) use driver::pointer_monitor;
pub use home::{enter_home, exit_home};
pub use placement::{move_to_named_monitor, push_display_state, set_fullscreen_pref, set_placement};
pub use reveal::{backend_port, note_startup, open_dashboard, reveal, show_now};
use screens::PlacementCache;
pub(crate) use screens::{app_monitors, app_primary, layer_monitor, monitors_with_primary};
pub use screens::{allow_show_this_session, set_placement_cache};
pub(crate) use target::{in_home_mode, owns_its_screen};
pub use target::place_now;
pub use watchdog::start_watchdog;

pub use display_info::{display_list_json, display_state, displays};
use display_info::game_mode;
use edge::{find_edge, is_edge_panel, is_edge_size, kiosk_off_screen, minimized, window_is_on};
pub use edge::edge_present;
use foreground::{kiosk_has_foreground, raise_quietly, xenon_has_foreground};
#[cfg(windows)]
use foreground::clear_stuck_topmost;
use initial::{place_fullscreen_on, place_windowed_on, primary_or_first};
pub use initial::{initial_screen_name, initial_window};
use place::{extent, monitor_rect, place_on_edge, point};
use repin::{move_back_quietly, Repin, repin_action, should_log_repin, slept};
pub use visibility::{apply_rdp_hide_now, hide_window};
use visibility::{is_remote_session, show_for, show_window};

/// Diameter (physical px) of the round floating "return to Xenon" button the
/// kiosk shrinks to when the user swipes up to the desktop: a small, centred,
/// always-on-top circle that is comfortable to hit by finger (a full-width strip
/// proved both awkward to tap and visually heavy). Pinned near the *top* edge so
/// the Windows taskbar (bottom of the screen) stays fully reachable behind it.
const HOME_BTN_DIAMETER: u32 = 84;
/// Gap (physical px) between the very top of the monitor and the round button, so
/// it reads as floating rather than notched into the edge.
const HOME_BTN_TOP_MARGIN: i32 = 8;

/// True while the kiosk is collapsed to the home-bar strip (user swiped up to the
/// Windows desktop). The watchdog checks this and leaves the window alone so it
/// does not immediately re-pin it back to full-screen. Set by `enter_home`,
/// cleared by `exit_home`.
pub static HOME_MODE: AtomicBool = AtomicBool::new(false);

/// Mirror of `prefs.hide_on_rdp` so the watchdog can read the user's choice each
/// tick without touching disk. Set at startup from prefs and updated live by the
/// `xenon-home:rdp-on/off` signal (see lib.rs).
pub static HIDE_ON_RDP: AtomicBool = AtomicBool::new(false);

/// True while the kiosk is hidden because a Windows Remote Desktop session is
/// active, so we hide/show only on the transition (and restore placement once the
/// session ends) instead of every 3-second tick.
static RDP_HIDDEN: AtomicBool = AtomicBool::new(false);

/// True while the window is hidden because the screen the user CHOSE is not
/// connected. Same transition-only shape as `RDP_HIDDEN`.
static NO_SCREEN: AtomicBool = AtomicBool::new(false);

/// True while the tray's "Show Xenon" has deliberately overridden a hidden state
/// for this session. The user asked to see it now; that is not a change of mind
/// about where it lives, so nothing is written to prefs and the next topology
/// change re-evaluates from scratch.
static SHOW_OVERRIDE: AtomicBool = AtomicBool::new(false);

/// True while the main window holds the "widgets only" driver page
/// (server/shell-driver.html): the user chose no dashboard on this PC, the
/// widgets live in the layer windows and the driver only keeps them in sync.
/// Like `Phone`, nothing is shown and nothing is re-pinned; unlike `Phone` it is
/// not a placement but follows the page. Seeded at startup from the mirror in
/// prefs (`widgets_only`) so the watchdog does not bring the splash up first.
static DRIVER: AtomicBool = AtomicBool::new(false);

/// The path the server redirects the main window to in "widgets only" mode.
pub const DRIVER_PATH: &str = "/shell-driver";

/// True while someone in "widgets only" looks at the dashboard (`full=1`: the
/// menu, the tray, a Deck key). It is a visit, not a change of mode: the dashboard
/// opens as an ordinary window on the screen the user is on, wherever the saved
/// placement points (an Edge they do not want it on, say), the mirror in prefs
/// stays, and closing the window goes back to the driver instead of quitting.
static VISIT: AtomicBool = AtomicBool::new(false);

/// The user opened Xenon by hand and the main window has not loaded a page yet.
/// With "widgets only" that page is the driver, which hides the window, and an app
/// that opens and shows nothing reads as broken: the first load opens the Xenon
/// menu instead, the same as double-clicking it while it runs.
static STARTED_BY_HAND: AtomicBool = AtomicBool::new(false);

/// The OS name of the screen the visit opened on.
static VISIT_SCREEN: Mutex<Option<String>> = Mutex::new(None);

/// Mirror of the placement triple, so the watchdog can read the user's choice on
/// every 3-second tick without touching disk — the same reason `HIDE_ON_RDP`
/// exists. Seeded at startup (see lib.rs) and updated by every writer.
///
/// Copy the value out before calling any window API: holding this across a call
/// that can re-enter (a tray handler, a signal thread) would deadlock.
static PLACEMENT: Mutex<PlacementCache> = Mutex::new(PlacementCache {
    mode: Placement::Auto,
    monitor: None,
    fingerprint: None,
    fullscreen: false,
});

/// How much of the host screen a windowed dashboard fills. Large enough to read
/// as "Xenon opened on this screen", short of the edges so it is still visibly a
/// window: the title bar is reachable, the desktop shows around it, and nothing
/// is hidden behind a taskbar or a menu bar.
///
/// It used to be `min(92% of the width, 1600px)` at the EDGE's 3.556:1 aspect,
/// which is why a fresh install on an ordinary monitor opened a 1600×450 letter
/// slot: the shape of a CORSAIR Xeneon Edge on a screen that is not one. The
/// dashboard lays out for the window it is given, so there was never anything to
/// protect by keeping that aspect — only a panel size copied onto every machine.
const WINDOW_SCREEN_FRACTION: f64 = 0.88;

/// Floor for the windowed size, matching the window's own minimum (640×240).
const MIN_WINDOW_WIDTH: f64 = 640.0;
const MIN_WINDOW_HEIGHT: f64 = 240.0;

/// How often the watchdog re-checks the window is on the Edge.
const WATCHDOG_INTERVAL: Duration = Duration::from_secs(3);

/// How many consecutive ticks may try to move a window that will not land, before
/// the watchdog stops and waits for something to actually change.
///
/// A re-pin is a repair, not a loop. `place_on_edge` drops fullscreen, moves the
/// window and re-enters fullscreen — a real mode change for the compositor — and the
/// chase condition is "the window is not on the target", which a display that is
/// flapping (being turned off and on, a link renegotiating, a driver recovering)
/// never stops satisfying. Uncapped, that is a fullscreen transition every three
/// seconds forever, aimed at a display stack at the exact moment it is least able to
/// take it. Five attempts is fifteen seconds: far longer than a re-pin that is going
/// to work needs, and it re-arms on the next genuine topology change, so nothing that
/// legitimately needs repairing is left unrepaired.
const MAX_REPIN_ATTEMPTS: u32 = 5;

/// Ticks in which the kiosk is raised after a screen goes away: the one that sees
/// the loss and the next, for the windows Windows finishes moving late.
const RAISE_TICKS_AFTER_LOSS: u8 = 2;

/// After the quick attempts, one more full re-placement this often while the
/// window is still off its screen, instead of never again. Reported from a Mac:
/// after every wake from sleep the dashboard sat on the main screen as a small
/// window until it was moved back by hand. The quick attempts had run out while
/// the displays were still coming back, the layout then read the same as before
/// the sleep (so no "topology change" re-armed them), and nothing ever tried again.
/// Once a minute cannot thrash a display that is flapping, and it does not apply
/// in a game (see `repin_action`).
const SLOW_REPIN_EVERY: Duration = Duration::from_secs(60);

/// A gap between two watchdog ticks longer than this means the machine slept.
/// Measured on the wall clock: the monotonic clock stops during sleep on macOS,
/// so an `Instant` would see three seconds where the user saw a night.
const SLEEP_GAP: Duration = Duration::from_secs(20);

/// After a wake, how long the attempt cap is lifted: the time a display takes to
/// come back from sleep, renegotiate its link and report its real mode. The Edge
/// can be the last screen to do so.
const SETTLE_AFTER_WAKE: Duration = Duration::from_secs(30);

/// Slow retries write to the crash log at most this often, so a window that can
/// never land (a display that is gone for good) does not fill the file.
const SLOW_REPIN_LOG_EVERY: Duration = Duration::from_secs(30 * 60);

/// How long a cross-screen move on macOS may take before the window is sized. See
/// `wait_until_on`.
#[cfg(target_os = "macos")]
const LANDING_WAIT: Duration = Duration::from_millis(600);
#[cfg(target_os = "macos")]
const LANDING_POLL: Duration = Duration::from_millis(50);

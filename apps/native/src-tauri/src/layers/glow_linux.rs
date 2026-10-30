//! The edge glow windows on Linux (built here, not yet run on a real Linux
//! PC), with the contract of glow_win32.rs: one transparent window per monitor
//! that takes no click (empty input shape) and never the focus, kept out of the
//! taskbar and the pager. They exist only while the glow is on.
//!
//! - X11 with a compositor: a toplevel kept above the others and on every
//!   workspace, a notification for the window manager. The breathing is the
//!   window's opacity, which the compositor applies without a repaint.
//! - Wayland with layer-shell (KDE Plasma, Sway, Hyprland): a surface in the
//!   overlay band, anchored to every edge, over the panels, never the keyboard
//!   (layer_shell.rs). Wayland has no window opacity, so the breathing redraws
//!   the same image with the new alpha, at a lower rate.
//! - Where widget layers cannot be drawn (GNOME on Wayland, X11 without a
//!   compositor: linux.rs `probe`), neither can the glow: the native caps do
//!   not offer it, and `apply` draws nothing.
//!
//! Linux has no way to keep a window out of screenshots and recordings, so
//! there the glow may show in them.
//!
//! Main thread only: the state is a thread-local, borrowed with
//! `try_borrow_mut`; one glib timeout breathes and watches, only while on.
#![cfg(target_os = "linux")]

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::{Duration, Instant};

use gtk::cairo::{Context, Format, ImageSurface, Operator, Region};
use gtk::gdk::WindowTypeHint;
use gtk::glib::{self, ControlFlow, SourceId};
use gtk::prelude::{GtkWindowExt, WidgetExt, WidgetExtManual};

use super::glow::{self, State};
use super::{layer_shell, linux};

/// The page re-sends the state at least every 20 s while it lasts.
const STALE: Duration = Duration::from_secs(60);
/// X11: one opacity change per tick, the compositor does the rest.
const OPACITY_TICK: Duration = Duration::from_millis(40);
/// Wayland: one full redraw per tick, so fewer of them.
const REDRAW_TICK: Duration = Duration::from_millis(66);
/// Reduced motion: nothing moves, the tick only watches.
const STILL_TICK: Duration = Duration::from_secs(1);

pub struct Screen {
    /// Logical pixels, as GTK places windows: x, y, width, height.
    rect: [i32; 4],
    /// The device pixels the glow is painted at.
    px: (usize, usize),
    scale: f64,
}

impl Screen {
    /// The whole monitor.
    pub fn of(m: &tauri::Monitor) -> Self {
        let scale = m.scale_factor();
        let p = m.position().to_logical::<f64>(scale);
        let s = m.size().to_logical::<f64>(scale);
        Screen {
            rect: [p.x.round() as i32, p.y.round() as i32, s.width.round() as i32, s.height.round() as i32],
            px: (m.size().width as usize, m.size().height as usize),
            scale,
        }
    }
}

pub struct Plan {
    pub state: State,
    pub rgb: [u8; 3],
    pub still: bool,
    pub screens: Vec<Screen>,
}

struct Win {
    window: gtk::Window,
    rect: [i32; 4],
    px: (usize, usize),
    scale: f64,
    /// Shared with the window's draw handler, which never touches `GLOW`.
    image: Rc<RefCell<Option<ImageSurface>>>,
    alpha: Rc<Cell<f64>>,
}

#[derive(Default)]
struct Glow {
    wins: Vec<Win>,
    /// What the pixels show: the state's look and the accent.
    look: Option<(bool, [u8; 3])>,
    period: u32,
    still: bool,
    started: Option<Instant>,
    touched: Option<Instant>,
    /// The live timeout and its interval. Only `tick` ends it by returning
    /// Break, and it forgets the id first, so a stored id is always live.
    timer: Option<(SourceId, Duration)>,
}

thread_local! {
    static GLOW: RefCell<Glow> = RefCell::new(Glow::default());
}

/// The surface is a layer surface: no window opacity, the alpha is drawn.
fn redraws() -> bool {
    linux::layer_shell()
}

fn draw(cr: &Context, image: Option<&ImageSurface>, alpha: f64) {
    cr.set_operator(Operator::Source);
    cr.set_source_rgba(0.0, 0.0, 0.0, 0.0);
    let _ = cr.paint();
    let Some(image) = image else { return };
    cr.set_operator(Operator::Over);
    if cr.set_source_surface(image, 0.0, 0.0).is_ok() {
        let _ = cr.paint_with_alpha(alpha);
    }
}

/// A window over the whole monitor that nothing reaches. None without an
/// RGBA visual: the glow would be an opaque black screen.
fn create(s: &Screen) -> Option<Win> {
    let visual = gtk::gdk::Screen::default()?.rgba_visual()?;
    let window = gtk::Window::new(gtk::WindowType::Toplevel);
    window.set_visual(Some(&visual));
    window.set_app_paintable(true);
    window.set_decorated(false);
    window.set_skip_taskbar_hint(true);
    window.set_skip_pager_hint(true);
    window.set_accept_focus(false);
    window.set_focus_on_map(false);
    window.set_title("Xenon");
    // An empty input shape: every click goes to the window underneath.
    window.input_shape_combine_region(Some(&Region::create()));
    let [x, y, width, height] = s.rect;
    if linux::layer_shell() {
        let monitor = window.display().monitor_at_point(x + width / 2, y + height / 2);
        layer_shell::place_glow(&window, monitor.as_ref());
    } else {
        window.set_type_hint(WindowTypeHint::Notification);
        window.set_default_size(width, height);
        window.move_(x, y);
        window.set_keep_above(true);
        window.stick();
    }
    let image: Rc<RefCell<Option<ImageSurface>>> = Rc::new(RefCell::new(None));
    let alpha = Rc::new(Cell::new(1.0));
    let (shown, a) = (image.clone(), alpha.clone());
    window.connect_draw(move |_, cr| {
        draw(cr, shown.borrow().as_ref(), a.get());
        glib::Propagation::Stop
    });
    Some(Win { window, rect: s.rect, px: s.px, scale: s.scale, image, alpha })
}

/// glow::paint's rows as a cairo image: ARGB32 is premultiplied and, on the
/// little-endian machines Xenon ships for, B, G, R, A in memory, the order
/// glow::paint writes. Its device scale maps one pixel to one device pixel.
fn surface(w: &Win, state: State, rgb: [u8; 3]) -> Option<ImageSurface> {
    let (cx, cy) = w.px;
    if cx == 0 || cy == 0 {
        return None;
    }
    let stride = Format::ARgb32.stride_for_width(u32::try_from(cx).ok()?).ok()?;
    if usize::try_from(stride).ok()? != cx * 4 {
        return None;
    }
    let pixels = glow::paint(cx, cy, w.scale, state, rgb);
    let image = ImageSurface::create_for_data(pixels, Format::ARgb32, cx as i32, cy as i32, stride).ok()?;
    image.set_device_scale(w.scale, w.scale);
    Some(image)
}

fn set_alpha(w: &Win, alpha: f64) {
    if redraws() {
        w.alpha.set(alpha);
        w.window.queue_draw();
    } else {
        w.window.set_opacity(alpha);
    }
}

fn destroy(w: Win) {
    w.window.hide();
    // SAFETY: the window is this module's own; nothing else holds it.
    unsafe { w.window.destroy() };
}

fn off(g: &mut Glow) {
    for w in g.wins.drain(..) {
        destroy(w);
    }
    g.look = None;
    if let Some((id, _)) = g.timer.take() {
        id.remove();
    }
}

fn current_alpha(g: &Glow) -> f64 {
    let elapsed = g.started.map_or(0, |t| t.elapsed().as_millis() as u64);
    f64::from(glow::breath_alpha(elapsed, g.period, g.still)) / 255.0
}

/// Show the plan: windows for its screens only, painted when the look or the
/// size changed, one timeout for all.
pub fn apply(plan: Plan) {
    GLOW.with(|cell| {
        let Ok(mut g) = cell.try_borrow_mut() else { return };
        if plan.state == State::Off || plan.screens.is_empty() || !linux::usable() {
            return off(&mut g);
        }
        let now = Instant::now();
        if g.wins.is_empty() {
            g.started = Some(now);
        }
        g.touched = Some(now);
        g.period = glow::period_ms(plan.state);
        g.still = plan.still;
        let look = Some((plan.state == State::Speaking, glow::colour(plan.state, plan.rgb)));
        let relook = g.look != look;
        g.look = look;
        let alpha = current_alpha(&g);
        let mut old = std::mem::take(&mut g.wins);
        for s in plan.screens {
            if g.wins.iter().any(|w| w.rect == s.rect) {
                continue;
            }
            let (win, fresh) = match old.iter().position(|w| w.rect == s.rect && w.px == s.px) {
                Some(i) => (old.swap_remove(i), false),
                None => match create(&s) {
                    Some(w) => (w, true),
                    None => continue,
                },
            };
            if fresh || relook {
                let Some(image) = surface(&win, plan.state, plan.rgb) else {
                    destroy(win);
                    continue;
                };
                *win.image.borrow_mut() = Some(image);
                win.window.queue_draw();
            }
            set_alpha(&win, alpha);
            if fresh {
                win.window.show();
            }
            g.wins.push(win);
        }
        for w in old {
            destroy(w);
        }
        if g.wins.is_empty() {
            return off(&mut g);
        }
        restart_timer(&mut g);
    });
}

fn restart_timer(g: &mut Glow) {
    let every = if g.still {
        STILL_TICK
    } else if redraws() {
        REDRAW_TICK
    } else {
        OPACITY_TICK
    };
    if matches!(g.timer, Some((_, e)) if e == every) {
        return;
    }
    if let Some((id, _)) = g.timer.take() {
        id.remove();
    }
    g.timer = Some((glib::timeout_add_local(every, tick), every));
}

fn tick() -> ControlFlow {
    GLOW.with(|cell| {
        let Ok(mut g) = cell.try_borrow_mut() else { return ControlFlow::Continue };
        if !g.touched.is_some_and(|t| t.elapsed() <= STALE) {
            // Returning Break ends this timeout: forget its id, never remove it twice.
            g.timer = None;
            off(&mut g);
            return ControlFlow::Break;
        }
        if !g.still {
            let alpha = current_alpha(&g);
            for w in &g.wins {
                set_alpha(w, alpha);
            }
        }
        ControlFlow::Continue
    })
}

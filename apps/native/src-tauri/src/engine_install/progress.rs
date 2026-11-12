//! How far the install got, pushed into the splash as `window.__XENON_INSTALL__`.
//!
//! The splash cannot call into the shell, and an eval sent before the page has
//! loaded is lost, so the latest state is re-sent on a short timer for as long
//! as the install runs and a few seconds after. The page only renders it.

use std::sync::Mutex;
use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Step {
    Preparing,
    Copying,
    Runtime,
    Registering,
    Starting,
    Ready,
    /// The stage that failed, as a short code the splash maps to words.
    Failed(&'static str),
}

impl Step {
    pub fn code(&self) -> &'static str {
        match self {
            Step::Preparing => "preparing",
            Step::Copying => "copying",
            Step::Runtime => "runtime",
            Step::Registering => "registering",
            Step::Starting => "starting",
            Step::Ready => "ready",
            Step::Failed(stage) => stage,
        }
    }
}

struct State {
    step: Step,
    percent: u8,
    done: bool,
}

static STATE: Mutex<State> = Mutex::new(State { step: Step::Preparing, percent: 0, done: false });

pub fn reset() {
    if let Ok(mut s) = STATE.lock() {
        *s = State { step: Step::Preparing, percent: 0, done: false };
    }
}

pub fn set(step: Step, percent: u8) {
    if let Ok(mut s) = STATE.lock() {
        s.step = step;
        s.percent = percent.min(100);
    }
}

pub fn finish() {
    if let Ok(mut s) = STATE.lock() {
        s.done = true;
    }
}

/// The script that hands the current state to the splash. Only codes and
/// numbers cross over: the page owns every word, in the user's language.
pub fn splash_js() -> String {
    let Ok(s) = STATE.lock() else { return String::new() };
    let failed = matches!(s.step, Step::Failed(_));
    format!(
        "try{{window.__XENON_INSTALL__={{step:\"{}\",failed:{},percent:{},done:{}}};}}catch(e){{}}",
        s.step.code(),
        failed,
        s.percent,
        s.done
    )
}

fn is_done() -> bool {
    STATE.lock().map(|s| s.done).unwrap_or(true)
}

pub fn push_until_done(app: &tauri::AppHandle) {
    use tauri::Manager;
    const EVERY: Duration = Duration::from_millis(400);
    let mut after_done = 0;
    while after_done < 10 {
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.eval(splash_js());
        }
        if is_done() {
            after_done += 1;
        }
        std::thread::sleep(EVERY);
    }
}

pub fn current_step() -> Step {
    STATE.lock().map(|s| s.step).unwrap_or(Step::Preparing)
}

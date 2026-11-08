//! The windows a capture of the whole screen leaves out, the pure part: those
//! whose owner asked not to be captured (`sharingType = none`). That is how
//! Xenon keeps its widgets and its alerts window out of captures, and how any
//! other app keeps a private window out. Through macOS 14 the system left them
//! out by itself; macOS 15 can show them to ScreenCaptureKit, so the engine
//! names them in its own filter (no_share.rs, sck.rs). Its tests run on every OS.

/// kCGWindowSharingNone.
pub const SHARING_NONE: i64 = 0;

/// From the window list's (window number, sharing state) pairs, the windows to
/// leave out: sorted, no repeats, so two lists compare equal when nothing changed.
pub fn pick(pairs: impl IntoIterator<Item = (Option<i64>, Option<i64>)>) -> Vec<u32> {
    let mut out: Vec<u32> = pairs
        .into_iter()
        .filter_map(|(id, state)| {
            let id = u32::try_from(id?).ok().filter(|&i| i != 0)?;
            (state? == SHARING_NONE).then_some(id)
        })
        .collect();
    out.sort_unstable();
    out.dedup();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_windows_that_asked_not_to_be_captured() {
        let list = [
            (Some(40), Some(0)),
            (Some(12), Some(1)),
            (Some(7), Some(0)),
            (Some(9), Some(2)),
            (Some(40), Some(0)),
        ];
        assert_eq!(pick(list), vec![7, 40]);
    }

    #[test]
    fn a_window_without_a_number_or_a_state_is_left_alone() {
        let list = [(None, Some(0)), (Some(5), None), (Some(0), Some(0)), (Some(-3), Some(0)), (Some(1 << 40), Some(0))];
        assert!(pick(list).is_empty());
    }
}

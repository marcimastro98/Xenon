//! A card closing on the see-through alerts window, on Windows: the card stays
//! still and opaque in its page while the window's cut rolls shut over it, up
//! towards the top of the screen. Nothing transparent ever shows inside the cut,
//! so no bare window can flash where the card was (js/alert-roll.js).

/// How long a roll lasts. Pinned equal to the page's (test/alert-roll.test.mjs).
pub const ROLL_MS: u64 = 220;
/// How much of its width a card loses on each side by the end.
const NARROW: f64 = 0.04;
/// The closing edge keeps a card's rounded look: width and height of the corner,
/// in device pixels.
const CORNER: i32 = 32;

/// Slow start and slow end, so the first and last frames do not jump.
fn eased(t: f64) -> f64 {
    t * t * (3.0 - 2.0 * t)
}

/// What is left of `rect` (x, y, w, h) after `elapsed_ms`, or None once it has closed.
pub fn rolled(rect: [i32; 4], elapsed_ms: u64) -> Option<[i32; 4]> {
    if elapsed_ms >= ROLL_MS {
        return None;
    }
    let done = eased(elapsed_ms as f64 / ROLL_MS as f64);
    let [x, y, w, h] = rect;
    let inset = (w as f64 * NARROW * done).round() as i32;
    let height = (h as f64 * (1.0 - done)).round() as i32;
    (height > 0).then_some([x + inset, y, w - 2 * inset, height])
}

/// The corner for a piece of this height: never taller than the piece.
pub fn corner(height: i32) -> i32 {
    CORNER.min(height)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CARD: [i32; 4] = [100, 20, 600, 150];

    #[test]
    fn starts_whole_and_stays_on_top() {
        assert_eq!(rolled(CARD, 0), Some(CARD));
        for ms in (0..ROLL_MS).step_by(8) {
            if let Some(r) = rolled(CARD, ms) {
                assert_eq!(r[1], CARD[1], "its top edge never moves");
            }
        }
    }

    #[test]
    fn only_ever_closes() {
        let mut last = CARD;
        for ms in (0..ROLL_MS).step_by(4) {
            let Some(r) = rolled(CARD, ms) else { break };
            assert!(r[3] <= last[3] && r[2] <= last[2], "{r:?} after {last:?}");
            assert!(r[0] + r[2] <= CARD[0] + CARD[2] && r[0] >= CARD[0], "stays over the card");
            last = r;
        }
    }

    #[test]
    fn no_frame_jumps_at_the_timer_real_pace() {
        // Windows timers tick about every 15.6 ms.
        let mut last = CARD[3];
        let mut ms = 0.0_f64;
        while let Some(r) = rolled(CARD, ms as u64) {
            assert!(last - r[3] <= CARD[3] / 6, "{} px in one tick", last - r[3]);
            last = r[3];
            ms += 15.6;
        }
    }

    #[test]
    fn closes_on_time() {
        assert_eq!(rolled(CARD, ROLL_MS), None);
        assert_eq!(rolled(CARD, ROLL_MS * 10), None);
        assert_eq!(rolled([0, 0, 0, 0], 10), None, "nothing to roll");
    }

    #[test]
    fn the_corner_fits_the_piece() {
        assert_eq!(corner(200), CORNER);
        assert_eq!(corner(5), 5);
    }
}

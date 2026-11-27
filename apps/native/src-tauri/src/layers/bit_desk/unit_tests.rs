use super::*;

fn msg(extra: &str) -> String {
    format!(r#"{{"on":true,"pal":["ff0000","00ff00"],"loop":[{{"ms":200,"rows":["A.","BA"]}}]{extra}}}"#)
}

#[test]
fn a_clip_becomes_cells_on_one_grid() {
    let s = parse(&msg(r#","home":0.4,"cell":4"#)).expect("valid");
    assert!(s.on);
    assert_eq!((s.w, s.h, s.cell), (2, 2, 4));
    assert_eq!(s.pal, vec![[255, 0, 0], [0, 255, 0]]);
    assert_eq!(s.looped, vec![Frame { ms: 200, cells: vec![1, 0, 2, 1] }]);
    assert_eq!(s.home, 0.4);
    assert_eq!(s.monitor, "");
}

#[test]
fn off_needs_nothing_else() {
    assert_eq!(parse(r#"{"on":false}"#), Some(Spec::default()));
}

#[test]
fn a_message_that_breaks_the_rule_is_dropped() {
    let bad = [
        // a letter past the palette
        r#"{"on":true,"pal":["ff0000"],"loop":[{"ms":200,"rows":["B"]}]}"#.to_string(),
        // rows of different lengths
        r#"{"on":true,"pal":["ff0000"],"loop":[{"ms":200,"rows":["A","AA"]}]}"#.to_string(),
        // a colour that is not six hex digits
        r#"{"on":true,"pal":["red"],"loop":[{"ms":200,"rows":["A"]}]}"#.to_string(),
        // no frames
        r#"{"on":true,"pal":["ff0000"],"loop":[]}"#.to_string(),
        // a once clip on another grid
        msg(r#","once":{"seq":1,"frames":[{"ms":100,"rows":["AAA"]}]}"#),
        // a monitor id that is not printable
        msg(",\"monitor\":\"a\\nb\""),
        // too wide
        format!(r#"{{"on":true,"pal":["ff0000"],"loop":[{{"ms":200,"rows":["{}"]}}]}}"#, "A".repeat(MAX_SIDE + 1)),
        // too big
        format!(r#"{{"on":true,"pad":"{}"}}"#, "x".repeat(MAX_PAYLOAD)),
    ];
    for b in &bad {
        assert_eq!(parse(b), None, "{b:.80}");
    }
}

#[test]
fn numbers_are_kept_in_range() {
    let s = parse(&msg(r#","home":7,"cell":40,"walk":{"seq":3,"to":-2,"pxs":9000}"#)).unwrap();
    assert_eq!((s.home, s.cell), (1.0, 6));
    assert_eq!(s.walk, Some(Walk { seq: 3, to: 0.0, pxs: 400.0 }));
    let quick = r#"{"on":true,"pal":["ff0000"],"loop":[{"ms":1,"rows":["A"]}],"cell":0}"#;
    let s = parse(quick).unwrap();
    assert_eq!((s.looped[0].ms, s.cell), (40, 3));
}

#[test]
fn bit_stands_inside_a_bottom_taskbar_or_on_the_desktop_edge() {
    let mon = Area { l: 0, t: 0, r: 1920, b: 1080 };
    let bar = Area { l: 0, t: 0, r: 1920, b: 1032 }; // 48 px at the bottom
    assert_eq!(lane(mon, bar, 36), Lane { l: 0, r: 1920, floor: 1074 }, "in the middle of the bar");
    let hidden = mon;
    assert_eq!(lane(mon, hidden, 36).floor, 1080, "a bar that hides itself: the bottom edge");
    let side = Area { l: 60, t: 0, r: 1920, b: 1080 };
    assert_eq!(lane(mon, side, 36), Lane { l: 60, r: 1920, floor: 1080 }, "a bar on the left: the desktop's edge");
    assert_eq!(lane(mon, bar, 60).floor, 1032, "taller than the bar: on top of it");
}

#[test]
fn a_place_along_the_lane_and_back() {
    let l = Lane { l: 100, r: 1100, floor: 1000 };
    assert_eq!(place(&l, 0.0, 40, 36), (100, 964));
    assert_eq!(place(&l, 1.0, 40, 36), (1060, 964));
    assert_eq!(place(&l, 0.5, 40, 36), (580, 964));
    assert_eq!(along(&l, 580, 40), 0.5);
    assert_eq!(along(&l, 5000, 40), 1.0);
    assert_eq!(along(&Lane { l: 0, r: 10, floor: 0 }, 0, 40), 0.0, "a lane narrower than Bit");
}

#[test]
fn a_walk_moves_at_its_speed_and_stops_where_it_goes() {
    let l = Lane { l: 0, r: 1040, floor: 0 }; // 1000 px of room for a 40 px Bit
    assert_eq!(step(&l, 40, 0.0, 1.0, 100.0, 1000), 0.1);
    assert_eq!(step(&l, 40, 0.5, 0.2, 100.0, 1000), 0.4);
    assert_eq!(step(&l, 40, 0.95, 1.0, 100.0, 1000), 1.0, "never past the end");
}

#[test]
fn paint_fills_cells_and_mirrors() {
    let f = Frame { ms: 100, cells: vec![1, 0] };
    let px = paint(&f, 2, 1, &[[10, 20, 30]], 2, false);
    assert_eq!(px.len(), 4 * 2 * 4);
    assert_eq!(&px[0..4], &[30, 20, 10, 255], "BGRA, opaque");
    assert_eq!(&px[8..12], &[0, 0, 0, 0], "an empty cell lets clicks through");
    let m = paint(&f, 2, 1, &[[10, 20, 30]], 2, true);
    assert_eq!(&m[0..4], &[0, 0, 0, 0]);
    assert_eq!(&m[8..12], &[30, 20, 10, 255], "facing left");
}

#[test]
fn the_body_is_what_fits_in_the_taskbar() {
    assert_eq!(parse(&msg("")).unwrap().body, 2, "all of it by default");
    assert_eq!(parse(&msg(r#","body":1"#)).unwrap().body, 1);
    assert_eq!(parse(&msg(r#","body":9"#)).unwrap().body, 2, "never more than the grid");
}

#[test]
fn left_away_from_the_bar_it_stands_where_it_was_let_go() {
    let mon = Area { l: 0, t: 0, r: 1920, b: 1080 };
    let work = Area { l: 0, t: 0, r: 1920, b: 1032 };
    let on = lane(mon, work, 36);
    // rise 0: the top of the desktop; 1: its feet on the lane, as on the bar.
    assert_eq!(spot(&on, work, 0.0, 0.0, 54, 51), (0, 0));
    assert_eq!(spot(&on, work, 0.0, 1.0, 54, 51), place(&on, 0.0, 54, 51));
    let (left, top) = spot(&on, work, 0.5, 0.25, 54, 51);
    assert_eq!(left, place(&on, 0.5, 54, 51).0);
    // And back: the same height from where the window is.
    let rise = rise_of(&on, work, top, 51, 24).expect("away from the bar");
    assert!((rise - 0.25).abs() < 0.002, "{rise}");
    assert_eq!(rise_of(&on, work, 0, 51, 24), Some(0.0));
    assert_eq!(rise_of(&on, work, -400, 51, 24), Some(0.0), "above the screen: at its top");
}

#[test]
fn let_go_near_the_bar_or_on_it_it_walks_on_the_bar_again() {
    let mon = Area { l: -1080, t: 128, r: 0, b: 2048 };
    let work = Area { l: -1080, t: 128, r: 0, b: 2000 };
    let on = lane(mon, work, 36);
    assert_eq!(rise_of(&on, work, 2000 - 51 - 10, 51, 24), None, "feet 10 px over the bar");
    assert_eq!(rise_of(&on, work, 2010, 51, 24), None, "over the bar itself");
    assert!(rise_of(&on, work, 2000 - 51 - 30, 51, 24).is_some(), "30 px over it: stays put");
    // A screen too short for Bit: always on the bar.
    let tiny = Area { l: 0, t: 0, r: 100, b: 40 };
    assert_eq!(rise_of(&lane(tiny, tiny, 36), tiny, 0, 51, 24), None);
}

#[test]
fn how_high_is_kept_in_range_or_left_out() {
    assert_eq!(parse(&msg(r#","rise":0.3"#)).expect("valid").rise, Some(0.3));
    assert_eq!(parse(&msg(r#","rise":7"#)).expect("valid").rise, Some(1.0));
    assert_eq!(parse(&msg("")).expect("valid").rise, None, "on the bar");
    assert!(parse(&msg(r#","rise":"high""#)).is_none(), "not a number: dropped");
}

fn plan(extra: &str) -> Plan {
    let spec = parse(&msg(extra)).expect("valid");
    Plan { spec, mon: Area { l: 0, t: 0, r: 1000, b: 800 }, work: Area { l: 0, t: 0, r: 1000, b: 760 }, scale: 1.0 }
}

#[test]
fn a_still_bit_wakes_only_for_the_watchdog_and_goes_stale() {
    let mut d = state::Desk::default();
    d.take(plan(""), 0);
    assert_eq!(d.wait_ms(0), state::IDLE_TICK_MS);
    assert_eq!(d.tick(500), (false, false));
    assert!(!d.stale(60_000) && d.stale(60_001));
}

#[test]
fn a_walk_goes_at_its_pace_and_says_when_it_arrived() {
    let mut d = state::Desk::default();
    d.take(plan(r#","walk":{"seq":1,"to":1,"pxs":400}"#), 0);
    assert!(d.wait_ms(0) < 100);
    let (mut t, mut arrived) = (0, false);
    while !arrived && t < 10_000 {
        t += 100;
        arrived = d.tick(t).1;
    }
    assert!(arrived, "a walk ends");
    // 994 = the lane's right end less Bit's 6 pixels.
    assert_eq!(d.at().0, 994);
    assert_eq!(d.wait_ms(t), state::IDLE_TICK_MS);
    // The same walk heard again does not start over.
    d.take(plan(r#","walk":{"seq":1,"to":1,"pxs":400}"#), t);
    assert_eq!(d.at().0, 994, "it stays where the walk took it");
}

#[test]
fn a_clip_once_plays_then_the_loop_again() {
    let once = r#","once":{"seq":7,"frames":[{"ms":100,"rows":["AA","AA"]},{"ms":100,"rows":["BB","BB"]}]}"#;
    let mut d = state::Desk::default();
    d.take(plan(once), 0);
    assert_eq!(d.current().map(|f| f.cells.clone()), Some(vec![1, 1, 1, 1]));
    assert_eq!(d.tick(100), (true, false));
    assert_eq!(d.current().map(|f| f.cells.clone()), Some(vec![2, 2, 2, 2]));
    assert_eq!(d.tick(200), (true, false));
    assert_eq!(d.current().map(|f| f.cells.clone()), Some(vec![1, 0, 2, 1]), "back to the loop");
    // Heard again with the same seq, the clip does not play twice.
    d.take(plan(once), 300);
    assert_eq!(d.current().map(|f| f.cells.clone()), Some(vec![1, 0, 2, 1]));
}

#[test]
fn a_small_press_is_a_tap_and_a_long_one_a_drop_the_page_decides_on() {
    let mut d = state::Desk::default();
    d.take(plan(""), 0);
    let home = d.at();
    d.press((10, 10));
    assert!(!d.drag_to((12, 12)), "under the drag distance");
    assert_eq!(d.release(true, |_| None).as_deref(), Some("tapped()"));
    // The mouse taken away without a drag says nothing.
    d.press((10, 10));
    assert_eq!(d.release(false, |_| None), None);
    d.press((10, 10));
    assert!(d.drag_to((300, -500)));
    assert_eq!(d.at(), (home.0 + 290, home.1 - 510));
    assert_eq!(d.release(true, |_| None).as_deref(), Some("dropped(0.2918,0.3436,0,0)"));
    // Until the page answers it stays where it was let go; its word puts it where it belongs.
    assert_eq!(d.at(), (home.0 + 290, home.1 - 510));
    d.take(plan(""), 100);
    assert_eq!(d.at(), home);
}

#[test]
fn the_wheel_asks_one_size_up_or_down() {
    assert_eq!(wheel_call(120.0).as_deref(), Some("resize(1)"));
    assert_eq!(wheel_call(-0.3).as_deref(), Some("resize(-1)"));
    assert_eq!(wheel_call(0.0), None);
    assert_eq!(wheel_call(f64::NAN), None);
}

#[test]
fn every_size_the_page_sends_is_kept_and_none_past_the_range() {
    for c in [2, 3, 4] {
        assert_eq!(parse(&msg(&format!(r#","cell":{c}"#))).expect("valid").cell, c);
    }
    assert_eq!(parse(&msg(r#","cell":40"#)).expect("valid").cell, CELL.1);
}

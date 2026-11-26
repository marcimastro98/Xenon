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

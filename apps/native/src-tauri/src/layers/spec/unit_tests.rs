// Tests of what a layer page may ask for.

use super::{ANCHOR_MAX_OFFSET, ANCHOR_MAX_PX, ANCHOR_MIN_PX, Corner, Kind, MAX_COORD, MAX_PAYLOAD, MAX_RECTS, MAX_SURFACES, parse, parse_rects, Spec, valid_key};
#[cfg(any(target_os = "macos", test))]
use super::hit;
use super::pages::{dashboard_page, is_alerts, is_draw, is_menu, is_scene, menu_caps_script, out_of_captures, tile_settings};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_menu_can_be_photographed_unless_xenon_records() {
        let spec = |exclude, capturing| Spec { exclude, capturing, ..Spec::default() };
        assert!(!out_of_captures("menu:", &spec(true, false)), "the setting is for the widgets");
        assert!(out_of_captures("menu:", &spec(false, true)));
        assert!(out_of_captures("alerts:", &spec(false, false)));
        assert!(!out_of_captures("draw:", &spec(true, false)));
        assert!(out_of_captures("overlay:1", &spec(true, false)));
        assert!(!out_of_captures("wallpaper:1", &spec(true, false)), "the desktop stays in a screenshot");
        assert!(!out_of_captures("saver:1", &spec(true, false)));
    }

    #[test]
    fn hit_is_inside_a_tile_only() {
        let rects = [[100, 50, 200, 100], [400, 400, 10, 10]];
        assert!(hit(&rects, 100.0, 50.0));
        assert!(hit(&rects, 299.9, 149.9));
        assert!(!hit(&rects, 300.0, 100.0));
        assert!(!hit(&rects, 99.9, 60.0));
        assert!(hit(&rects, 405.0, 405.0));
        assert!(!hit(&[], 0.0, 0.0));
        // A cursor off the window (negative, or past its edge) is on nothing.
        assert!(!hit(&rects, -5.0, -5.0));
    }

    #[test]
    fn the_menu_is_an_ordinary_window_unless_the_sync_says_a_game_is_on() {
        let plain = parse(r#"{"surfaces":[{"key":"menu:","kind":"menu"}]}"#).unwrap();
        assert_eq!((plain.top, plain.front), (false, 0));
        let game = parse(r#"{"surfaces":[{"key":"menu:","kind":"menu"}],"top":true,"front":3}"#).unwrap();
        assert_eq!((game.top, game.front), (true, 3));
    }

    #[test]
    fn the_menu_window_gets_the_facts_about_the_shell_and_none_of_its_switches() {
        let caps = serde_json::json!({
            "shellVersion": "5.0.0", "layers": true, "layersWhy": null, "scene": false,
            "seeThrough": true, "seeThroughOn": true, "displayPicker": true,
            "displays": [{ "id": "x" }], "nativePageZoom": true, "twitchLogin": true,
        });
        let js = menu_caps_script(&caps);
        assert!(js.contains("window.__XENON_NATIVE__=true"));
        for fact in ["\"shellVersion\":\"5.0.0\"", "\"layers\":true", "\"layersWhy\":null", "\"scene\":false"] {
            assert!(js.contains(fact), "{fact}");
        }
        for switch in ["seeThrough", "displayPicker", "displays", "nativePageZoom", "twitchLogin"] {
            assert!(!js.contains(switch), "{switch}");
        }
    }

    #[test]
    fn the_menu_window_hands_the_update_screen_on_to_the_dashboard() {
        assert_eq!(dashboard_page("open-dashboard", Some("update"), None, true), Some(("update", None)));
    }

    #[test]
    fn the_alerts_window_may_open_only_its_own_screens() {
        assert_eq!(dashboard_page("open-dashboard", Some("update"), None, false), Some(("update", None)));
        assert_eq!(dashboard_page("open-dashboard", Some("dashboard"), None, false), Some(("dashboard", None)));
        assert_eq!(dashboard_page("open-dashboard", Some("sparks"), None, false), Some(("sparks", None)));
        assert_eq!(dashboard_page("open-dashboard", Some("supporters"), None, false), Some(("supporters", None)));
        for (path, open) in [
            ("open-dashboard", None),
            ("open-dashboard", Some("settings")),
            ("open-dashboard", Some("update ")),
            ("open-dashboard", Some("gallery")),
            ("open-dashboard", Some("store")),
            ("layer-rects", Some("update")),
        ] {
            assert_eq!(dashboard_page(path, open, None, false), None, "{path} {open:?}");
        }
    }

    #[test]
    fn the_menu_opens_the_gallery_the_dashboard_or_a_known_settings_category() {
        let page = |open, cat| dashboard_page("open-dashboard", open, cat, true);
        assert_eq!(page(Some("gallery"), None), Some(("gallery", None)));
        assert_eq!(page(Some("dashboard"), Some("capture")), Some(("dashboard", None)));
        assert_eq!(page(Some("store"), None), Some(("store", None)));
        assert_eq!(page(Some("sparks"), None), Some(("sparks", None)));
        assert_eq!(page(Some("settings"), Some("capture")), Some(("settings", Some("capture"))));
        assert_eq!(page(Some("settings"), Some("../x")), Some(("settings", None)));
        assert_eq!(page(Some("chat"), None), None);
        assert_eq!(dashboard_page("ai-glow", Some("gallery"), None, true), None);
    }

    #[test]
    fn a_widget_on_the_screen_may_open_only_settings() {
        let page = |open, cat| tile_settings("open-dashboard", open, cat);
        assert_eq!(page(Some("settings"), Some("streaming")), Some(("settings", Some("streaming"))));
        assert_eq!(page(Some("settings"), Some("../x")), Some(("settings", None)));
        for open in [None, Some("update"), Some("gallery"), Some("dashboard"), Some("settings ")] {
            assert_eq!(page(open, Some("ai")), None, "{open:?}");
        }
        assert_eq!(tile_settings("layer-rects", Some("settings"), None), None);
    }

    #[test]
    fn the_menu_surface_is_its_own_kind() {
        let s = parse(r#"{"surfaces":[{"key":"menu:","kind":"menu"},{"key":"menu:x","kind":"overlay"},{"key":"overlay:y","kind":"menu"}]}"#).unwrap();
        assert_eq!(s.surfaces.len(), 1);
        assert_eq!((s.surfaces[0].kind, s.surfaces[0].monitor.as_str()), (Kind::Menu, ""));
        assert!(is_menu("menu:") && !is_menu("draw:") && !is_draw("menu:") && !is_scene("menu:"));
    }

    #[test]
    fn keys_follow_the_page_rule() {
        assert!(valid_key("desktop:"));
        assert!(valid_key("overlay:\\\\.\\DISPLAY2"));
        assert!(valid_key("anchor:lw_ab12"));
        assert!(valid_key("alerts:"));
        for bad in ["desk:", "anchor:../x", "anchor:lw_AB12", "desktop:\u{1}", "overlay", "alerts:\u{1}"] {
            assert!(!valid_key(bad), "{bad}");
        }
        assert!(!valid_key(&format!("desktop:{}", "x".repeat(65))));
    }

    #[test]
    fn the_alerts_window_is_an_overlay_and_nothing_else() {
        let s = parse(r#"{"surfaces":[{"key":"alerts:","kind":"overlay"},{"key":"alerts:x","kind":"desktop"},{"key":"alerts:y","kind":"anchor","anchor":{"app":"a.exe"}}]}"#).unwrap();
        assert_eq!(s.surfaces.len(), 1);
        assert_eq!((s.surfaces[0].kind, s.surfaces[0].monitor.as_str()), (Kind::Overlay, ""));
        assert!(is_alerts(&s.surfaces[0].key));
        assert!(!is_alerts("overlay:"));
    }

    #[test]
    fn the_scene_windows_match_their_kind() {
        let s = parse(r#"{"surfaces":[
            {"key":"wallpaper:DISPLAY2","kind":"wallpaper"},
            {"key":"saver:DISPLAY2","kind":"saver","monitor":"DISPLAY9"},
            {"key":"saver:x","kind":"overlay"},
            {"key":"wallpaper:y","kind":"saver"},
            {"key":"overlay:z","kind":"wallpaper"}
        ]}"#).unwrap();
        let got: Vec<(&str, Kind, &str)> = s.surfaces.iter().map(|x| (x.key.as_str(), x.kind, x.monitor.as_str())).collect();
        assert_eq!(got, vec![("wallpaper:DISPLAY2", Kind::Wallpaper, "DISPLAY2"), ("saver:DISPLAY2", Kind::Saver, "DISPLAY2")]);
        assert!(is_scene("wallpaper:") && is_scene("saver:A"));
        assert!(!is_scene("overlay:") && !is_scene("alerts:"));
        assert!(!valid_key("saver:\u{1}") && !valid_key(&format!("wallpaper:{}", "x".repeat(65))));
    }

    #[test]
    fn a_full_widget_set_leaves_room_for_the_scenes() {
        let widgets: Vec<String> = (0..24).map(|i| format!(r#"{{"key":"anchor:lw_{i:04}","kind":"anchor","anchor":{{"app":"a.exe"}}}}"#)).collect();
        let scenes: Vec<String> = (0..8)
            .flat_map(|i| [format!(r#"{{"key":"wallpaper:D{i}","kind":"wallpaper"}}"#), format!(r#"{{"key":"saver:D{i}","kind":"saver"}}"#)])
            .collect();
        let json = format!(
            r#"{{"surfaces":[{{"key":"draw:","kind":"draw"}},{{"key":"alerts:","kind":"overlay"}},{},{}]}}"#,
            widgets.join(","),
            scenes.join(",")
        );
        assert_eq!(parse(&json).unwrap().surfaces.len(), MAX_SURFACES);
    }

    #[test]
    fn the_drawing_sheet_is_a_draw_window_and_nothing_else() {
        let s = parse(r#"{"surfaces":[{"key":"draw:","kind":"draw"},{"key":"draw:x","kind":"overlay"},{"key":"overlay:y","kind":"draw"}]}"#).unwrap();
        assert_eq!(s.surfaces.len(), 1);
        assert_eq!((s.surfaces[0].kind, s.surfaces[0].monitor.as_str()), (Kind::Draw, ""));
        assert!(is_draw("draw:") && !is_draw("overlay:") && !is_scene("draw:"));
    }

    #[test]
    fn a_surface_takes_its_monitor_from_its_key() {
        let s = parse(r#"{"surfaces":[{"key":"desktop:DISPLAY2","kind":"desktop","monitor":"DISPLAY9"}]}"#).unwrap();
        assert_eq!(s.surfaces[0].monitor, "DISPLAY2");
    }

    #[test]
    fn a_kind_that_contradicts_its_key_is_dropped() {
        let s = parse(r#"{"surfaces":[{"key":"desktop:","kind":"overlay"},{"key":"anchor:lw_ab12","kind":"desktop"}]}"#).unwrap();
        assert!(s.surfaces.is_empty());
    }

    #[test]
    fn an_anchor_needs_an_app_name_and_gets_clamped() {
        let s = parse(r#"{"exclude":true,"surfaces":[
            {"key":"anchor:lw_ab12","kind":"anchor","anchor":{"app":"krita.exe","corner":"bl","w":5,"h":99999,"dx":-99999}},
            {"key":"anchor:lw_cd34","kind":"anchor","anchor":{"app":"C:\\x\\evil.exe"}},
            {"key":"anchor:lw_ef56","kind":"anchor"}
        ]}"#).unwrap();
        assert!(s.exclude);
        assert_eq!(s.surfaces.len(), 1);
        let a = s.surfaces[0].anchor.as_ref().unwrap();
        assert_eq!((a.w, a.h, a.dx), (ANCHOR_MIN_PX, ANCHOR_MAX_PX, -ANCHOR_MAX_OFFSET));
        assert_eq!(a.corner(), Corner::BottomLeft);
    }

    #[test]
    fn desks_is_off_unless_the_dashboard_asks() {
        assert!(!parse(r#"{"surfaces":[]}"#).unwrap().desks);
        assert!(parse(r#"{"desks":true,"surfaces":[]}"#).unwrap().desks);
        assert!(!parse(r#"{"surfaces":[]}"#).unwrap().pad, "the controller is read only when asked");
        assert!(parse(r#"{"pad":true,"surfaces":[]}"#).unwrap().pad);
    }

    #[test]
    fn repeated_keys_and_extra_surfaces_are_dropped() {
        let many: Vec<String> = (0..50).map(|i| format!(r#"{{"key":"anchor:lw_{i:04}","kind":"anchor","anchor":{{"app":"a.exe"}}}}"#)).collect();
        let json = format!(r#"{{"surfaces":[{{"key":"desktop:","kind":"desktop"}},{{"key":"desktop:","kind":"desktop"}},{}]}}"#, many.join(","));
        let s = parse(&json).unwrap();
        assert_eq!(s.surfaces.len(), MAX_SURFACES);
        assert_eq!(s.surfaces.iter().filter(|x| x.key == "desktop:").count(), 1);
    }

    #[test]
    fn junk_is_refused_not_guessed() {
        assert!(parse("not json").is_none());
        assert!(parse(&"x".repeat(MAX_PAYLOAD + 1)).is_none());
        assert!(parse("{}").unwrap().surfaces.is_empty());
    }

    #[test]
    fn rects_skip_malformed_and_empty_entries() {
        assert_eq!(parse_rects("10,20,300,200;bad;1,2,0,5;5,6,7"), vec![[10, 20, 300, 200]]);
        assert_eq!(parse_rects("0,0,99999999,4"), vec![[0, 0, MAX_COORD, 4]]);
        assert!(parse_rects("").is_empty());
        let many = vec!["1,1,1,1"; 100].join(";");
        assert_eq!(parse_rects(&many).len(), MAX_RECTS);
    }
}

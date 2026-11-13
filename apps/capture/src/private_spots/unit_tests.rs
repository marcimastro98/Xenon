// Tests of the areas kept out of a capture.

use super::{find, Kind, Rect, Word};

#[cfg(test)]
mod tests {
    use super::*;

    /// Words laid out left to right, 10 px per character plus a space.
    fn line(text: &str, y: f32) -> Vec<Word> {
        let mut x = 0.0;
        text.split(' ')
            .map(|t| {
                let w = t.len() as f32 * 10.0;
                let word = Word {
                    text: t.to_owned(),
                    rect: Rect { x, y, w, h: 20.0 },
                };
                x += w + 10.0;
                word
            })
            .collect()
    }

    fn kinds(text: &str) -> Vec<&'static str> {
        find(&[line(text, 0.0)])
            .iter()
            .map(|s| s.kind.name())
            .collect()
    }

    #[test]
    fn emails_are_found_with_their_punctuation_around() {
        assert_eq!(kinds("write to mario.rossi@example.it today"), ["email"]);
        assert_eq!(kinds("(anna@example.co.uk),"), ["email"]);
        assert!(kinds("@handle and name@ and a@b and x@y.z1").is_empty());
    }

    #[test]
    fn a_phone_split_by_spaces_is_one_spot_over_all_its_words() {
        let spots = find(&[line("Call +39 333 123 4567 now", 40.0)]);
        assert_eq!(spots.len(), 1);
        assert_eq!(spots[0].kind, Kind::Number);
        // From "+39" (x 50) to the end of "4567" (x 170 + 40).
        assert_eq!(
            spots[0].rect,
            Rect {
                x: 50.0,
                y: 40.0,
                w: 160.0,
                h: 20.0
            }
        );
    }

    #[test]
    fn cards_and_ids_are_numbers_but_dates_prices_and_times_are_not() {
        assert_eq!(kinds("4111 1111 1111 1111"), ["number"]);
        assert_eq!(kinds("order 123-456-789"), ["number"]);
        assert!(kinds("27/10/2026 2026-10-27 27.10.26").is_empty());
        assert!(kinds("12:30 total 1.299 euro year 2026").is_empty());
        assert!(kinds("12,345,678.90").is_empty());
    }

    #[test]
    fn ibans_are_found_in_one_piece_or_in_groups() {
        assert_eq!(kinds("IBAN IT60X0542811101000000123456"), ["iban"]);
        assert_eq!(kinds("IT60 X054 2811 1010 0000 0123 456 thanks"), ["iban"]);
        let spots = find(&[line("DE89 3704 0044 0532 0130 00", 0.0)]);
        assert_eq!(spots.len(), 1);
        assert_eq!(spots[0].rect.x, 0.0);
        // Too short for an IBAN: a code, not private.
        assert!(kinds("AB12 CD34").is_empty());
    }

    #[test]
    fn several_spots_on_several_lines_come_in_reading_order() {
        let lines = [
            line("a@b.com and 0123456789", 0.0),
            line("IT60X0542811101000000123456", 30.0),
        ];
        let found: Vec<_> = find(&lines).iter().map(|s| s.kind.name()).collect();
        assert_eq!(found, ["email", "number", "iban"]);
        assert!(find(&[]).is_empty());
    }

    #[test]
    fn the_cover_is_padded_and_stays_inside_the_picture() {
        let r = Rect {
            x: 1.0,
            y: 5.0,
            w: 100.0,
            h: 20.0,
        };
        assert_eq!(r.padded(1000, 1000), (0, 2, 104, 26));
        assert_eq!(r.padded(50, 20), (0, 2, 50, 18));
    }
}

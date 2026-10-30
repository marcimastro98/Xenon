//! Where a picture shows something private: e-mail addresses, IBANs and long
//! numbers (phones, cards, ids), found in the words the OCR read (win/ocr.rs).
//! Only the rectangles leave the engine, never the text: the gallery proposes
//! them as covers before a screenshot is shared, and `cover` paints them.

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl Rect {
    fn union(self, o: Rect) -> Rect {
        let (x0, y0) = (self.x.min(o.x), self.y.min(o.y));
        let (x1, y1) = (
            (self.x + self.w).max(o.x + o.w),
            (self.y + self.h).max(o.y + o.h),
        );
        Rect {
            x: x0,
            y: y0,
            w: x1 - x0,
            h: y1 - y0,
        }
    }

    /// A little larger, so the cover hides the letters' edges too, kept inside
    /// the picture.
    pub fn padded(self, width: u32, height: u32) -> (u32, u32, u32, u32) {
        let pad = (self.h * PAD).max(2.0);
        let x0 = (self.x - pad).max(0.0).floor() as u32;
        let y0 = (self.y - pad).max(0.0).floor() as u32;
        let x1 = ((self.x + self.w + pad).ceil() as u32).min(width);
        let y1 = ((self.y + self.h + pad).ceil() as u32).min(height);
        (x0, y0, x1.saturating_sub(x0), y1.saturating_sub(y0))
    }
}

pub struct Word {
    pub text: String,
    pub rect: Rect,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    Email,
    Iban,
    Number,
}

impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Kind::Email => "email",
            Kind::Iban => "iban",
            Kind::Number => "number",
        }
    }
}

#[derive(Debug, PartialEq)]
pub struct Spot {
    pub kind: Kind,
    pub rect: Rect,
}

const PAD: f32 = 0.15;
/// Fewer digits than this is a price, a time, a year, not something private.
const MIN_DIGITS: usize = 7;
const IBAN_MIN: usize = 15;
const IBAN_MAX: usize = 34;

fn is_email(w: &str) -> bool {
    let w =
        w.trim_matches(|c: char| matches!(c, '<' | '>' | '(' | ')' | ',' | ';' | ':' | '"' | '\''));
    let Some((local, domain)) = w.split_once('@') else {
        return false;
    };
    let tld = domain.rsplit('.').next().unwrap_or("");
    !local.is_empty()
        && domain.contains('.')
        && !domain.starts_with('.')
        && tld.len() >= 2
        && tld.chars().all(|c| c.is_ascii_alphabetic())
}

/// Digits and the marks numbers are written with; at least one digit.
fn is_numberish(w: &str) -> bool {
    w.chars().any(|c| c.is_ascii_digit())
        && w.chars()
            .all(|c| c.is_ascii_digit() || matches!(c, '+' | '-' | '.' | '/' | '(' | ')'))
}

fn digits(w: &str) -> usize {
    w.chars().filter(char::is_ascii_digit).count()
}

/// 27/10/2026, 2026-10-27, 27.10.26: a date, not an id.
fn is_date(w: &str) -> bool {
    let parts: Vec<&str> = w.split(['/', '-', '.']).collect();
    if parts.len() != 3
        || !parts
            .iter()
            .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
    {
        return false;
    }
    let l: Vec<usize> = parts.iter().map(|p| p.len()).collect();
    matches!(
        (l[0], l[1], l[2]),
        (1..=2, 1..=2, 2 | 4) | (4, 1..=2, 1..=2)
    )
}

/// Two capital letters, two digits, then letters and digits: how an IBAN starts.
fn iban_start(w: &str) -> bool {
    let b = w.as_bytes();
    b.len() >= 4
        && b[0].is_ascii_uppercase()
        && b[1].is_ascii_uppercase()
        && b[2].is_ascii_digit()
        && b[3].is_ascii_digit()
        && b.iter()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
}

fn iban_group(w: &str) -> bool {
    (1..=4).contains(&w.len())
        && w.bytes()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
}

/// An IBAN written in one piece or in groups of four, from `words[i]`: how many
/// words it takes, or 0.
fn iban_at(words: &[Word], i: usize) -> usize {
    if !iban_start(&words[i].text) {
        return 0;
    }
    let mut len = words[i].text.len();
    let mut n = 1;
    while i + n < words.len() && len < IBAN_MAX && iban_group(&words[i + n].text) {
        len += words[i + n].text.len();
        n += 1;
    }
    if (IBAN_MIN..=IBAN_MAX).contains(&len) {
        n
    } else {
        0
    }
}

/// The private spots of one line of words.
fn line_spots(words: &[Word], out: &mut Vec<Spot>) {
    let mut i = 0;
    while i < words.len() {
        if is_email(&words[i].text) {
            out.push(Spot {
                kind: Kind::Email,
                rect: words[i].rect,
            });
            i += 1;
            continue;
        }
        let n = iban_at(words, i);
        if n > 0 {
            let rect = words[i + 1..i + n]
                .iter()
                .fold(words[i].rect, |r, w| r.union(w.rect));
            out.push(Spot {
                kind: Kind::Iban,
                rect,
            });
            i += n;
            continue;
        }
        // A number split by spaces ("+39 333 123 4567") is one run of words; a
        // date ends it.
        let mut n = 0;
        while i + n < words.len()
            && is_numberish(&words[i + n].text)
            && !is_date(&words[i + n].text)
        {
            n += 1;
        }
        if n == 0 {
            i += 1;
            continue;
        }
        let run = &words[i..i + n];
        if run.iter().map(|w| digits(&w.text)).sum::<usize>() >= MIN_DIGITS {
            let rect = run[1..].iter().fold(run[0].rect, |r, w| r.union(w.rect));
            out.push(Spot {
                kind: Kind::Number,
                rect,
            });
        }
        i += n;
    }
}

/// Every private spot in the lines the OCR read, in reading order.
pub fn find(lines: &[Vec<Word>]) -> Vec<Spot> {
    let mut out = Vec::new();
    for words in lines {
        line_spots(words, &mut out);
    }
    out
}

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
        assert_eq!(kinds("(anna@mail.co.uk),"), ["email"]);
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

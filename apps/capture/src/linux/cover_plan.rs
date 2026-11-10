//! Covering private spots on Linux, the pure part: tesseract's TSV read into
//! the lines of words crate::private_spots looks through, and ffmpeg's
//! arguments for the copy with the spots painted black (cover.rs runs them).

use crate::private_spots::{Rect, Word};

/// Most spots painted in one copy: past this the picture is a wall of numbers
/// and the filter would only grow.
pub const MAX_SPOTS: usize = 400;

/// tesseract's `tsv` output as lines of words, in reading order; a line is
/// one (block, paragraph, line) and only level-5 rows (words) count.
pub fn tsv_lines(tsv: &str) -> Vec<Vec<Word>> {
    let mut lines: Vec<((u32, u32, u32), Vec<Word>)> = Vec::new();
    for row in tsv.lines().skip(1) {
        let cols: Vec<&str> = row.split('\t').collect();
        if cols.len() < 12 || cols[0] != "5" {
            continue;
        }
        let text = cols[11..].join("\t").trim().to_owned();
        let num = |i: usize| cols[i].trim().parse::<u32>().ok();
        let (Some(block), Some(par), Some(line)) = (num(2), num(3), num(4)) else {
            continue;
        };
        let (Some(x), Some(y), Some(w), Some(h)) = (num(6), num(7), num(8), num(9)) else {
            continue;
        };
        if text.is_empty() || w == 0 || h == 0 {
            continue;
        }
        let word = Word {
            text,
            rect: Rect {
                x: x as f32,
                y: y as f32,
                w: w as f32,
                h: h as f32,
            },
        };
        let key = (block, par, line);
        match lines.last_mut() {
            Some((k, words)) if *k == key => words.push(word),
            _ => lines.push((key, vec![word])),
        }
    }
    lines.into_iter().map(|(_, words)| words).collect()
}

/// ffmpeg's arguments for a PNG copy of `src` at `part` with each `(x, y, w,
/// h)` painted solid black, so nothing of the text is left to undo.
pub fn paint_args(src: &str, part: &str, spots: &[(u32, u32, u32, u32)]) -> Vec<String> {
    let boxes: Vec<String> = spots
        .iter()
        .take(MAX_SPOTS)
        .map(|(x, y, w, h)| format!("drawbox=x={x}:y={y}:w={w}:h={h}:color=black:t=fill"))
        .collect();
    let filter = format!("format=rgb24,{}", boxes.join(","));
    [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-i",
        src,
        "-vf",
        &filter,
        "-frames:v",
        "1",
        "-c:v",
        "png",
        "-f",
        "image2",
        part,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEAD: &str = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n";

    #[test]
    fn tsv_words_group_into_their_lines() {
        let tsv = format!(
            "{HEAD}1\t1\t0\t0\t0\t0\t0\t0\t800\t600\t-1\t\n\
             4\t1\t1\t1\t1\t0\t10\t10\t300\t20\t-1\t\n\
             5\t1\t1\t1\t1\t1\t10\t10\t60\t20\t96.1\tMail:\n\
             5\t1\t1\t1\t1\t2\t80\t10\t200\t20\t91.0\tme@example.com\n\
             5\t1\t1\t1\t2\t1\t10\t40\t90\t20\t90.0\t+39\n\
             5\t1\t1\t1\t2\t2\t110\t40\t5\t20\t10.0\t \n\
             5\t1\t2\t1\t1\t1\t10\t80\t40\t20\t90.0\tok\n\
             5\tbroken\n"
        );
        let lines = tsv_lines(&tsv);
        let text: Vec<Vec<&str>> = lines
            .iter()
            .map(|l| l.iter().map(|w| w.text.as_str()).collect())
            .collect();
        assert_eq!(text, vec![vec!["Mail:", "me@example.com"], vec!["+39"], vec!["ok"]]);
        assert_eq!(
            lines[0][1].rect,
            Rect {
                x: 80.0,
                y: 10.0,
                w: 200.0,
                h: 20.0
            }
        );
        assert!(tsv_lines("").is_empty());
    }

    #[test]
    fn the_spots_are_painted_black_into_a_png() {
        let args = paint_args("in.png", "out.png.part", &[(1, 2, 3, 4), (5, 6, 7, 8)]);
        let vf = &args[args.iter().position(|a| a == "-vf").unwrap() + 1];
        assert_eq!(
            vf,
            "format=rgb24,drawbox=x=1:y=2:w=3:h=4:color=black:t=fill,drawbox=x=5:y=6:w=7:h=8:color=black:t=fill"
        );
        assert_eq!(&args[args.len() - 5..], ["-c:v", "png", "-f", "image2", "out.png.part"]);
        let many = vec![(0, 0, 1, 1); MAX_SPOTS + 10];
        let vf = paint_args("a", "b", &many)
            .into_iter()
            .find(|a| a.starts_with("format="))
            .unwrap();
        assert_eq!(vf.matches("drawbox").count(), MAX_SPOTS);
    }
}

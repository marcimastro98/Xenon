//! The text read off the screen: how lines are put back together. The OCR
//! itself is the OS's (win/ocr.rs). Measured on 8-16 pt screen text: the
//! picture as captured reads best; doubling it or turning it grey lost lines.

/// Chinese and Japanese are written without spaces; the OCR still hands back
/// one "word" per character group, so their words are joined as they are.
pub fn joins_without_spaces(lang_tag: &str) -> bool {
    let primary = lang_tag.split(['-', '_']).next().unwrap_or("");
    matches!(primary.to_ascii_lowercase().as_str(), "zh" | "ja")
}

/// Each line on its own row, its words joined the way the language writes them.
pub fn join(lines: &[Vec<String>], no_spaces: bool) -> String {
    let glue = if no_spaces { "" } else { " " };
    lines
        .iter()
        .map(|words| words.join(glue))
        .filter(|l| !l.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn lines_keep_their_rows_and_words_their_spaces() {
        let lines = vec![words(&["Hello", "world"]), words(&["second", "line"])];
        assert_eq!(join(&lines, false), "Hello world\nsecond line");
    }

    #[test]
    fn chinese_and_japanese_words_join_without_spaces() {
        assert!(joins_without_spaces("zh-Hans-CN"));
        assert!(joins_without_spaces("ja"));
        assert!(!joins_without_spaces("ko-KR"));
        assert!(!joins_without_spaces("it-IT"));
        assert!(!joins_without_spaces(""));
        let lines = vec![words(&["你好", "世界"])];
        assert_eq!(join(&lines, true), "你好世界");
    }

    #[test]
    fn empty_lines_are_dropped() {
        let lines = vec![words(&["a"]), words(&[]), words(&[" "]), words(&["b"])];
        assert_eq!(join(&lines, false), "a\nb");
        assert_eq!(join(&[], false), "");
    }
}

// Linux: thumbnails, trims, speech, reading text from a picture, and the folder picker.

/// ffmpeg's argv for a JPEG preview `width` wide of a picture or a video.
pub fn thumb_args(src: &str, width: u32, video: bool, out: &str) -> Vec<String> {
    let scale = format!("scale='min({width},iw)':-2");
    let filter = if video {
        format!("thumbnail=60,{scale}")
    } else {
        scale
    };
    vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-y".into(),
        "-i".into(),
        src.into(),
        "-vf".into(),
        filter,
        "-frames:v".into(),
        "1".into(),
        "-f".into(),
        "image2".into(),
        "-c:v".into(),
        "mjpeg".into(),
        "-q:v".into(),
        "4".into(),
        out.into(),
    ]
}

/// ffprobe's argv for the first video stream's size.
pub fn probe_size_args(src: &str) -> Vec<String> {
    [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height",
        "-of",
        "csv=p=0:s=x",
        src,
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect()
}

/// `1920x1080` as ffprobe writes it.
pub fn parse_size(out: &str) -> Option<(u32, u32)> {
    let (w, h) = out.lines().next()?.trim().split_once('x')?;
    let (w, h) = (w.parse::<u32>().ok()?, h.parse::<u32>().ok()?);
    (w > 0 && h > 0).then_some((w, h))
}

/// ffmpeg's argv for a copy of `seconds` from `start`, streams as stored (the
/// cut starts on the keyframe before `start`, as on Windows).
pub fn trim_args(src: &str, out: &str, start: f64, seconds: f64) -> Vec<String> {
    vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-y".into(),
        "-ss".into(),
        format!("{start:.3}"),
        "-i".into(),
        src.into(),
        "-t".into(),
        format!("{seconds:.3}"),
        "-map".into(),
        "0".into(),
        "-c".into(),
        "copy".into(),
        "-avoid_negative_ts".into(),
        "make_zero".into(),
        "-movflags".into(),
        "+faststart".into(),
        "-f".into(),
        "mp4".into(),
        out.into(),
    ]
}

/// ffmpeg's argv for the sound as a 16 kHz mono WAV with a plain 44-byte header.
pub fn speech_args(src: &str, out: &str) -> Vec<String> {
    vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-y".into(),
        "-i".into(),
        src.into(),
        "-vn".into(),
        "-ac".into(),
        "1".into(),
        "-ar".into(),
        crate::speech::RATE.to_string(),
        "-c:a".into(),
        "pcm_s16le".into(),
        "-bitexact".into(),
        "-map_metadata".into(),
        "-1".into(),
        "-f".into(),
        "wav".into(),
        out.into(),
    ]
}

pub fn wav_seconds(bytes: u64) -> f64 {
    let data = bytes.saturating_sub(crate::speech::HEADER_LEN as u64);
    data as f64 / (crate::speech::RATE as f64 * 2.0)
}

/// A PNG's size from its header; None when it is not a PNG.
pub fn png_size(head: &[u8]) -> Option<(u32, u32)> {
    const SIG: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    if head.len() < 24 || head[..8] != SIG || &head[12..16] != b"IHDR" {
        return None;
    }
    let be = |b: &[u8]| u32::from_be_bytes([b[0], b[1], b[2], b[3]]);
    Some((be(&head[16..20]), be(&head[20..24])))
}

/// The locale's tesseract language plus English, among those installed
/// (`tesseract --list-langs`); None when none is.
pub fn ocr_langs(listing: &str, locale: &str) -> Option<String> {
    let have: Vec<&str> = listing
        .lines()
        .skip_while(|l| !l.starts_with("List of available languages"))
        .skip(1)
        .map(str::trim)
        .filter(|l| !l.is_empty() && *l != "osd")
        .collect();
    let lang = locale.split(['_', '.', '-']).next().unwrap_or("");
    const CODES: &[(&str, &str)] = &[
        ("it", "ita"),
        ("de", "deu"),
        ("fr", "fra"),
        ("es", "spa"),
        ("pt", "por"),
        ("nl", "nld"),
        ("pl", "pol"),
        ("ru", "rus"),
        ("ja", "jpn"),
        ("ko", "kor"),
        ("zh", "chi_sim"),
        ("tr", "tur"),
        ("sv", "swe"),
        ("cs", "ces"),
        ("uk", "ukr"),
    ];
    let mine = CODES.iter().find(|(l, _)| *l == lang).map(|(_, c)| *c);
    let mut pick: Vec<&str> = mine
        .into_iter()
        .chain(["eng"])
        .filter(|c| have.contains(c))
        .collect();
    if pick.is_empty() {
        pick.extend(have.first());
    }
    (!pick.is_empty()).then(|| pick.join("+"))
}

/// tesseract's text as lines, blank ones dropped.
pub fn ocr_lines(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_owned)
        .collect()
}

/// The argv of the folder dialog: zenity, or kdialog on KDE.
pub fn folder_args(zenity: bool, title: &str, start: &str) -> Vec<String> {
    let start = if start.starts_with('/') { start } else { "" };
    if zenity {
        let mut a = vec![
            "--file-selection".to_owned(),
            "--directory".to_owned(),
            format!("--title={title}"),
        ];
        if !start.is_empty() {
            a.push(format!("--filename={}/", start.trim_end_matches('/')));
        }
        a
    } else {
        let mut a = vec!["--getexistingdirectory".to_owned()];
        a.push(if start.is_empty() {
            "~".to_owned()
        } else {
            start.to_owned()
        });
        a.extend(["--title".to_owned(), title.to_owned()]);
        a
    }
}

/// A file list as `text/uri-list` (RFC 2483), each path percent-encoded.
pub fn uri_list(paths: &[String]) -> String {
    let mut out = String::new();
    for p in paths {
        out.push_str("file://");
        for b in p.bytes() {
            if b.is_ascii_alphanumeric() || b"/-_.~".contains(&b) {
                out.push(b as char);
            } else {
                out.push_str(&format!("%{b:02X}"));
            }
        }
        out.push_str("\r\n");
    }
    out
}

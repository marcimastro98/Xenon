//! Text on screen with Windows' own OCR (Windows.Media.Ocr), in the languages
//! of the user's profile that have an OCR pack. Nothing leaves the PC.

use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
use windows::Media::Ocr::OcrEngine;
use windows::Security::Cryptography::CryptographicBuffer;

use super::grab;
use crate::ocr_text;
use crate::pixels;
use crate::private_spots::{Rect, Word};
use crate::proto::Fail;

pub struct Read {
    pub text: String,
    pub lines: usize,
    pub lang: String,
}

/// True when at least one installed language can be read.
pub fn available() -> bool {
    OcrEngine::AvailableRecognizerLanguages()
        .and_then(|l| l.Size())
        .map(|n| n > 0)
        .unwrap_or(false)
}

/// The engine for the user's languages, or None when none has an OCR pack.
pub fn engine() -> Option<OcrEngine> {
    OcrEngine::TryCreateFromUserProfileLanguages().ok()
}

/// What the OCR saw in `image`: its language and, line by line, each word
/// with its rectangle in the picture's pixels.
fn recognize(engine: &OcrEngine, image: &grab::Image) -> Result<(String, Vec<Vec<Word>>), Fail> {
    let max = OcrEngine::MaxImageDimension().unwrap_or(4096);
    let (w, h) = (image.width, image.height);
    if w > max || h > max {
        return Err(Fail::code("too_large"));
    }
    let mut bgra = vec![0u8; (w * h * 4) as usize];
    pixels::to_bgra(&image.bgr, &mut bgra, pixels::FULL);
    let fail = |e: windows::core::Error| Fail::new("ocr_failed", e);
    let buffer = CryptographicBuffer::CreateFromByteArray(&bgra).map_err(fail)?;
    let bitmap =
        SoftwareBitmap::CreateCopyFromBuffer(&buffer, BitmapPixelFormat::Bgra8, w as i32, h as i32)
            .map_err(fail)?;
    let result = engine
        .RecognizeAsync(&bitmap)
        .and_then(|op| op.join())
        .map_err(fail)?;
    let lang = engine
        .RecognizerLanguage()
        .and_then(|l| l.LanguageTag())
        .map(|t| t.to_string())
        .unwrap_or_default();
    let lines = result.Lines().map_err(fail)?;
    let mut rows = Vec::new();
    for i in 0..lines.Size().map_err(fail)? {
        let words = lines.GetAt(i).and_then(|l| l.Words()).map_err(fail)?;
        let mut row = Vec::new();
        for j in 0..words.Size().map_err(fail)? {
            let word = words.GetAt(j).map_err(fail)?;
            let r = word.BoundingRect().map_err(fail)?;
            row.push(Word {
                text: word.Text().map_err(fail)?.to_string(),
                rect: Rect {
                    x: r.X,
                    y: r.Y,
                    w: r.Width,
                    h: r.Height,
                },
            });
        }
        rows.push(row);
    }
    Ok((lang, rows))
}

pub fn read(engine: &OcrEngine, image: &grab::Image) -> Result<Read, Fail> {
    let (lang, rows) = recognize(engine, image)?;
    let rows: Vec<Vec<String>> = rows
        .into_iter()
        .map(|row| row.into_iter().map(|w| w.text).collect())
        .collect();
    let text = ocr_text::join(&rows, ocr_text::joins_without_spaces(&lang));
    let lines = text.lines().count();
    Ok(Read { text, lines, lang })
}

/// The words of `image` with where they are, for private_spots.rs.
pub fn words(engine: &OcrEngine, image: &grab::Image) -> Result<Vec<Vec<Word>>, Fail> {
    recognize(engine, image).map(|(_, rows)| rows)
}

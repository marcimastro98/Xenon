//! The private spots of a saved picture (private_spots.rs), read by Windows'
//! OCR on a thread of its own: the gallery's editor proposes them as covers,
//! and with `out` a copy is written with them painted over (the original is
//! never touched). The words never leave this file; only rectangles do.

use serde_json::{json, Value};
use windows::core::{Error, Interface, Result, HSTRING};
use windows::Media::Ocr::OcrEngine;
use windows::Win32::Foundation::GENERIC_READ;
use windows::Win32::Graphics::Imaging::{
    CLSID_WICImagingFactory, GUID_WICPixelFormat24bppBGR, IWICBitmapSource, IWICImagingFactory,
    WICBitmapDitherTypeNone, WICBitmapInterpolationModeFant, WICBitmapPaletteTypeCustom,
    WICDecodeMetadataCacheOnDemand,
};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};

use super::edit::{self, Jobs};
use super::grab::Image;
use super::{ocr, png};
use crate::private_spots::{self, Rect, Word};
use crate::proto::{Fail, Notify};

/// A spot's kind and its padded rectangle (x, y, w, h) in the picture.
type Found = (&'static str, (u32, u32, u32, u32));

/// What a cover paints: plain black, so nothing of the text is left to undo.
const INK: [u8; 3] = [0, 0, 0];

/// The picture at `src` as tight BGR rows, scaled down to fit `fit` when it is
/// larger (the OCR reads at most its MaxImageDimension).
fn decode(src: &str, fit: Option<u32>) -> Result<Image> {
    unsafe {
        let wic: IWICImagingFactory =
            CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)?;
        let decoder = wic.CreateDecoderFromFilename(
            &HSTRING::from(src),
            None,
            GENERIC_READ,
            WICDecodeMetadataCacheOnDemand,
        )?;
        let frame = decoder.GetFrame(0)?;
        let (mut w, mut h) = (0, 0);
        frame.GetSize(&mut w, &mut h)?;
        if w == 0 || h == 0 {
            return Err(Error::empty());
        }
        let mut source: IWICBitmapSource = frame.cast()?;
        if let Some(max) = fit.filter(|m| w > *m || h > *m) {
            let k = max as f64 / w.max(h) as f64;
            let (sw, sh) = (
                ((w as f64 * k) as u32).max(1),
                ((h as f64 * k) as u32).max(1),
            );
            let scaler = wic.CreateBitmapScaler()?;
            scaler.Initialize(&source, sw, sh, WICBitmapInterpolationModeFant)?;
            source = scaler.cast()?;
            (w, h) = (sw, sh);
        }
        let bgr = wic.CreateFormatConverter()?;
        bgr.Initialize(
            &source,
            &GUID_WICPixelFormat24bppBGR,
            WICBitmapDitherTypeNone,
            None,
            0.0,
            WICBitmapPaletteTypeCustom,
        )?;
        let mut pixels = vec![0u8; (w * h * 3) as usize];
        bgr.CopyPixels(std::ptr::null(), w * 3, &mut pixels)?;
        Ok(Image {
            width: w,
            height: h,
            bgr: pixels,
        })
    }
}

fn paint(image: &mut Image, (x, y, w, h): (u32, u32, u32, u32)) {
    for row in y..y + h {
        let at = ((row * image.width + x) * 3) as usize;
        for px in image.bgr[at..at + (w * 3) as usize].chunks_exact_mut(3) {
            px.copy_from_slice(&INK);
        }
    }
}

/// The spots, in `image`'s pixels, padded; an error code when it cannot read.
fn spots(
    engine: &OcrEngine,
    image: &Image,
    src: &str,
) -> std::result::Result<Vec<Found>, &'static str> {
    let max = OcrEngine::MaxImageDimension().unwrap_or(4096);
    let small;
    let (read, k) = if image.width > max || image.height > max {
        small = decode(src, Some(max)).map_err(|_| "cover_failed")?;
        let k = image.width as f32 / small.width as f32;
        (&small, k)
    } else {
        (image, 1.0)
    };
    let lines = ocr::words(engine, read).map_err(|_| "cover_failed")?;
    let scale = |r: Rect| Rect {
        x: r.x * k,
        y: r.y * k,
        w: r.w * k,
        h: r.h * k,
    };
    let lines: Vec<Vec<Word>> = lines
        .into_iter()
        .map(|row| {
            row.into_iter()
                .map(|w| Word {
                    text: w.text,
                    rect: scale(w.rect),
                })
                .collect()
        })
        .collect();
    Ok(private_spots::find(&lines)
        .into_iter()
        .map(|s| (s.kind.name(), s.rect.padded(image.width, image.height)))
        .filter(|(_, (_, _, w, h))| *w > 0 && *h > 0)
        .collect())
}

fn work(src: &str, out: Option<&str>) -> Value {
    let Some(engine) = ocr::engine() else {
        return json!({ "error": "no_ocr_language" });
    };
    let Ok(mut image) = decode(src, None) else {
        return json!({ "error": "cover_failed" });
    };
    let found = match spots(&engine, &image, src) {
        Ok(found) => found,
        Err(code) => return json!({ "error": code }),
    };
    let list: Vec<Value> = found
        .iter()
        .map(|(kind, (x, y, w, h))| json!({ "kind": kind, "x": x, "y": y, "w": w, "h": h }))
        .collect();
    // Nothing to cover: no copy that would only repeat the original.
    if let Some(out) = out.filter(|_| !found.is_empty()) {
        for (_, r) in &found {
            paint(&mut image, *r);
        }
        let part = format!("{out}.part");
        let written = png::write(&part, image.width, image.height, &image.bgr)
            .and_then(|_| std::fs::rename(&part, out).map_err(|_| Error::empty()));
        if written.is_err() {
            let _ = std::fs::remove_file(&part);
            return json!({ "error": "write_failed" });
        }
    }
    json!({ "width": image.width, "height": image.height, "spots": list })
}

/// `{ src, out?, token }`: the private spots of the picture at `src` as the
/// event `cover_done` `{ width, height, spots: [{ kind, x, y, w, h }] }`, or
/// `error`; with `out`, a copy with them painted over is written there first
/// (none when there is nothing to cover).
pub fn start(req: &Value, notify: Notify, jobs: &Jobs) -> std::result::Result<Value, Fail> {
    let src = edit::text(req, "src")?;
    let out = req
        .get("out")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let token = req.get("token").cloned().unwrap_or(Value::Null);
    edit::spawn(jobs, notify, "cover_done", token, move || {
        work(&src, out.as_deref())
    })
}

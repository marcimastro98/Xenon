//! Pictures through CoreGraphics and ImageIO: a frame's pixels made an image,
//! a saved picture read, black covers painted over parts of it, and images
//! written as a PNG, a JPEG or a looping GIF.

use std::ffi::c_void;
use std::path::Path;
use std::ptr::null_mut;

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_core_foundation::{CFDictionary, CFRetained, CFString, CGPoint, CGRect, CGSize, CFURL};
use objc2_core_graphics::{
    kCGColorSpaceSRGB, CGBitmapContextCreate, CGBitmapContextCreateImage, CGColorSpace,
    CGColorSpaceModel, CGContext, CGImage, CGImageAlphaInfo, CGImageByteOrderInfo,
    CGInterpolationQuality,
};
use objc2_foundation::{NSDictionary, NSNumber, NSString};
use objc2_image_io::{
    kCGImagePropertyGIFDelayTime, kCGImagePropertyGIFDictionary, kCGImagePropertyGIFLoopCount,
    kCGImageDestinationLossyCompressionQuality, kCGImagePropertyGIFUnclampedDelayTime,
    CGImageDestination, CGImageSource,
};

use super::frame::ns;
use super::writer::{any, dict};

pub type Image = CFRetained<CGImage>;

const PNG: &str = "public.png";
const JPEG: &str = "public.jpeg";
/// The steps' pictures: sharp text, a small file.
const JPEG_QUALITY: f64 = 0.85;
const GIF: &str = "com.compuserve.gif";

/// An NSDictionary as the CFDictionary it is (toll-free bridged).
fn cf(d: &NSDictionary<NSString, AnyObject>) -> &CFDictionary {
    unsafe { &*(d as *const NSDictionary<NSString, AnyObject>).cast::<CFDictionary>() }
}

fn srgb() -> Option<CFRetained<CGColorSpace>> {
    CGColorSpace::with_name(Some(unsafe { kCGColorSpaceSRGB }))
}

/// Four bytes a pixel, blue first, as the decoder and CoreGraphics lay them out.
fn bgra(alpha: CGImageAlphaInfo) -> u32 {
    alpha.0 | CGImageByteOrderInfo::Order32Little.0
}

pub fn size(image: &CGImage) -> (u32, u32) {
    (
        CGImage::width(Some(image)) as u32,
        CGImage::height(Some(image)) as u32,
    )
}

/// Tight BGRX rows `w` x `h` as an image (the pixels are copied).
pub fn from_bgrx(px: &[u8], (w, h): (u32, u32)) -> Option<Image> {
    let (w, h) = (w as usize, h as usize);
    if px.len() < w * h * 4 {
        return None;
    }
    let space = srgb()?;
    let info = bgra(CGImageAlphaInfo::NoneSkipFirst);
    // Only read: CGBitmapContextCreateImage copies before anything draws.
    let data = px.as_ptr() as *mut c_void;
    let context = unsafe { CGBitmapContextCreate(data, w, h, 8, w * 4, Some(&space), info) }?;
    CGBitmapContextCreateImage(Some(&context))
}

/// The first picture in the file at `path`.
pub fn open(path: &str) -> Option<Image> {
    let url = CFURL::from_file_path(path)?;
    let source = unsafe { CGImageSource::with_url(&url, None) }?;
    unsafe { source.image_at_index(0, None) }
}

/// `image` with black over each rectangle (x, y, w, h, top-left origin).
pub fn covered(image: &CGImage, rects: &[(u32, u32, u32, u32)]) -> Option<Image> {
    let (w, h) = size(image);
    let canvas = |space: CFRetained<CGColorSpace>| {
        let info = bgra(CGImageAlphaInfo::PremultipliedFirst);
        unsafe {
            CGBitmapContextCreate(null_mut(), w as usize, h as usize, 8, 0, Some(&space), info)
        }
    };
    // Its own colours when an 8-bit canvas takes them, so nothing but the
    // covers changes; sRGB otherwise.
    let context = CGImage::color_space(Some(image))
        .filter(|s| CGColorSpace::model(Some(s)) == CGColorSpaceModel::RGB)
        .and_then(canvas)
        .or_else(|| srgb().and_then(canvas))?;
    let whole = CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(w as f64, h as f64));
    CGContext::draw_image(Some(&context), whole, Some(image));
    CGContext::set_rgb_fill_color(Some(&context), 0.0, 0.0, 0.0, 1.0);
    for &(x, y, rw, rh) in rects {
        // CoreGraphics counts rows from the bottom.
        let at = CGPoint::new(x as f64, h as f64 - y as f64 - rh as f64);
        CGContext::fill_rect(
            Some(&context),
            CGRect::new(at, CGSize::new(rw as f64, rh as f64)),
        );
    }
    CGBitmapContextCreateImage(Some(&context))
}

/// `image` drawn at `w` x `h` as BGRX rows `w * 4` bytes apart.
pub fn scaled_bgrx(image: &CGImage, (w, h): (u32, u32)) -> Option<Vec<u8>> {
    let (w, h) = (w as usize, h as usize);
    let mut px = vec![0u8; w * h * 4];
    let space = srgb()?;
    let info = bgra(CGImageAlphaInfo::NoneSkipFirst);
    let data = px.as_mut_ptr() as *mut c_void;
    let context = unsafe { CGBitmapContextCreate(data, w, h, 8, w * 4, Some(&space), info) }?;
    CGContext::set_interpolation_quality(Some(&context), CGInterpolationQuality::High);
    let whole = CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(w as f64, h as f64));
    CGContext::draw_image(Some(&context), whole, Some(image));
    // The context draws into `px`; it is done with it once dropped.
    drop(context);
    Some(px)
}

fn destination(
    path: &Path,
    kind: &'static str,
    count: usize,
) -> Option<CFRetained<CGImageDestination>> {
    let url = CFURL::from_file_path(path)?;
    unsafe { CGImageDestination::with_url(&url, &CFString::from_static_str(kind), count, None) }
}

pub fn write_jpeg(image: &CGImage, path: &Path) -> bool {
    let Some(out) = destination(path, JPEG, 1) else {
        return false;
    };
    let quality = dict(&[(
        ns(unsafe { kCGImageDestinationLossyCompressionQuality }),
        any(NSNumber::new_f64(JPEG_QUALITY)),
    )]);
    unsafe {
        out.add_image(image, Some(cf(&quality)));
        out.finalize()
    }
}

pub fn write_png(image: &CGImage, path: &Path) -> bool {
    let Some(out) = destination(path, PNG, 1) else {
        return false;
    };
    unsafe {
        out.add_image(image, None);
        out.finalize()
    }
}

fn gif_props(
    key: &CFString,
    value: Retained<AnyObject>,
) -> Retained<NSDictionary<NSString, AnyObject>> {
    dict(&[(
        ns(unsafe { kCGImagePropertyGIFDictionary }),
        any(dict(&[(ns(key), value)])),
    )])
}

/// The frames as a GIF that plays again and again, `delay_cs` hundredths of
/// a second each; ImageIO makes each frame's palette.
pub fn write_gif(frames: &[Image], delay_cs: u16, path: &Path) -> bool {
    let Some(out) = destination(path, GIF, frames.len()) else {
        return false;
    };
    let seconds = || any(NSNumber::new_f64(delay_cs as f64 / 100.0));
    let forever = gif_props(
        unsafe { kCGImagePropertyGIFLoopCount },
        any(NSNumber::new_i64(0)),
    );
    // Both delays: ImageIO raises a plain delay under 0.1 s to 0.1 s.
    let delay = dict(&[(
        ns(unsafe { kCGImagePropertyGIFDictionary }),
        any(dict(&[
            (ns(unsafe { kCGImagePropertyGIFDelayTime }), seconds()),
            (
                ns(unsafe { kCGImagePropertyGIFUnclampedDelayTime }),
                seconds(),
            ),
        ])),
    )]);
    unsafe {
        out.set_properties(Some(cf(&forever)));
        for f in frames {
            out.add_image(f, Some(cf(&delay)));
        }
        out.finalize()
    }
}

//! Moves an MP4's index (`moov`) in front of its media (`mdat`), so a clip
//! starts playing before it has fully arrived (a chat app, a browser). Windows'
//! own option for this writes broken chunk offsets when the sink only copies
//! a stream, so the clip is written with the index at the end and moved here.

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::Path;

/// A top-level box: its type, where it starts and how long it is.
#[derive(Debug, PartialEq)]
struct Atom {
    kind: [u8; 4],
    at: u64,
    len: u64,
}

fn bad(what: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, what.to_string())
}

/// The top-level boxes of a file `total` bytes long.
fn atoms(r: &mut (impl Read + Seek), total: u64) -> io::Result<Vec<Atom>> {
    let mut out = Vec::new();
    let mut at = 0u64;
    while at + 8 <= total {
        r.seek(SeekFrom::Start(at))?;
        let mut head = [0u8; 8];
        r.read_exact(&mut head)?;
        let mut len = u32::from_be_bytes([head[0], head[1], head[2], head[3]]) as u64;
        if len == 1 {
            let mut big = [0u8; 8];
            r.read_exact(&mut big)?;
            len = u64::from_be_bytes(big);
        } else if len == 0 {
            len = total - at;
        }
        if len < 8 || at + len > total {
            return Err(bad("box past the end of the file"));
        }
        out.push(Atom {
            kind: [head[4], head[5], head[6], head[7]],
            at,
            len,
        });
        at += len;
    }
    Ok(out)
}

/// Boxes inside `moov` that can hold a chunk offset table.
const CONTAINERS: [&[u8; 4]; 5] = [b"moov", b"trak", b"mdia", b"minf", b"stbl"];

/// Adds `delta` to every chunk offset (`stco`, `co64`) in the boxes of
/// `data`, recursing through the containers that lead to them.
fn shift_offsets(data: &mut [u8], delta: u64) -> io::Result<()> {
    let mut at = 0usize;
    while at + 8 <= data.len() {
        let len = u32::from_be_bytes(data[at..at + 4].try_into().unwrap()) as usize;
        if len < 8 || at + len > data.len() {
            return Err(bad("box past the end of moov"));
        }
        let kind: [u8; 4] = data[at + 4..at + 8].try_into().unwrap();
        let body = &mut data[at + 8..at + len];
        if CONTAINERS.contains(&&kind) {
            shift_offsets(body, delta)?;
        } else if &kind == b"stco" || &kind == b"co64" {
            let wide = &kind == b"co64";
            let size = if wide { 8 } else { 4 };
            let count = body
                .get(4..8)
                .map(|b| u32::from_be_bytes(b.try_into().unwrap()) as usize)
                .ok_or_else(|| bad("short offset table"))?;
            if body.len() < 8 + count * size {
                return Err(bad("short offset table"));
            }
            for e in body[8..8 + count * size].chunks_exact_mut(size) {
                if wide {
                    let v = u64::from_be_bytes(e.try_into().unwrap()) + delta;
                    e.copy_from_slice(&v.to_be_bytes());
                } else {
                    let v = u32::from_be_bytes(e.try_into().unwrap()) as u64 + delta;
                    let v = u32::try_from(v).map_err(|_| bad("offset over 4 GB"))?;
                    e.copy_from_slice(&v.to_be_bytes());
                }
            }
        }
        at += len;
    }
    Ok(())
}

/// Rewrites `from` into `to` with the index first. Answers false (and writes
/// nothing) when the index already comes first.
pub fn rewrite(from: &Path, to: &Path) -> io::Result<bool> {
    let mut src = File::open(from)?;
    let total = src.metadata()?.len();
    let list = atoms(&mut src, total)?;
    let moov = list
        .iter()
        .position(|a| &a.kind == b"moov")
        .ok_or_else(|| bad("no moov"))?;
    let first_mdat = list
        .iter()
        .position(|a| &a.kind == b"mdat")
        .ok_or_else(|| bad("no mdat"))?;
    if moov < first_mdat {
        return Ok(false);
    }
    let m = &list[moov];
    let mut index = vec![0u8; m.len as usize];
    src.seek(SeekFrom::Start(m.at))?;
    src.read_exact(&mut index)?;
    // Everything from the first mdat to the moov moves down by its length.
    shift_offsets(&mut index[8..], m.len)?;

    let mut out = io::BufWriter::with_capacity(1 << 20, File::create(to)?);
    let split = list[first_mdat].at;
    copy_range(&mut src, &mut out, 0, split)?;
    out.write_all(&index)?;
    copy_range(&mut src, &mut out, split, m.at - split)?;
    copy_range(&mut src, &mut out, m.at + m.len, total - m.at - m.len)?;
    out.into_inner().map_err(|e| e.into_error())?.sync_all()?;
    Ok(true)
}

fn copy_range(src: &mut File, out: &mut impl Write, at: u64, len: u64) -> io::Result<()> {
    src.seek(SeekFrom::Start(at))?;
    let copied = io::copy(&mut src.take(len), out)?;
    if copied != len {
        return Err(bad("file shorter than its boxes"));
    }
    Ok(())
}

/// Turns a finished `part` into `path`: index first when it can be moved
/// (a clip it cannot move is still whole, just slower to start), then a rename.
/// Fails with a reason the server shows: "disk_full" or "write_failed".
pub fn settle(part: &Path, path: &Path) -> Result<(), (&'static str, String)> {
    let fast = part.with_extension("fast.part");
    let done = match rewrite(part, &fast) {
        Ok(true) => {
            let _ = std::fs::remove_file(part);
            fast
        }
        Ok(false) => part.to_path_buf(),
        Err(e) => {
            let _ = std::fs::remove_file(&fast);
            // ERROR_HANDLE_DISK_FULL, ERROR_DISK_FULL
            if matches!(e.raw_os_error(), Some(0x27 | 0x70)) {
                let _ = std::fs::remove_file(part);
                return Err(("disk_full", e.to_string()));
            }
            part.to_path_buf()
        }
    };
    std::fs::rename(&done, path).map_err(|e| {
        let _ = std::fs::remove_file(&done);
        ("write_failed", e.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn atom(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut v = ((body.len() + 8) as u32).to_be_bytes().to_vec();
        v.extend_from_slice(kind);
        v.extend_from_slice(body);
        v
    }

    /// moov > trak > mdia > minf > stbl > stco with the given offsets.
    fn moov(offsets: &[u32]) -> Vec<u8> {
        let mut stco = vec![0, 0, 0, 0];
        stco.extend_from_slice(&(offsets.len() as u32).to_be_bytes());
        for o in offsets {
            stco.extend_from_slice(&o.to_be_bytes());
        }
        let mut inner = atom(b"stco", &stco);
        for kind in [b"stbl", b"minf", b"mdia", b"trak"] {
            inner = atom(kind, &inner);
        }
        let mut body = atom(b"mvhd", &[7; 12]);
        body.extend(inner);
        atom(b"moov", &body)
    }

    fn file(name: &str, parts: &[Vec<u8>]) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("xc-faststart-{name}-{}", std::process::id()));
        std::fs::write(&p, parts.concat()).unwrap();
        p
    }

    #[test]
    fn the_index_moves_first_and_offsets_still_point_at_the_media() {
        let ftyp = atom(b"ftyp", b"isom0000");
        let mdat = atom(b"mdat", b"AAAABBBB");
        // The two chunks start at the A's and the B's.
        let a = (ftyp.len() + 8) as u32;
        let index = moov(&[a, a + 4]);
        let from = file("in", &[ftyp.clone(), mdat.clone(), index.clone()]);
        let to = from.with_extension("out");
        assert!(rewrite(&from, &to).unwrap());
        let out = std::fs::read(&to).unwrap();
        assert_eq!(out.len(), ftyp.len() + mdat.len() + index.len());
        let mut f = File::open(&to).unwrap();
        let kinds: Vec<_> = atoms(&mut f, out.len() as u64)
            .unwrap()
            .iter()
            .map(|a| a.kind)
            .collect();
        assert_eq!(kinds, vec![*b"ftyp", *b"moov", *b"mdat"]);
        // The moved table points at the same bytes.
        let table = out.len() - mdat.len() - 8;
        let first = u32::from_be_bytes(out[table..table + 4].try_into().unwrap()) as usize;
        let second = u32::from_be_bytes(out[table + 4..table + 8].try_into().unwrap()) as usize;
        assert_eq!(&out[first..first + 4], b"AAAA");
        assert_eq!(&out[second..second + 4], b"BBBB");
        let _ = std::fs::remove_file(from);
        let _ = std::fs::remove_file(to);
    }

    #[test]
    fn an_index_already_first_is_left_alone() {
        let from = file(
            "first",
            &[atom(b"ftyp", b"isom"), moov(&[40]), atom(b"mdat", b"x")],
        );
        let to = from.with_extension("out");
        assert!(!rewrite(&from, &to).unwrap());
        assert!(!to.exists());
        let _ = std::fs::remove_file(from);
    }

    #[test]
    fn a_broken_file_is_an_error_not_a_bad_clip() {
        let mut cut = atom(b"mdat", b"AAAA");
        cut[3] = 200; // claims 200 bytes
        let from = file("broken", &[atom(b"ftyp", b"isom"), cut]);
        let to = from.with_extension("out");
        assert!(rewrite(&from, &to).is_err());
        let _ = std::fs::remove_file(from);
        let _ = std::fs::remove_file(to);
    }

    #[test]
    fn wide_offsets_are_shifted_too() {
        let mut co64 = vec![0, 0, 0, 0, 0, 0, 0, 1];
        co64.extend_from_slice(&10u64.to_be_bytes());
        let mut data = atom(b"stbl", &atom(b"co64", &co64));
        shift_offsets(&mut data, 5).unwrap();
        let n = data.len();
        assert_eq!(u64::from_be_bytes(data[n - 8..].try_into().unwrap()), 15);
    }

    #[test]
    fn a_32_bit_offset_that_would_overflow_is_refused() {
        let mut stco = vec![0, 0, 0, 0, 0, 0, 0, 1];
        stco.extend_from_slice(&u32::MAX.to_be_bytes());
        let mut data = atom(b"stco", &stco);
        assert!(shift_offsets(&mut data, 1).is_err());
    }
}

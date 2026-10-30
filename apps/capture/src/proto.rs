//! The stdio protocol: one JSON object per line each way.
//!   in : {"id":N,"cmd":"monitors"|"screenshot"|"record_start"|"record_stop"|
//!         "replay_start"|"replay_save"|"replay_keep"|"replay_stop"|"pick_folder"|"thumb"|
//!         "trim"|"copy_files"|"ocr"|"inspect"|"ping", ...}
//!   out: {"id":N,"ok":true, ...result} or {"id":N,"ok":false,"error":"code","detail":"..."}
//!   and, unasked, {"event":"record_ended","reason":"window_closed"|..., ...} when a
//!   recording ends by itself; "replay_saved" and "replay_ended" for Instant Replay.
//! `detail` is for the server log; `error` is the stable code the server maps.

use serde_json::{json, Map, Value};

/// Writes an event line to the server; called from the recording thread.
pub type Notify = std::sync::Arc<dyn Fn(Value) + Send + Sync>;

#[derive(Debug)]
pub struct Fail {
    pub code: &'static str,
    pub detail: String,
}

impl Fail {
    pub fn code(code: &'static str) -> Fail {
        Fail {
            code,
            detail: String::new(),
        }
    }
    pub fn new(code: &'static str, e: impl std::fmt::Display) -> Fail {
        Fail {
            code,
            detail: e.to_string(),
        }
    }
}

/// Parses one request line: (id, cmd, body). A line that is not an object with
/// a numeric id cannot be answered and is skipped.
pub fn parse(line: &str) -> Option<(u64, String, Value)> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    let id = v.get("id")?.as_u64()?;
    let cmd = v
        .get("cmd")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    Some((id, cmd, v))
}

pub fn reply(id: u64, result: Result<Value, Fail>) -> String {
    let v = match result {
        Ok(Value::Object(mut m)) => {
            m.insert("id".into(), json!(id));
            m.insert("ok".into(), json!(true));
            Value::Object(m)
        }
        Ok(other) => {
            let mut m = Map::new();
            m.insert("id".into(), json!(id));
            m.insert("ok".into(), json!(true));
            m.insert("value".into(), other);
            Value::Object(m)
        }
        Err(f) => json!({ "id": id, "ok": false, "error": f.code, "detail": f.detail }),
    };
    v.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_requests_and_skips_junk() {
        let (id, cmd, _) = parse(r#"{"id":7,"cmd":"ping"}"#).unwrap();
        assert_eq!((id, cmd.as_str()), (7, "ping"));
        assert!(parse("nope").is_none());
        assert!(parse(r#"{"cmd":"ping"}"#).is_none());
        assert!(parse(r#"{"id":"7"}"#).is_none());
        assert_eq!(parse(r#"{"id":1}"#).unwrap().1, "");
    }

    #[test]
    fn replies_carry_the_id() {
        let ok: Value = serde_json::from_str(&reply(3, Ok(json!({ "width": 10 })))).unwrap();
        assert_eq!(ok, json!({ "id": 3, "ok": true, "width": 10 }));
        let err: Value =
            serde_json::from_str(&reply(4, Err(Fail::new("write_failed", "disk full")))).unwrap();
        assert_eq!(
            err,
            json!({ "id": 4, "ok": false, "error": "write_failed", "detail": "disk full" })
        );
        let plain: Value = serde_json::from_str(&reply(5, Ok(json!("pong")))).unwrap();
        assert_eq!(plain["value"], "pong");
    }
}

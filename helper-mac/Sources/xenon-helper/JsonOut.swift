import Foundation

// ─────────────────────────────────────────────────────────────────────────────
// A tiny hand-rolled JSON writer, for the same reason JsonOut.cs is hand-rolled
// on Windows: every value this helper emits is a string, a number or a bool
// from a known shape, and the consumer is one JSON.parse in Node. Codable would
// mean a type per message and no less care about escaping.
//
// Escaping is the part that matters. A window title or a notification body is
// arbitrary user text — quotes, backslashes, newlines and control characters
// all appear in real ones — and a single unescaped byte turns the line into
// something JSON.parse throws on, which the readers drop silently.
// ─────────────────────────────────────────────────────────────────────────────
enum J {
    case s(String)
    case n(Double)
    case i(Int)
    case b(Bool)
    case null
    case arr([J])
    case obj([(String, J)])

    var text: String {
        switch self {
        case .s(let v): return J.quote(v)
        case .n(let v):
            // Infinity and NaN are not JSON. Emitting null is the honest answer
            // and the readers already treat a missing number as "no reading".
            guard v.isFinite else { return "null" }
            return v == v.rounded() && abs(v) < 1e15 ? String(Int64(v)) : String(v)
        case .i(let v): return String(v)
        case .b(let v): return v ? "true" : "false"
        case .null: return "null"
        case .arr(let items): return "[" + items.map { $0.text }.joined(separator: ",") + "]"
        case .obj(let pairs):
            return "{" + pairs.map { J.quote($0.0) + ":" + $0.1.text }.joined(separator: ",") + "}"
        }
    }

    static func quote(_ raw: String) -> String {
        var out = "\""
        out.reserveCapacity(raw.count + 8)
        for scalar in raw.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                // Everything below 0x20 must be escaped or the JSON is invalid;
                // a raw 0x07 in a window title is enough to break a whole line.
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        return out + "\""
    }
}

// One message per line, flushed immediately: the readers on the other side are
// line-oriented and a buffered line is a push that never arrives.
func emit(_ value: J) {
    let line = value.text + "\n"
    FileHandle.standardOutput.write(Data(line.utf8))
}

func emitError(_ code: String) {
    emit(.obj([("event", .s("error")), ("error", .s(code))]))
}

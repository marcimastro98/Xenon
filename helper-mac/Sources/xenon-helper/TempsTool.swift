import Foundation
import IOKit

// ─────────────────────────────────────────────────────────────────────────────
// `temps` — CPU/GPU temperature and GPU load, without sudo and without macmon.
//
// This is the one gap the macOS port shipped with: Apple Silicon keeps both
// behind interfaces `system_profiler` does not expose, so darwin-collectors.js
// reads them from `macmon` when the user happens to have installed it and
// reports "--" otherwise. `powermetrics` is the usual answer and it needs root,
// which a login-session helper must never ask for.
//
// Output contract, one JSON line, read by darwin-collectors.js:
//   {"cpuTemp":45.2,"gpuTemp":41.0,"gpu":23,"vramUsed":1234567890}
// `gpu` is a PERCENT 0..100 (integer) because that is what the collector seam
// hands to server.js on every platform; the temperatures are °C with one
// decimal, which is what the widget renders. Any value we cannot read is null,
// never 0 — a GPU genuinely idling at 0% and a sensor we could not open must
// not look the same.
//
// ONE-SHOT on purpose. The sibling hosts (media-serve, index-serve) stay
// resident because they push events; this answers a poll, and darwin-collectors
// already owns a TTL cache with in-flight dedup for exactly this shape of
// reading (it was built for macmon). Re-using that cache costs one short-lived
// process every few seconds instead of a resident one, and it inherits the
// staleness and backoff behaviour that is already tested.
//
// Two independent sources, so one failing does not take the other with it:
//
//   * GPU load and memory come from IOKit's PUBLIC registry: the accelerator
//     service publishes PerformanceStatistics, no entitlement, no permission
//     prompt, documented types.
//   * Temperatures come from the HID sensor services, which are NOT declared in
//     any public header. They are reached through dlsym rather than by linking,
//     so a macOS release that stops exporting them costs the temperatures and
//     nothing else: the process still starts, still answers, and the fields go
//     null exactly as they do today without macmon. Linking them directly would
//     turn the same change into a helper that will not launch at all, taking
//     the app switcher and the game probe down with it.
// ─────────────────────────────────────────────────────────────────────────────
enum TempsTool {
    static func run() {
        let temps = HidSensors.read()
        let accel = Accelerator.read()
        emit(.obj([
            ("cpuTemp", celsius(temps.cpu)),
            ("gpuTemp", celsius(temps.gpu)),
            ("gpu", accel.utilization.map { J.i($0) } ?? .null),
            ("vramUsed", accel.usedBytes.map { J.i($0) } ?? .null),
        ]))
    }

    private static func celsius(_ value: Double?) -> J {
        guard let v = value, v.isFinite else { return .null }
        return .n((v * 10).rounded() / 10)
    }
}

// ── GPU load and memory: public IOKit ────────────────────────────────────────
private enum Accelerator {
    static func read() -> (utilization: Int?, usedBytes: Int?) {
        guard let matching = IOServiceMatching("IOAccelerator") else { return (nil, nil) }
        var iterator: io_iterator_t = 0
        // kIOMasterPortDefault, not kIOMainPortDefault: the latter is macOS 12+
        // and this package deploys to macOS 11. The old name is deprecated,
        // not removed.
        guard IOServiceGetMatchingServices(kIOMasterPortDefault, matching, &iterator) == KERN_SUCCESS else {
            return (nil, nil)
        }
        defer { IOObjectRelease(iterator) }

        var utilization: Int?
        var usedBytes: Int?
        var service = IOIteratorNext(iterator)
        while service != 0 {
            defer {
                IOObjectRelease(service)
                service = IOIteratorNext(iterator)
            }
            var propsRef: Unmanaged<CFMutableDictionary>?
            guard IORegistryEntryCreateCFProperties(service, &propsRef, kCFAllocatorDefault, 0) == KERN_SUCCESS,
                  let props = propsRef?.takeRetainedValue() as? [String: Any],
                  let perf = props["PerformanceStatistics"] as? [String: Any]
            else { continue }

            // "Device Utilization %" is what Apple Silicon and AMD publish;
            // older Intel drivers used "GPU Activity(%)". Whichever is there.
            if let raw = int(perf["Device Utilization %"]) ?? int(perf["GPU Activity(%)"]) {
                let clamped = min(100, max(0, raw))
                utilization = max(utilization ?? clamped, clamped)
            }
            // Unified memory on Apple Silicon: this is what the GPU currently
            // holds, which is the honest answer to "VRAM in use". The total
            // still comes from system_profiler in darwin-collectors.js.
            if let raw = int(perf["In use system memory"]) ?? int(perf["Alloc system memory"]), raw >= 0 {
                usedBytes = max(usedBytes ?? raw, raw)
            }
        }
        // A machine with two GPUs (an Intel Mac with a discrete card) reports
        // both; the busier one is the one the user is watching.
        return (utilization, usedBytes)
    }

    private static func int(_ value: Any?) -> Int? {
        if let n = value as? Int { return n }
        if let n = value as? NSNumber { return n.intValue }
        return nil
    }
}

// ── Temperatures: the HID sensor services, reached by dlsym ──────────────────
private enum HidSensors {
    // Apple's sensor naming on Apple Silicon. The performance and efficiency
    // core clusters each carry several dies; "SOC" is the fallback for machines
    // that do not expose per-cluster sensors. Averaged rather than maxed: the
    // widget shows one CPU number and a single hot die is not the chip's
    // temperature.
    private static let cpuMarkers = ["pACC MTR Temp Sensor", "eACC MTR Temp Sensor"]
    private static let cpuFallbackMarkers = ["SOC MTR Temp Sensor"]
    private static let gpuMarkers = ["GPU MTR Temp Sensor"]

    // The "MTR" names above are M1 vocabulary, and they are not merely renamed
    // on later chips — they are absent. An M2 (macOS 26.5, measured) publishes
    // 39 temperature sensors and not one of them matches any marker above, so
    // every tier missed and the helper reported null on the exact hardware it
    // was written to serve. What it does publish is `PMU tdie1..8` and
    // `PMU2 tdie1..8` (the SoC die probes) alongside `PMU tdev*` (board, ~8 °C
    // cooler), `PMU tcal` (a calibration reference), `NAND CH0 temp` (the SSD)
    // and `gas gauge battery`. Only the die probes are the chip: this last tier
    // matches those and deliberately nothing else, because a battery or SSD
    // reading presented as the CPU temperature is worse than no reading at all.
    private static func isDieSensor(_ name: String) -> Bool {
        // `hasPrefix("PMU")` covers PMU and PMU2 without admitting a future
        // unrelated sensor that merely contains "tdie" somewhere in its name.
        name.hasPrefix("PMU") && name.contains("tdie")
    }

    // kIOHIDEventTypeTemperature. The value field is the type shifted into the
    // field's high half, which is how every IOHIDEvent field id is built.
    private static let eventTypeTemperature: Int64 = 15
    private static let fieldTemperature: Int32 = 15 << 16

    static func read() -> (cpu: Double?, gpu: Double?) {
        guard let fns = Fns.shared else { return (nil, nil) }
        guard let client = fns.create(nil) else { return (nil, nil) }

        // Usage page 0xff00 / usage 0x0005 is the temperature sensor family.
        let matching: [String: Int] = ["PrimaryUsagePage": 0xff00, "PrimaryUsage": 0x0005]
        _ = fns.setMatching(client, matching as CFDictionary)

        guard let servicesRef = fns.copyServices(client) else { return (nil, nil) }
        let services = servicesRef.takeRetainedValue()

        var cpu: [Double] = [], cpuFallback: [Double] = [], gpu: [Double] = [], die: [Double] = []
        for index in 0..<CFArrayGetCount(services) {
            guard let raw = CFArrayGetValueAtIndex(services, index) else { continue }
            let service = UnsafeMutableRawPointer(mutating: raw)

            guard let nameRef = fns.copyProperty(service, "Product" as CFString),
                  let name = nameRef.takeRetainedValue() as? String
            else { continue }

            guard let eventRef = fns.copyEvent(service, eventTypeTemperature, 0, 0) else { continue }
            let event = eventRef.takeRetainedValue()
            let value = fns.floatValue(Unmanaged.passUnretained(event).toOpaque(), fieldTemperature)
            // A sensor that is present but not reporting answers 0, and some
            // answer nonsense while the machine wakes. Neither is a reading.
            guard value.isFinite, value > 1, value < 150 else { continue }

            if cpuMarkers.contains(where: { name.contains($0) }) { cpu.append(value) }
            else if cpuFallbackMarkers.contains(where: { name.contains($0) }) { cpuFallback.append(value) }
            else if gpuMarkers.contains(where: { name.contains($0) }) { gpu.append(value) }
            else if isDieSensor(name) { die.append(value) }
        }

        // Most specific tier that produced anything wins. The GPU has no such
        // fallback on purpose: where the per-cluster sensors are absent there is
        // no separate GPU probe either, and the die average is the whole SoC —
        // reporting it as the GPU temperature would be inventing a measurement.
        // It stays null, which is what the widget already renders as "--".
        let cpuTier = !cpu.isEmpty ? cpu : (!cpuFallback.isEmpty ? cpuFallback : die)
        return (average(cpuTier), average(gpu))
    }

    private static func average(_ values: [Double]) -> Double? {
        guard !values.isEmpty else { return nil }
        return values.reduce(0, +) / Double(values.count)
    }

    // The private entry points, resolved once. Every one of them must be
    // present or the whole set is refused: a half-resolved sensor API would
    // read some values and silently drop others, which is worse than reporting
    // no temperature at all.
    private struct Fns {
        typealias Create = @convention(c) (UnsafeRawPointer?) -> UnsafeMutableRawPointer?
        typealias SetMatching = @convention(c) (UnsafeMutableRawPointer?, CFDictionary?) -> Int32
        typealias CopyServices = @convention(c) (UnsafeMutableRawPointer?) -> Unmanaged<CFArray>?
        typealias CopyProperty = @convention(c) (UnsafeMutableRawPointer?, CFString?) -> Unmanaged<CFTypeRef>?
        typealias CopyEvent = @convention(c) (UnsafeMutableRawPointer?, Int64, Int32, Int64) -> Unmanaged<CFTypeRef>?
        typealias FloatValue = @convention(c) (UnsafeRawPointer?, Int32) -> Double

        let create: Create
        let setMatching: SetMatching
        let copyServices: CopyServices
        let copyProperty: CopyProperty
        let copyEvent: CopyEvent
        let floatValue: FloatValue

        static let shared: Fns? = {
            guard let create = symbol("IOHIDEventSystemClientCreate"),
                  let setMatching = symbol("IOHIDEventSystemClientSetMatching"),
                  let copyServices = symbol("IOHIDEventSystemClientCopyServices"),
                  let copyProperty = symbol("IOHIDServiceClientCopyProperty"),
                  let copyEvent = symbol("IOHIDServiceClientCopyEvent"),
                  let floatValue = symbol("IOHIDEventGetFloatValue")
            else { return nil }
            return Fns(
                create: unsafeBitCast(create, to: Create.self),
                setMatching: unsafeBitCast(setMatching, to: SetMatching.self),
                copyServices: unsafeBitCast(copyServices, to: CopyServices.self),
                copyProperty: unsafeBitCast(copyProperty, to: CopyProperty.self),
                copyEvent: unsafeBitCast(copyEvent, to: CopyEvent.self),
                floatValue: unsafeBitCast(floatValue, to: FloatValue.self)
            )
        }()

        private static func symbol(_ name: String) -> UnsafeMutableRawPointer? {
            // RTLD_DEFAULT: IOKit is already linked into this process, so the
            // symbols it exports are visible without opening anything. The
            // explicit dlopen is the fallback for a future layout where it is
            // not.
            if let found = dlsym(UnsafeMutableRawPointer(bitPattern: -2), name) { return found }
            guard let handle = dlopen("/System/Library/Frameworks/IOKit.framework/IOKit", RTLD_LAZY) else { return nil }
            return dlsym(handle, name)
        }
    }
}

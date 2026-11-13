// How often the list of running programs is read for the widgets that asked for it, how much
// slower during a game, and how many it lists.

// ── Per-process CPU / RAM / GPU — the `processes` SDK stream ─────────────────
// Karim's ask on Discord was a mini task manager in place of the Latency panel.
// It ships as a stream a Store widget can be granted rather than as a rewrite of
// a built-in panel: one user finding Latency useless is not a reason to remove it
// from everyone's dashboard, and this way the layout is the user's choice.
//
// The cost model, which is the whole reason this looks the way it does:
//   * NOTHING runs unless some installed package has actually been granted the
//     stream AND a dashboard is open. No grant, no widget, no cost — not a
//     reduced cost, zero. sdkGrantsFor() fails closed under safe mode and
//     per-package suspend, so both of those turn it off for free.
//   * When it does run it is ~55ms per tick on Windows (measured, 390
//     processes), because processes.ps1 lives on the persistent worker and reads
//     raw performance-counter deltas instead of sampling. See its header for the
//     Get-Counter comparison — the naive version costs 2800ms.
//   * A tick that overruns is SKIPPED, never queued. The worker answers serially,
//     so queuing would push the sensor collectors behind a backlog of stale
//     process snapshots — the failure would show up as the CPU tile going
//     sluggish, with nothing pointing here.
const PROCESSES_POLL_MS = 2000;
// The dearest read in the worker: through a game the list follows three times slower.
const PROCESSES_POLL_GAME_MS = 6000;
const PROCESSES_TOP = 8;          // per metric; the collector sends the union of the three

module.exports = { PROCESSES_POLL_MS, PROCESSES_POLL_GAME_MS, PROCESSES_TOP };

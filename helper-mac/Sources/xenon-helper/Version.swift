// Bump on any protocol or capability change, the way helper/XenonHelper.csproj
// <Version> is bumped, or an existing install keeps a binary whose answers the
// server no longer expects.
//
//   0.1.0 = windows (app switcher), foreground-serve (game probe),
//           hotkey-serve (global Spotlight hotkey), shell-delete (Trash).
//   0.2.0 = index-serve (the Living Index: one in-memory index fed by FSEvents,
//           serving search and the read-only disk map).
//   0.3.0 = temps (CPU/GPU temperature and GPU load, no sudo and no macmon).
//   0.3.1 = temps reads the die sensors M2 and later actually publish; the M1
//           "MTR" names it shipped with match nothing on those machines.
//   0.3.2 = index-serve's `query` answers with the short keys the protocol uses
//           (p/n/s/m). It spelled them out in full, so every search hit was
//           discarded by the server and the Spotlight popup found nothing.
//   0.3.3 = the index walker no longer skips hidden entries. On POSIX that hid
//           the Trash and every dot-prefixed cache, i.e. most of what the disk
//           widget is for.
//   0.4.0 = lock (immediate screen lock). The CGSession binary server.js called
//           no longer exists on macOS 26, so the Deck's lock key did nothing.
//   0.5.0 = keys (send a key combination to the frontmost app, the macOS half of
//           sendHotkey). `keys --check` is the capability probe and posts
//           nothing, so the server can ask whether Accessibility is granted
//           without typing into whatever the user has open.
//   0.5.1 = index-serve's `stats` reports WHICH roots the entry cap left
//           incomplete (`cappedRoots`), so Settings can name the folder search
//           cannot see instead of only saying a limit was reached. Matches
//           helper/XenonHelper.csproj 0.12.2.
let helperVersion = "0.5.1"

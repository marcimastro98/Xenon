// Bump on any protocol or capability change, the way helper/XenonHelper.csproj
// <Version> is bumped, or an existing install keeps a binary whose answers the
// server no longer expects.
//
//   0.1.0 = windows (app switcher), foreground-serve (game probe),
//           hotkey-serve (global Spotlight hotkey), shell-delete (Trash).
//   0.2.0 = index-serve (the Living Index: one in-memory index fed by FSEvents,
//           serving search and the read-only disk map).
let helperVersion = "0.2.0"

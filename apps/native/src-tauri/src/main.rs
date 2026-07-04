// Prevent a console window from flashing up alongside the app on Windows release
// builds. Debug builds keep the console so `tauri dev` logs are visible.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    xenon_native_lib::run();
}

// Desktop-dev convenience shim (`tauri dev` on the Mac); the mobile entry
// point is `run()` in lib.rs.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    pings_go_lib::run()
}

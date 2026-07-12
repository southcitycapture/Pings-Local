//! Pings Go! native shell. All product logic lives in the webview (`ui/`,
//! adapted from dispatch/src/go.html); the Rust side only registers the
//! plugins the web version can't have — durable storage and real haptics.
//! Push registration arrives in its own plugin (tauri-plugin-go-push).

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_haptics::init())
        .run(tauri::generate_context!())
        .expect("error while running pings-go");
}

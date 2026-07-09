//! The command palette: a global-shortcut-summoned window to ping anyone
//! without opening the app. Created lazily on first summon, then shown/hidden.

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const PALETTE_LABEL: &str = "palette";

/// Show the palette if hidden, hide it if already showing (the shortcut toggles).
pub fn toggle(app: &AppHandle) {
    match app.get_webview_window(PALETTE_LABEL) {
        Some(window) => {
            if window.is_visible().unwrap_or(false) {
                let _ = window.hide();
            } else {
                reveal(&window);
            }
        }
        None => {
            if let Ok(window) = build(app) {
                reveal(&window);
            }
        }
    }
}

pub fn hide(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(PALETTE_LABEL) {
        let _ = window.hide();
    }
}

fn build(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    WebviewWindowBuilder::new(app, PALETTE_LABEL, WebviewUrl::App("palette.html".into()))
        .title("Ping")
        .inner_size(560.0, 380.0)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .resizable(false)
        .skip_taskbar(true)
        .visible(false)
        .center()
        .build()
}

fn reveal(window: &WebviewWindow) {
    let _ = window.center();
    let _ = window.show();
    let _ = window.set_focus();
    // Tell the UI to reset its query, reload peers, and focus the input.
    let _ = window.emit("palette-shown", ());
}

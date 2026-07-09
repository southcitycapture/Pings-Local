//! Quick-reply toast. On an incoming ping, a small interactive card appears
//! top-right with the sender, their message, and one-tap quick replies that
//! send a private chat back — separate from the click-through border flash so
//! its buttons are actually clickable.
//!
//! Everything that touches the window runs on the main thread: macOS ignores
//! window show/activation from a background thread (that was the source of the
//! "click twice" bug), and the ping arrives on a networking thread.

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const TOAST_LABEL: &str = "ping-toast";

const TOAST_W: f64 = 340.0;
const TOAST_H: f64 = 168.0;

pub fn show_ping_toast(
    app: &AppHandle,
    from: &str,
    from_ip: &str,
    from_peer_id: &str,
    message: &str,
    timestamp: u64,
) {
    let app = app.clone();
    let app_inner = app.clone();
    let payload = json!({
        "from": from,
        "fromIp": from_ip,
        "fromPeerId": from_peer_id,
        "message": message,
        "timestamp": timestamp,
    });

    let _ = app.run_on_main_thread(move || {
        let window = match app_inner.get_webview_window(TOAST_LABEL) {
            Some(window) => window,
            None => match build(&app_inner) {
                Ok(window) => window,
                Err(_) => return,
            },
        };
        position_top_right(&app_inner, &window);
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.emit("toast-ping", payload);
    });
}

pub fn hide(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(TOAST_LABEL) {
        let _ = window.hide();
    }
}

fn build(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    WebviewWindowBuilder::new(app, TOAST_LABEL, WebviewUrl::App("toast.html".into()))
        .title("Ping")
        .inner_size(TOAST_W, TOAST_H)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .resizable(false)
        .skip_taskbar(true)
        .visible(false)
        .build()
}

fn position_top_right(app: &AppHandle, window: &WebviewWindow) {
    let Ok(Some(monitor)) = app.primary_monitor() else {
        return;
    };
    let pos = monitor.position();
    let size = monitor.size();
    let scale = monitor.scale_factor();
    let toast_w = (TOAST_W * scale) as i32;
    let margin = (16.0 * scale) as i32;
    let top_gap = (12.0 * scale) as i32; // clear the menu bar area
    let x = pos.x + size.width as i32 - toast_w - margin;
    let y = pos.y + margin + top_gap;
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

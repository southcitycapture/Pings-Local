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

#[cfg(target_os = "macos")]
use objc2_app_kit::NSWindowStyleMask;
#[cfg(target_os = "macos")]
use tauri_nspanel::{tauri_panel, ManagerExt, WebviewWindowExt};

pub const TOAST_LABEL: &str = "ping-toast";

// A non-activating panel: it can become key (so its chips receive the first
// click and Esc works) but never activates our app or steals focus from
// whatever the user is doing.
#[cfg(target_os = "macos")]
tauri_panel! {
    panel!(ToastPanel {
        config: {
            can_become_key_window: true,
            can_become_main_window: false
        }
    })
}

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
        // First call builds + positions the window and (on macOS) converts it to
        // a non-activating panel; get_webview_window still returns it afterward.
        let fresh = !toast_exists(&app_inner);
        if fresh && build(&app_inner).is_err() {
            return;
        }
        if fresh {
            // The webview hasn't registered its "toast-ping" listener yet, so an
            // immediate emit is lost. Emit + show once it has loaded, so the
            // first toast of the session shows already-populated (not blank).
            let app_retry = app_inner.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(600));
                let app_main = app_retry.clone();
                let _ = app_retry.run_on_main_thread(move || {
                    if let Some(window) = app_main.get_webview_window(TOAST_LABEL) {
                        let _ = window.emit("toast-ping", payload);
                    }
                    show_toast_window(&app_main);
                });
            });
        } else {
            if let Some(window) = app_inner.get_webview_window(TOAST_LABEL) {
                let _ = window.emit("toast-ping", payload);
            }
            show_toast_window(&app_inner);
        }
    });
}

#[cfg(target_os = "macos")]
fn toast_exists(app: &AppHandle) -> bool {
    app.get_webview_panel(TOAST_LABEL).is_ok()
}

#[cfg(not(target_os = "macos"))]
fn toast_exists(app: &AppHandle) -> bool {
    app.get_webview_window(TOAST_LABEL).is_some()
}

/// Show the toast without activating our app. On macOS the window is a
/// non-activating panel, so it appears above other apps while keeping focus on
/// whatever the user is working in; its chips still take the first click (via
/// `accept_first_mouse`). Elsewhere it's an ordinary always-on-top window.
#[cfg(target_os = "macos")]
fn show_toast_window(app: &AppHandle) {
    if let Ok(panel) = app.get_webview_panel(TOAST_LABEL) {
        // show() orders it front and makes it visible without activating our
        // app; order_front_regardless alone left it ordered-in but not shown.
        panel.show();
    }
}

#[cfg(not(target_os = "macos"))]
fn show_toast_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(TOAST_LABEL) {
        let _ = window.show();
    }
}

pub fn hide(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    if let Ok(panel) = app.get_webview_panel(TOAST_LABEL) {
        panel.hide();
        return;
    }
    if let Some(window) = app.get_webview_window(TOAST_LABEL) {
        let _ = window.hide();
    }
}

fn build(app: &AppHandle) -> tauri::Result<()> {
    let window = WebviewWindowBuilder::new(app, TOAST_LABEL, WebviewUrl::App("toast.html".into()))
        .title("Ping")
        .inner_size(TOAST_W, TOAST_H)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .resizable(false)
        .skip_taskbar(true)
        .visible(false)
        // Deliver the first click to a chip even though the toast isn't the key
        // window — with the non-activating panel this yields one-click replies
        // with no focus theft.
        .accept_first_mouse(true)
        .build()?;
    // Position while we still hold the WebviewWindow (top-right is fixed, so
    // positioning once at build time is enough).
    position_top_right(app, &window);
    make_nonactivating(&window)?;
    Ok(())
}

/// Convert the toast window into a real non-activating `NSPanel`. Only a panel
/// with the `NonactivatingPanel` style honors control clicks without activating
/// the app first — that's what gives one-click quick replies with no focus
/// theft (a plain NSWindow needed two clicks: one to focus, one to act).
#[cfg(target_os = "macos")]
fn make_nonactivating(window: &WebviewWindow) -> tauri::Result<()> {
    let panel = window.to_panel::<ToastPanel>()?;
    panel.set_style_mask(NSWindowStyleMask::Borderless | NSWindowStyleMask::NonactivatingPanel);
    // Only take key status when a control actually needs it, and stay put when
    // our app deactivates (the panel lives above whatever app the user is in).
    panel.set_becomes_key_only_if_needed(true);
    panel.set_floating_panel(true);
    panel.set_hides_on_deactivate(false);
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn make_nonactivating(_window: &WebviewWindow) -> tauri::Result<()> {
    Ok(())
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

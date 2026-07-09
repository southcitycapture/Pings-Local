#[cfg(target_os = "macos")]
use objc2::msg_send;
#[cfg(target_os = "macos")]
use objc2::runtime::AnyObject;
#[cfg(target_os = "macos")]
use objc2_app_kit::{NSColor, NSWindow};
#[cfg(target_os = "macos")]
use objc2_foundation::{ns_string, NSNumber};
#[cfg(target_os = "macos")]
use objc2_web_kit::WKWebView;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{
    window::Color, AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl,
    WebviewWindowBuilder,
};

const OVERLAY_LABEL: &str = "ping-overlay";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OverlayPingPayload {
    from: String,
    from_ip: String,
    message: String,
    sound: String,
    shape: String,
    timestamp: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectChatContextPayload {
    pub peer_ip: String,
    pub peer_name: String,
}

static DIRECT_CHAT_CONTEXTS: LazyLock<Mutex<HashMap<String, DirectChatContextPayload>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn ensure_overlay_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = window.hide();
        let _ = window.set_background_color(Some(Color(0, 0, 0, 0)));
        let _ = window.set_focusable(false);
        let _ = window.set_ignore_cursor_events(true);
        let _ = window.set_always_on_top(true);
        #[cfg(target_os = "macos")]
        {
            let _ = window.set_visible_on_all_workspaces(true);
            let _ = window.set_shadow(false);
            let _ = window.with_webview(|webview| unsafe {
                let view: &WKWebView = &*webview.inner().cast();
                let ns_window: &NSWindow = &*webview.ns_window().cast();
                ns_window.setOpaque(false);
                let clear = NSColor::clearColor();
                ns_window.setBackgroundColor(Some(&clear));
                let key = ns_string!("drawsBackground");
                let no_bg = NSNumber::numberWithBool(false);
                let _: () = msg_send![view, setValue: &*no_bg, forKey: key];
            });
        }
    }
}

pub fn show_ping_overlay(
    app: &AppHandle,
    from: &str,
    from_ip: &str,
    message: &str,
    sound: &str,
    shape: &str,
    timestamp: u64,
) {
    ensure_overlay_window(app);
    let Some(window) = app.get_webview_window(OVERLAY_LABEL) else {
        return;
    };

    if let Ok(Some(monitor)) = app.primary_monitor() {
        let position = monitor.position();
        let size = monitor.size();
        let _ = window.set_position(LogicalPosition::new(position.x as f64, position.y as f64));
        let _ = window.set_size(LogicalSize::new(size.width as f64, size.height as f64));
    }

    let payload = OverlayPingPayload {
        from: from.to_string(),
        from_ip: from_ip.to_string(),
        message: message.to_string(),
        sound: sound.to_string(),
        shape: shape.to_string(),
        timestamp,
    };

    let _ = window.show();
    let _ = window.emit("overlay-ping", payload);

    let app_handle = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(1300));
        if let Some(window) = app_handle.get_webview_window(OVERLAY_LABEL) {
            let _ = window.hide();
        }
    });
}

/// Paint a window's WKWebView backing the theme ground color so it doesn't flash
/// white before the page paints its first frame (the "window load flash").
///
/// This sets the color on the *webview's* backing layer, not the NSWindow —
/// setting the NSWindow background bled into the titlebar (the black-titlebar
/// regression). The webview is made transparent (`drawsBackground = false`) so
/// its opaque themed layer shows through until the page renders over it, then
/// the page's own `--ground` background takes over seamlessly.
#[cfg(target_os = "macos")]
pub fn paint_window_ground(window: &tauri::WebviewWindow, dark: bool) {
    let (r, g, b): (f64, f64, f64) = if dark {
        (15.0 / 255.0, 21.0 / 255.0, 20.0 / 255.0)
    } else {
        (245.0 / 255.0, 247.0 / 255.0, 246.0 / 255.0)
    };
    let _ = window.with_webview(move |webview| unsafe {
        let view: &WKWebView = &*webview.inner().cast();
        let key = ns_string!("drawsBackground");
        let no_bg = NSNumber::numberWithBool(false);
        let _: () = msg_send![view, setValue: &*no_bg, forKey: key];
        let _: () = msg_send![view, setWantsLayer: true];
        let layer: *mut AnyObject = msg_send![view, layer];
        if !layer.is_null() {
            let color = NSColor::colorWithSRGBRed_green_blue_alpha(r, g, b, 1.0);
            let cg: *mut AnyObject = msg_send![&*color, CGColor];
            let _: () = msg_send![layer, setBackgroundColor: cg];
        }
    });
}

#[cfg(not(target_os = "macos"))]
pub fn paint_window_ground(_window: &tauri::WebviewWindow, _dark: bool) {}

pub fn open_options_window(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("options") {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }

    let window = WebviewWindowBuilder::new(app, "options", WebviewUrl::App("options.html".into()))
        .title("Pings Options")
        .inner_size(460.0, 700.0)
        .resizable(true)
        .always_on_top(false)
        .build()
        .map_err(|e| format!("open-options-window:{e}"))?;

    let dark = crate::persistence::load_settings(app)
        .map(|s| s.dark_mode)
        .unwrap_or(false);
    paint_window_ground(&window, dark);

    Ok(())
}

fn sanitize_for_label(raw: &str) -> String {
    raw.chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect::<String>()
}

fn direct_chat_window_label(peer_ip: &str, peer_name: Option<&str>) -> String {
    if let Some(name) = peer_name {
        let trimmed = name.trim();
        if !trimmed.is_empty() {
            return format!("direct-chat-name-{}", sanitize_for_label(trimmed));
        }
    }
    let normalized = sanitize_for_label(peer_ip);
    format!("direct-chat-ip-{normalized}")
}

fn emit_direct_chat_context(app: &AppHandle, label: String, context: DirectChatContextPayload) {
    let app_handle = app.clone();
    std::thread::spawn(move || {
        for _ in 0..6 {
            if let Some(window) = app_handle.get_webview_window(&label) {
                let _ = window.emit("direct-chat-context", context.clone());
            }
            std::thread::sleep(Duration::from_millis(120));
        }
    });
}

fn store_direct_chat_context(label: &str, context: &DirectChatContextPayload) {
    if let Ok(mut map) = DIRECT_CHAT_CONTEXTS.lock() {
        map.insert(label.to_string(), context.clone());
    }
}

pub fn get_direct_chat_context(window_label: &str) -> Option<DirectChatContextPayload> {
    let label = window_label.trim();
    if label.is_empty() {
        return None;
    }
    let Ok(map) = DIRECT_CHAT_CONTEXTS.lock() else {
        return None;
    };
    map.get(label).cloned()
}

pub fn open_direct_chat_window(
    app: &AppHandle,
    peer_ip: &str,
    peer_name: Option<String>,
) -> Result<(), String> {
    let peer_ip = peer_ip.trim();
    if peer_ip.is_empty() {
        return Err("open-direct-chat-window:empty-ip".to_string());
    }

    let normalized_name = peer_name
        .as_deref()
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    let title = if !normalized_name.is_empty() {
        format!("Chat: {}", normalized_name)
    } else {
        format!("Chat: {peer_ip}")
    };
    let label = direct_chat_window_label(peer_ip, Some(&normalized_name));
    let context = DirectChatContextPayload {
        peer_ip: peer_ip.to_string(),
        peer_name: normalized_name,
    };
    store_direct_chat_context(&label, &context);

    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.set_title(&title);
        let _ = window.show();
        let _ = window.set_focus();
        emit_direct_chat_context(app, label, context);
        return Ok(());
    }

    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("direct-chat.html".into()))
        .title(&title)
        .inner_size(420.0, 560.0)
        .min_inner_size(320.0, 420.0)
        .resizable(true)
        .always_on_top(false)
        .build()
        .map_err(|e| format!("open-direct-chat-window:{e}"))?;

    let dark = crate::persistence::load_settings(app)
        .map(|s| s.dark_mode)
        .unwrap_or(false);
    paint_window_ground(&window, dark);

    emit_direct_chat_context(app, label, context);
    Ok(())
}

pub fn emit_private_chat_to_window(
    app: &AppHandle,
    peer_ip: &str,
    peer_name: Option<&str>,
    payload: serde_json::Value,
) {
    let label = direct_chat_window_label(peer_ip, peer_name);
    let app_handle = app.clone();
    std::thread::spawn(move || {
        for _ in 0..6 {
            if let Some(window) = app_handle.get_webview_window(&label) {
                let _ = window.emit("incoming-private-chat-window", payload.clone());
            }
            std::thread::sleep(Duration::from_millis(120));
        }
    });
}

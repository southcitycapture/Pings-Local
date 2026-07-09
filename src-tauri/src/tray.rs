//! Menubar tray: quick-ping anyone on the network without opening the window.
//!
//! The menu lists current peers (one click = ping, using your default message /
//! sound / shape), plus Open and Quit. It rebuilds when the peer list changes so
//! it always reflects who's around. A left-click on the icon opens the window.

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager,
};

use crate::networking::{self, NetworkingState};
use crate::{persistence, store};

pub const TRAY_ID: &str = "pings-tray";

const PING_PREFIX: &str = "ping:";
const MAX_PEERS_IN_MENU: usize = 12;

/// Build the tray menu from the current peer snapshot.
pub fn build_menu(app: &AppHandle, state: &NetworkingState) -> tauri::Result<Menu<tauri::Wry>> {
    let peers = networking::peers_snapshot(state);
    let menu = Menu::new(app)?;

    if peers.is_empty() {
        let empty = MenuItem::with_id(app, "none", "No one on your network yet", false, None::<&str>)?;
        menu.append(&empty)?;
    } else {
        let header = MenuItem::with_id(app, "header", "Ping…", false, None::<&str>)?;
        menu.append(&header)?;
        for peer in peers.iter().take(MAX_PEERS_IN_MENU) {
            let label = if peer.name.trim().is_empty() {
                peer.ip.clone()
            } else {
                peer.name.trim().to_string()
            };
            let item = MenuItem::with_id(
                app,
                format!("{PING_PREFIX}{}", peer.ip),
                label,
                true,
                None::<&str>,
            )?;
            menu.append(&item)?;
        }
    }

    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "show", "Open Pings", true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, "quit", "Quit Pings", true, None::<&str>)?)?;
    Ok(menu)
}

/// Create the tray icon and wire its events.
pub fn init(app: &AppHandle, state: NetworkingState) -> tauri::Result<()> {
    let menu = build_menu(app, &state)?;
    let state_for_menu = state.clone();

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Pings")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |app, event| on_menu_event(app, &state_for_menu, event));

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

fn on_menu_event(app: &AppHandle, state: &NetworkingState, event: tauri::menu::MenuEvent) {
    let id = event.id().0.as_str();
    match id {
        "show" => show_main(app),
        "quit" => app.exit(0),
        other if other.starts_with(PING_PREFIX) => {
            tray_ping(app, state, other[PING_PREFIX.len()..].to_string());
        }
        _ => {}
    }
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Ping a peer straight from the tray, using the saved default message/sound/shape,
/// and record it to history exactly like a ping from the window.
fn tray_ping(app: &AppHandle, state: &NetworkingState, ip: String) {
    let settings = persistence::load_settings(app).unwrap_or_default();
    let sound = if settings.sound == "light" {
        "chime".to_string()
    } else {
        settings.sound.clone()
    };

    let target = networking::peer_by_ip(state, &ip);
    let target_ip = ip.clone();
    if let Ok(payload) = networking::send_ping(
        state,
        ip,
        settings.custom_message.clone(),
        sound,
        settings.ping_shape.clone(),
    ) {
        let peer_id = target.as_ref().map(|p| p.peer_id.clone()).unwrap_or_default();
        let peer_name = target
            .as_ref()
            .map(|p| p.name.clone())
            .unwrap_or_else(|| target_ip.clone());
        let _ = store::record(
            app,
            &store::HistoryEvent::new(
                "ping",
                "out",
                peer_id,
                target_ip,
                peer_name,
                payload.message.clone(),
                payload.timestamp,
            ),
        );
    }
}

/// Rebuild the tray menu to reflect the current peer list. Safe to call from any
/// thread — the menu mutation is hopped onto the main thread.
pub fn refresh(app: &AppHandle, state: &NetworkingState) {
    let handle = app.clone();
    let state = state.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(tray) = handle.tray_by_id(TRAY_ID) {
            if let Ok(menu) = build_menu(&handle, &state) {
                let _ = tray.set_menu(Some(menu));
            }
        }
    });
}

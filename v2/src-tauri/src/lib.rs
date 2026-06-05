mod networking;
mod overlay;
mod persistence;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::networking::{network_interfaces, status_payload, NetworkingState};

#[derive(Serialize)]
struct HealthPayload {
    app: &'static str,
    phase: &'static str,
    platform: String,
}

#[tauri::command]
fn health() -> HealthPayload {
    HealthPayload {
        app: "Pings",
        phase: "v2-migration",
        platform: std::env::consts::OS.to_string(),
    }
}

#[tauri::command]
fn migration_modules() -> Vec<&'static str> {
    vec![
        "networking-service",
        "tray-and-menu",
        "overlay-alert-window",
        "group-chat",
        "private-chat-floating-windows",
        "profile-and-settings-persistence",
    ]
}

#[tauri::command]
fn get_network_interfaces(
    state: State<'_, NetworkingState>,
) -> Vec<networking::NetworkInterfaceInfo> {
    let preferred_ip = {
        let guard = state.inner.lock().expect("network state poisoned");
        guard.preferred_ip.clone()
    };
    network_interfaces(&preferred_ip)
}

#[tauri::command]
fn get_network_status(state: State<'_, NetworkingState>) -> networking::NetworkStatusPayload {
    status_payload(&state)
}

#[tauri::command]
fn get_peers(state: State<'_, NetworkingState>) -> Vec<networking::PeerInfo> {
    networking::peers_snapshot(&state)
}

#[tauri::command]
fn set_preferred_ip(
    app: AppHandle,
    state: State<'_, NetworkingState>,
    ip: String,
) -> networking::NetworkStatusPayload {
    let payload = networking::set_preferred_ip(&state, ip);
    networking::emit_network_status(&app, &state);
    networking::emit_peer_resets(&app);
    payload
}

#[tauri::command]
fn set_discovery_node_ip(
    app: AppHandle,
    state: State<'_, NetworkingState>,
    ip: String,
) -> networking::NetworkStatusPayload {
    let payload = networking::set_discovery_node_ip(&state, ip);
    networking::emit_network_status(&app, &state);
    payload
}

#[tauri::command]
fn get_settings(app: AppHandle) -> Result<persistence::Settings, String> {
    persistence::load_settings(&app)
}

#[tauri::command]
fn update_setting(
    app: AppHandle,
    key: String,
    value: serde_json::Value,
) -> Result<persistence::Settings, String> {
    let settings = persistence::update_setting(&app, key, value)?;
    let _ = app.emit("settings-updated", settings.clone());
    Ok(settings)
}

#[tauri::command]
fn get_profile(app: AppHandle) -> Result<persistence::Profile, String> {
    persistence::load_profile(&app)
}

#[tauri::command]
fn set_profile(
    app: AppHandle,
    state: State<'_, NetworkingState>,
    profile: persistence::Profile,
) -> Result<persistence::Profile, String> {
    persistence::save_profile(&app, &profile)?;
    networking::set_display_name(&state, profile.display_name.clone());
    networking::emit_network_status(&app, &state);
    Ok(profile)
}

#[tauri::command]
fn get_history(app: AppHandle) -> Result<Vec<persistence::HistoryEntry>, String> {
    persistence::load_history(&app)
}

#[tauri::command]
fn clear_history(app: AppHandle) -> Result<(), String> {
    persistence::clear_history(&app)
}

#[tauri::command]
fn send_ping(
    state: State<'_, NetworkingState>,
    ip: String,
    message: String,
    sound: Option<String>,
    shape: Option<String>,
) -> Result<networking::PingPayload, String> {
    let payload = networking::send_ping(
        &state,
        ip,
        message,
        sound.unwrap_or_else(|| "chime".to_string()),
        shape.unwrap_or_else(|| "circle".to_string()),
    )?;
    Ok(payload)
}

#[tauri::command]
fn send_team_chat(
    state: State<'_, NetworkingState>,
    message: String,
) -> Result<networking::ChatPayload, String> {
    networking::send_team_chat(&state, message)
}

#[tauri::command]
fn send_private_chat(
    state: State<'_, NetworkingState>,
    ip: String,
    message: String,
) -> Result<networking::ChatPayload, String> {
    networking::send_private_chat(&state, ip, message)
}

#[tauri::command]
fn open_options_window(app: AppHandle) -> Result<(), String> {
    overlay::open_options_window(&app)
}

#[tauri::command]
fn open_direct_chat_window(app: AppHandle, ip: String, name: Option<String>) -> Result<(), String> {
    overlay::open_direct_chat_window(&app, &ip, name)
}

#[tauri::command]
fn get_direct_chat_context(window_label: String) -> Option<overlay::DirectChatContextPayload> {
    overlay::get_direct_chat_context(&window_label)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let networking_state = NetworkingState::default();
    networking::initialize_state(&networking_state);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(networking_state.clone())
        .setup(move |app| {
            overlay::ensure_overlay_window(app.handle());
            if let Ok(settings) = persistence::load_settings(app.handle()) {
                let _ = networking::set_preferred_ip(&networking_state, settings.preferred_ip);
                let _ = networking::set_discovery_node_ip(
                    &networking_state,
                    settings.discovery_node_ip,
                );
            }
            if let Ok(profile) = persistence::load_profile(app.handle()) {
                networking::set_display_name(&networking_state, profile.display_name);
            }
            networking::start_mdns_discovery(app.handle().clone(), networking_state.clone());
            networking::start_ping_listener(app.handle().clone(), networking_state.clone());
            networking::start_legacy_ping_listener(app.handle().clone(), networking_state.clone());
            networking::start_chat_presence_listener(networking_state.clone());
            networking::start_chat_listener(app.handle().clone(), networking_state.clone());
            networking::emit_network_status(app.handle(), &networking_state);
            networking::start_status_publisher(app.handle().clone(), networking_state.clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            health,
            migration_modules,
            get_network_interfaces,
            get_network_status,
            get_peers,
            set_preferred_ip,
            set_discovery_node_ip,
            get_settings,
            update_setting,
            get_profile,
            set_profile,
            get_history,
            clear_history,
            send_ping,
            send_team_chat,
            send_private_chat,
            open_options_window,
            open_direct_chat_window,
            get_direct_chat_context
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

mod dispatch_host;
mod networking;
mod overlay;
mod palette;
mod persistence;
mod store;
mod toast;
mod tray;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::networking::{network_interfaces, status_payload, NetworkingState};

#[tauri::command]
fn get_network_interfaces(
    state: State<'_, NetworkingState>,
) -> Vec<networking::NetworkInterfaceInfo> {
    let (preferred_ip, prefer_overlay) = {
        let guard = state.lock_runtime();
        (guard.preferred_ip.clone(), guard.prefer_overlay)
    };
    network_interfaces(&preferred_ip, prefer_overlay)
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
    state: State<'_, NetworkingState>,
    key: String,
    value: serde_json::Value,
) -> Result<persistence::Settings, String> {
    let mut settings = persistence::update_setting(&app, key.clone(), value)?;
    // Network preferences must reach the live networking state, not just disk.
    match key.as_str() {
        "manualPeers" => {
            networking::set_manual_peers(&app, &state, settings.manual_peers.clone());
        }
        "preferOverlayInterface" => {
            let _ = networking::set_prefer_overlay(&state, settings.prefer_overlay_interface);
            networking::emit_network_status(&app, &state);
            networking::emit_peer_resets(&app);
        }
        "discoveryNodeIp" => {
            let _ =
                networking::set_discovery_node_ip(&state, settings.discovery_node_ip.clone());
            networking::emit_network_status(&app, &state);
        }
        "dispatchTeamKey" => {
            networking::set_dispatch_team_key(&state, settings.dispatch_team_key.clone());
            // A new team means a new enrollment — drop the old device token
            // so the client re-enrolls under the new key.
            networking::set_dispatch_device_token(&state, String::new());
            let _ = persistence::update_setting(
                &app,
                "dispatchDeviceToken".to_string(),
                serde_json::json!(""),
            );
        }
        "hostDispatchEnabled" => {
            if settings.host_dispatch_enabled {
                // First enable: mint the team key the host will hand out.
                if settings.host_dispatch_key.trim().is_empty() {
                    let minted = uuid::Uuid::new_v4().simple().to_string();
                    settings = persistence::update_setting(
                        &app,
                        "hostDispatchKey".to_string(),
                        serde_json::json!(minted),
                    )?;
                }
                // Join our own roster unless already pointed at some server —
                // a host that can't see its own team is a support ticket.
                if settings.discovery_node_ip.trim().is_empty() {
                    settings = persistence::update_setting(
                        &app,
                        "discoveryNodeIp".to_string(),
                        serde_json::json!("127.0.0.1:43217"),
                    )?;
                    let _ = networking::set_discovery_node_ip(
                        &state,
                        settings.discovery_node_ip.clone(),
                    );
                }
                if settings.dispatch_team_key.trim().is_empty() {
                    settings = persistence::update_setting(
                        &app,
                        "dispatchTeamKey".to_string(),
                        serde_json::json!(settings.host_dispatch_key.clone()),
                    )?;
                    networking::set_dispatch_team_key(
                        &state,
                        settings.dispatch_team_key.clone(),
                    );
                }
            }
            dispatch_host::apply(&app, &settings);
        }
        _ => {}
    }
    let _ = app.emit("settings-updated", settings.clone());
    Ok(settings)
}

#[tauri::command]
fn get_dispatch_host_status(app: AppHandle) -> dispatch_host::HostStatusPayload {
    let enabled = persistence::load_settings(&app)
        .map(|s| s.host_dispatch_enabled)
        .unwrap_or(false);
    dispatch_host::status(&app, enabled)
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
fn get_history(app: AppHandle, limit: Option<u32>) -> Result<Vec<store::HistoryEvent>, String> {
    store::history(&app, limit.unwrap_or(200).min(1000))
}

#[tauri::command]
fn clear_history(app: AppHandle) -> Result<(), String> {
    store::clear(&app)
}

/// Record an outgoing ping/chat to history, resolving the recipient's stable
/// identity and display name from the peer list when known.
pub(crate) fn record_outgoing(
    app: &AppHandle,
    kind: &str,
    target: Option<&networking::PeerInfo>,
    target_ip: &str,
    message: &str,
    timestamp: u64,
) {
    let peer_id = target.map(|p| p.peer_id.clone()).unwrap_or_default();
    let peer_name = target
        .map(|p| p.name.clone())
        .unwrap_or_else(|| target_ip.to_string());
    let _ = store::record(
        app,
        &store::HistoryEvent::new(kind, "out", peer_id, target_ip, peer_name, message, timestamp),
    );
}

#[tauri::command]
fn send_ping(
    app: AppHandle,
    state: State<'_, NetworkingState>,
    ip: String,
    message: String,
    sound: Option<String>,
    shape: Option<String>,
) -> Result<networking::PingPayload, String> {
    let target = networking::peer_by_ip(&state, &ip);
    let target_ip = ip.clone();
    let payload = networking::send_ping(
        &state,
        ip,
        message,
        sound.unwrap_or_else(|| "chime".to_string()),
        shape.unwrap_or_else(|| "circle".to_string()),
    )?;
    record_outgoing(&app, "ping", target.as_ref(), &target_ip, &payload.message, payload.timestamp);
    Ok(payload)
}

#[tauri::command]
fn send_team_chat(
    app: AppHandle,
    state: State<'_, NetworkingState>,
    message: String,
) -> Result<networking::ChatPayload, String> {
    let payload = networking::send_team_chat(&state, message)?;
    let _ = store::record(
        &app,
        &store::HistoryEvent::new(
            "team-chat",
            "out",
            "",
            "",
            "Team",
            payload.message.clone(),
            payload.timestamp,
        ),
    );
    Ok(payload)
}

#[tauri::command]
fn send_private_chat(
    app: AppHandle,
    state: State<'_, NetworkingState>,
    ip: String,
    message: String,
) -> Result<networking::ChatPayload, String> {
    let target = networking::peer_by_ip(&state, &ip);
    let target_ip = ip.clone();
    let payload = networking::send_private_chat(&state, ip, message)?;
    record_outgoing(&app, "chat", target.as_ref(), &target_ip, &payload.message, payload.timestamp);
    Ok(payload)
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

#[tauri::command]
fn hide_palette(app: AppHandle) {
    palette::hide(&app);
}

#[tauri::command]
fn hide_toast(app: AppHandle) {
    toast::hide(&app);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let networking_state = NetworkingState::default();
    networking::initialize_state(&networking_state);

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build());

    // The non-activating toast panel is macOS-only (AppKit NSPanel). On other
    // platforms the toast falls back to a normal window (see toast.rs).
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_nspanel::init());

    builder
        .manage(networking_state.clone())
        .manage(dispatch_host::DispatchHostState::default())
        .setup(move |app| {
            overlay::ensure_overlay_window(app.handle());

            // Paint the main window's webview backing the theme ground color so
            // it shows the app background instead of flashing white before the
            // page paints its first frame.
            if let Some(window) = app.get_webview_window("main") {
                let dark = persistence::load_settings(app.handle())
                    .map(|s| s.dark_mode)
                    .unwrap_or(false);
                overlay::paint_window_ground(&window, dark);
            }
            if let Ok(settings) = persistence::load_settings(app.handle()) {
                // Resume hosting the team server if it was on when we quit.
                dispatch_host::apply(app.handle(), &settings);
                let _ = networking::set_prefer_overlay(
                    &networking_state,
                    settings.prefer_overlay_interface,
                );
                let _ = networking::set_preferred_ip(&networking_state, settings.preferred_ip);
                let _ = networking::set_discovery_node_ip(
                    &networking_state,
                    settings.discovery_node_ip,
                );
                networking::set_dispatch_team_key(
                    &networking_state,
                    settings.dispatch_team_key,
                );
                networking::set_dispatch_device_token(
                    &networking_state,
                    settings.dispatch_device_token,
                );
                networking::set_manual_peers(
                    app.handle(),
                    &networking_state,
                    settings.manual_peers,
                );
            }
            if let Ok(profile) = persistence::load_profile_ensure_peer_id(app.handle()) {
                networking::set_local_peer_id(&networking_state, profile.peer_id);
                networking::set_display_name(&networking_state, profile.display_name);
            }
            networking::start_mdns_discovery(app.handle().clone(), networking_state.clone());
            networking::start_ping_listener(app.handle().clone(), networking_state.clone());
            networking::start_legacy_ping_listener(app.handle().clone(), networking_state.clone());
            networking::start_chat_presence_listener(networking_state.clone());
            networking::start_chat_listener(app.handle().clone(), networking_state.clone());
            networking::emit_network_status(app.handle(), &networking_state);
            networking::start_status_publisher(app.handle().clone(), networking_state.clone());
            networking::start_heartbeat_publisher(networking_state.clone());
            networking::start_dispatch_client(app.handle().clone(), networking_state.clone());
            networking::start_relay_client(app.handle().clone(), networking_state.clone());

            // Menubar tray with per-peer quick-ping. It's kept in sync directly
            // from networking::emit_peers_snapshot as the peer list changes.
            tray::init(app.handle(), networking_state.clone())?;

            // Global shortcut (Cmd/Ctrl+Shift+K) toggles the command palette.
            // Registration failing (e.g. the combo is taken) must not stop the
            // app from launching.
            {
                use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
                let toggle = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyK);
                if let Err(err) = app.global_shortcut().on_shortcut(toggle, |app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        palette::toggle(app);
                    }
                }) {
                    eprintln!("[pings] failed to register palette shortcut: {err}");
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // Live in the menubar: closing the main window hides it (reopen via
            // the tray's "Open Pings"; Cmd-Q or the tray's Quit still exits).
            // Other windows (DMs, options) close normally.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
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
            get_direct_chat_context,
            get_dispatch_host_status,
            hide_palette,
            hide_toast
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

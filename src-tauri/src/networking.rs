use crate::overlay;
use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use serde::{Deserialize, Serialize};
use socketioxide::{extract::Data, SocketIo};
use std::collections::{HashMap, HashSet};
use std::net::{Ipv4Addr, TcpListener, UdpSocket};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

const MDNS_SERVICE_TYPE: &str = "_pings._tcp.local.";
const PING_PORT: u16 = 43210;
const CHAT_PORT: u16 = 43211;
const PEER_STALE_MS: u64 = 900_000;

#[derive(Clone, Default)]
pub struct NetworkingState {
    pub inner: Arc<Mutex<NetworkRuntime>>,
}

impl NetworkingState {
    /// Lock the runtime, recovering from a poisoned mutex instead of panicking.
    /// If some thread panicked mid-update the data is possibly stale but still
    /// structurally valid, so recovering keeps the rest of the app alive rather
    /// than turning one panic into a cascade of them across every listener.
    pub fn lock_runtime(&self) -> std::sync::MutexGuard<'_, NetworkRuntime> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerInfo {
    pub ip: String,
    /// Stable identity for this peer, empty for legacy (v1) or bare
    /// subnet-probed peers that never announced one. IP is a routing
    /// detail; identity follows this field.
    pub peer_id: String,
    pub name: String,
    pub color: String,
    pub last_seen: u64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PingPayload {
    pub from: String,
    pub from_ip: String,
    #[serde(default)]
    pub from_peer_id: String,
    pub message: String,
    pub sound: String,
    pub shape: String,
    pub timestamp: u64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatPayload {
    /// Per-message id. Private messages carry one so the recipient can ack it
    /// and the sender can move the message from "sent" to "delivered". Team
    /// messages and pings leave it empty.
    #[serde(default)]
    pub id: String,
    pub kind: String,
    pub from: String,
    pub from_ip: String,
    #[serde(default)]
    pub from_peer_id: String,
    pub to_ip: String,
    pub message: String,
    pub timestamp: u64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyPingData {
    from: Option<String>,
    message: Option<String>,
    sound: Option<String>,
    shape: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInterfaceInfo {
    pub name: String,
    pub address: String,
    pub preferred: bool,
    pub score: i32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkStatusPayload {
    pub ip: String,
    pub hostname: String,
    pub preferred_ip: String,
    pub discovery_node_ip: String,
    pub diagnostics: NetworkDiagnostics,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkDiagnostics {
    pub local_ip: String,
    pub preferred_ip: String,
    pub discovery_node_ip: String,
    pub discovery_node_connected: bool,
    pub peers_count: usize,
    pub chat_peers_count: usize,
    pub mdns_resets: u64,
    pub mdns_queries_sent: u64,
    pub mdns_announcements_sent: u64,
    pub mdns_responses_received: u64,
    pub mdns_queries_received: u64,
    pub last_mdns_response_at: u64,
    pub last_mdns_query_at: u64,
    pub last_announce_at: u64,
    pub last_query_sent_at: u64,
    pub last_node_connect_attempt_at: u64,
    pub last_node_connect_success_at: u64,
    pub last_peer_list_sync_at: u64,
    pub last_peer_list_count: usize,
    pub last_discovery_peer_ip: String,
    pub last_connect_attempt_ip: String,
    pub last_connect_success_ip: String,
    pub last_connect_error: String,
}

#[derive(Default)]
pub struct NetworkRuntime {
    pub hostname: String,
    pub display_name: String,
    pub local_peer_id: String,
    pub preferred_ip: String,
    pub discovery_node_ip: String,
    pub local_ip: String,
    pub peers: HashMap<String, PeerInfo>,
    pub peer_fullnames: HashMap<String, String>,
    pub discovery_started: bool,
    pub diagnostics: RuntimeDiagnostics,
}

#[derive(Default)]
pub struct RuntimeDiagnostics {
    pub peers_count: usize,
    pub chat_peers_count: usize,
    pub mdns_resets: u64,
    pub mdns_queries_sent: u64,
    pub mdns_announcements_sent: u64,
    pub mdns_responses_received: u64,
    pub mdns_queries_received: u64,
    pub last_mdns_response_at: u64,
    pub last_mdns_query_at: u64,
    pub last_announce_at: u64,
    pub last_query_sent_at: u64,
    pub last_node_connect_attempt_at: u64,
    pub last_node_connect_success_at: u64,
    pub last_peer_list_sync_at: u64,
    pub last_peer_list_count: usize,
    pub last_discovery_peer_ip: String,
    pub last_connect_attempt_ip: String,
    pub last_connect_success_ip: String,
    pub last_connect_error: String,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn normalize_ip(ip: &str) -> String {
    ip.replace("::ffff:", "")
}

fn normalize_host(hostname: &str) -> String {
    let trimmed = hostname.trim_end_matches(".local").trim_end_matches('.');
    if trimmed.is_empty() {
        "pings.local.".to_string()
    } else {
        format!("{trimmed}.local.")
    }
}

fn is_private_ipv4(ip: &str) -> bool {
    let Ok(addr) = ip.parse::<Ipv4Addr>() else {
        return false;
    };
    let octets = addr.octets();
    if octets[0] == 10 {
        return true;
    }
    if octets[0] == 192 && octets[1] == 168 {
        return true;
    }
    octets[0] == 172 && (16..=31).contains(&octets[1])
}

fn is_carrier_grade_nat_ipv4(ip: &str) -> bool {
    let Ok(addr) = ip.parse::<Ipv4Addr>() else {
        return false;
    };
    let octets = addr.octets();
    octets[0] == 100 && (64..=127).contains(&octets[1])
}

fn interface_penalty(name: &str) -> i32 {
    let lowered = name.to_ascii_lowercase();
    if lowered.contains("tailscale") {
        return 100;
    }
    if lowered.contains("utun") {
        return 90;
    }
    if lowered.contains("wireguard") || lowered.contains("wg") {
        return 80;
    }
    if lowered.contains("tun") {
        return 70;
    }
    0
}

fn get_color_from_name(name: &str) -> String {
    const COLORS: [&str; 8] = [
        "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
        "linear-gradient(135deg, #f093fb 0%, #f5576c 100%)",
        "linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)",
        "linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)",
        "linear-gradient(135deg, #fa709a 0%, #fee140 100%)",
        "linear-gradient(135deg, #a8edea 0%, #fed6e3 100%)",
        "linear-gradient(135deg, #ff9a9e 0%, #fecfef 100%)",
        "linear-gradient(135deg, #ffecd2 0%, #fcb69f 100%)",
    ];
    let mut hash: i32 = 0;
    for ch in name.chars() {
        hash = (ch as i32).wrapping_add((hash << 5).wrapping_sub(hash));
    }
    let idx = (hash.unsigned_abs() as usize) % COLORS.len();
    COLORS[idx].to_string()
}

pub fn network_interfaces(preferred_ip: &str) -> Vec<NetworkInterfaceInfo> {
    let mut list = Vec::new();
    for iface in if_addrs::get_if_addrs().unwrap_or_default() {
        if iface.is_loopback() {
            continue;
        }
        let ip = match iface.addr {
            if_addrs::IfAddr::V4(v4) => v4.ip.to_string(),
            if_addrs::IfAddr::V6(_) => continue,
        };
        let normalized = normalize_ip(&ip);
        let mut score = 100;
        if is_private_ipv4(&normalized) {
            score -= 60;
        }
        if is_carrier_grade_nat_ipv4(&normalized) {
            score += 20;
        }
        score += interface_penalty(&iface.name);
        list.push(NetworkInterfaceInfo {
            name: iface.name,
            address: normalized.clone(),
            preferred: !preferred_ip.is_empty() && normalized == preferred_ip,
            score,
        });
    }
    list.sort_by_key(|v| v.score);
    list
}

fn local_ipv4_addresses(preferred_ip: &str) -> HashSet<String> {
    network_interfaces(preferred_ip)
        .into_iter()
        .map(|i| normalize_ip(&i.address))
        .collect()
}

fn is_local_interface_ip(ip: &str, preferred_ip: &str) -> bool {
    let normalized = normalize_ip(ip);
    if normalized == "127.0.0.1" {
        return true;
    }
    local_ipv4_addresses(preferred_ip).contains(&normalized)
}

fn pick_local_ip(preferred_ip: &str) -> String {
    let interfaces = network_interfaces(preferred_ip);
    if !preferred_ip.is_empty() {
        if let Some(found) = interfaces.iter().find(|i| i.address == preferred_ip) {
            return found.address.clone();
        }
    }
    interfaces
        .first()
        .map(|i| i.address.clone())
        .unwrap_or_else(|| "127.0.0.1".to_string())
}

pub fn initialize_state(state: &NetworkingState) {
    let mut guard = state.lock_runtime();
    guard.hostname = hostname::get()
        .map(|v| v.to_string_lossy().to_string())
        .unwrap_or_else(|_| "offline".to_string());
    guard.display_name = guard.hostname.clone();
    guard.local_ip = pick_local_ip(&guard.preferred_ip);
}

pub fn set_display_name(state: &NetworkingState, name: String) {
    let mut guard = state.lock_runtime();
    let fallback = guard.hostname.clone();
    guard.display_name = if name.trim().is_empty() {
        fallback
    } else {
        name.trim().to_string()
    };
}

pub fn set_local_peer_id(state: &NetworkingState, peer_id: String) {
    let mut guard = state.lock_runtime();
    guard.local_peer_id = peer_id.trim().to_string();
}

/// Insert or refresh a peer, keyed by IP for routing while preserving the
/// stable `peer_id`, color, and last-known name across updates. A caller that
/// only knows the IP (a legacy ping, a subnet probe) passes an empty
/// `peer_id`/`name` and never clobbers identity learned from richer sources
/// like mDNS.
fn upsert_peer_locked(runtime: &mut NetworkRuntime, ip: &str, peer_id: &str, name: &str) {
    let existing = runtime.peers.get(ip);
    let trimmed_name = name.trim();
    let trimmed_id = peer_id.trim();

    let color = existing
        .map(|p| p.color.clone())
        .unwrap_or_else(|| get_color_from_name(if trimmed_name.is_empty() { ip } else { trimmed_name }));
    let resolved_peer_id = if !trimmed_id.is_empty() {
        trimmed_id.to_string()
    } else {
        existing.map(|p| p.peer_id.clone()).unwrap_or_default()
    };
    let resolved_name = if !trimmed_name.is_empty() {
        trimmed_name.to_string()
    } else {
        existing
            .map(|p| p.name.clone())
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| ip.to_string())
    };

    runtime.peers.insert(
        ip.to_string(),
        PeerInfo {
            ip: ip.to_string(),
            peer_id: resolved_peer_id,
            name: resolved_name,
            color,
            last_seen: now_millis(),
        },
    );
    runtime.diagnostics.peers_count = runtime.peers.len();
    runtime.diagnostics.last_discovery_peer_ip = ip.to_string();
}

pub fn status_payload(state: &NetworkingState) -> NetworkStatusPayload {
    let guard = state.lock_runtime();
    NetworkStatusPayload {
        ip: guard.local_ip.clone(),
        hostname: guard.display_name.clone(),
        preferred_ip: guard.preferred_ip.clone(),
        discovery_node_ip: guard.discovery_node_ip.clone(),
        diagnostics: NetworkDiagnostics {
            local_ip: guard.local_ip.clone(),
            preferred_ip: guard.preferred_ip.clone(),
            discovery_node_ip: guard.discovery_node_ip.clone(),
            discovery_node_connected: false,
            peers_count: guard.diagnostics.peers_count,
            chat_peers_count: guard.diagnostics.chat_peers_count,
            mdns_resets: guard.diagnostics.mdns_resets,
            mdns_queries_sent: guard.diagnostics.mdns_queries_sent,
            mdns_announcements_sent: guard.diagnostics.mdns_announcements_sent,
            mdns_responses_received: guard.diagnostics.mdns_responses_received,
            mdns_queries_received: guard.diagnostics.mdns_queries_received,
            last_mdns_response_at: guard.diagnostics.last_mdns_response_at,
            last_mdns_query_at: guard.diagnostics.last_mdns_query_at,
            last_announce_at: guard.diagnostics.last_announce_at,
            last_query_sent_at: guard.diagnostics.last_query_sent_at,
            last_node_connect_attempt_at: guard.diagnostics.last_node_connect_attempt_at,
            last_node_connect_success_at: guard.diagnostics.last_node_connect_success_at,
            last_peer_list_sync_at: guard.diagnostics.last_peer_list_sync_at,
            last_peer_list_count: guard.diagnostics.last_peer_list_count,
            last_discovery_peer_ip: guard.diagnostics.last_discovery_peer_ip.clone(),
            last_connect_attempt_ip: guard.diagnostics.last_connect_attempt_ip.clone(),
            last_connect_success_ip: guard.diagnostics.last_connect_success_ip.clone(),
            last_connect_error: guard.diagnostics.last_connect_error.clone(),
        },
    }
}

fn emit_peers_snapshot(app: &AppHandle, state: &NetworkingState) {
    let peers = {
        let guard = state.lock_runtime();
        let mut values = guard.peers.values().cloned().collect::<Vec<_>>();
        values.sort_by(|a, b| a.name.cmp(&b.name));
        values
    };
    let _ = app.emit("peers-updated", peers);
    let empty_chat_peers: Vec<serde_json::Value> = Vec::new();
    let _ = app.emit("chat-peers-updated", empty_chat_peers);
    // Keep the tray's quick-ping menu in sync with the peer list. No-ops until
    // the tray exists, and safe to call from any listener thread.
    crate::tray::refresh(app, state);
}

pub fn set_preferred_ip(state: &NetworkingState, ip: String) -> NetworkStatusPayload {
    {
        let mut guard = state.lock_runtime();
        guard.preferred_ip = ip.trim().to_string();
        let next_ip = pick_local_ip(&guard.preferred_ip);
        if next_ip != guard.local_ip {
            guard.local_ip = next_ip;
            guard.peers.clear();
            guard.peer_fullnames.clear();
            guard.diagnostics.mdns_resets += 1;
            guard.diagnostics.last_node_connect_attempt_at = now_millis();
            guard.diagnostics.last_connect_error = "network-reinit-pending".to_string();
            guard.diagnostics.peers_count = 0;
            guard.diagnostics.chat_peers_count = 0;
        }
    }
    status_payload(state)
}

pub fn set_discovery_node_ip(state: &NetworkingState, ip: String) -> NetworkStatusPayload {
    {
        let mut guard = state.lock_runtime();
        guard.discovery_node_ip = ip.trim().to_string();
        guard.diagnostics.last_node_connect_attempt_at = now_millis();
        if guard.discovery_node_ip.is_empty() {
            guard.diagnostics.last_connect_error.clear();
        } else {
            guard.diagnostics.last_connect_attempt_ip = guard.discovery_node_ip.clone();
            guard.diagnostics.last_connect_error = "not-connected-yet".to_string();
        }
    }
    status_payload(state)
}

pub fn emit_network_status(app: &AppHandle, state: &NetworkingState) {
    let status = status_payload(state);
    let _ = app.emit("network-status", status);
}

pub fn emit_peer_resets(app: &AppHandle) {
    let empty_vec: Vec<serde_json::Value> = Vec::new();
    let _ = app.emit("peers-updated", &empty_vec);
    let _ = app.emit("chat-peers-updated", &empty_vec);
}

pub fn peers_snapshot(state: &NetworkingState) -> Vec<PeerInfo> {
    let guard = state.lock_runtime();
    let mut values = guard.peers.values().cloned().collect::<Vec<_>>();
    values.sort_by(|a, b| a.name.cmp(&b.name));
    values
}

/// Look up a known peer by IP so an outbound ping/chat can be recorded with the
/// recipient's stable identity and display name rather than a bare address.
pub fn peer_by_ip(state: &NetworkingState, ip: &str) -> Option<PeerInfo> {
    let guard = state.lock_runtime();
    let normalized = normalize_ip(ip);
    guard
        .peers
        .get(&normalized)
        .cloned()
        .or_else(|| guard.peers.values().find(|p| normalize_ip(&p.ip) == normalized).cloned())
}

fn touch_peer(state: &NetworkingState, ip: &str, peer_id: &str, name: &str) {
    let mut guard = state.lock_runtime();
    if is_local_interface_ip(ip, &guard.preferred_ip) {
        return;
    }
    upsert_peer_locked(&mut guard, ip, peer_id, name);
}

pub fn start_status_publisher(app: AppHandle, state: NetworkingState) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(5));
        let now = now_millis();
        let changed = {
            let mut guard = state.lock_runtime();
            let before = guard.peers.len();
            guard
                .peers
                .retain(|_, peer| now.saturating_sub(peer.last_seen) <= PEER_STALE_MS);
            let changed = guard.peers.len() != before;
            guard.diagnostics.peers_count = guard.peers.len();
            changed
        };
        if changed {
            emit_peers_snapshot(&app, &state);
        }
        emit_network_status(&app, &state);
    });
}

pub fn start_mdns_discovery(app: AppHandle, state: NetworkingState) {
    {
        let mut guard = state.lock_runtime();
        if guard.discovery_started {
            return;
        }
        guard.discovery_started = true;
    }

    std::thread::spawn(move || {
        let mdns = match ServiceDaemon::new() {
            Ok(v) => v,
            Err(err) => {
                let mut guard = state.lock_runtime();
                guard.diagnostics.last_connect_error = format!("mdns-daemon:{err}");
                return;
            }
        };

        let (local_ip, host, instance_name, display_name, local_peer_id) = {
            let guard = state.lock_runtime();
            (
                guard.local_ip.clone(),
                normalize_host(&guard.hostname),
                guard.hostname.clone(),
                guard.display_name.clone(),
                guard.local_peer_id.clone(),
            )
        };

        let properties = [
            ("name", display_name.as_str()),
            ("id", local_peer_id.as_str()),
        ];
        let service_info = ServiceInfo::new(
            MDNS_SERVICE_TYPE,
            &instance_name,
            &host,
            local_ip.as_str(),
            PING_PORT,
            &properties[..],
        );

        if let Ok(service) = service_info {
            if mdns.register(service).is_ok() {
                let mut guard = state.lock_runtime();
                guard.diagnostics.mdns_announcements_sent += 1;
                guard.diagnostics.last_announce_at = now_millis();
            }
        }

        let receiver = match mdns.browse(MDNS_SERVICE_TYPE) {
            Ok(rx) => {
                let mut guard = state.lock_runtime();
                guard.diagnostics.mdns_queries_sent += 1;
                guard.diagnostics.last_query_sent_at = now_millis();
                rx
            }
            Err(err) => {
                let mut guard = state.lock_runtime();
                guard.diagnostics.last_connect_error = format!("mdns-browse:{err}");
                return;
            }
        };

        while let Ok(event) = receiver.recv() {
            match event {
                ServiceEvent::SearchStarted(_) => {
                    let mut guard = state.lock_runtime();
                    guard.diagnostics.mdns_queries_received += 1;
                    guard.diagnostics.last_mdns_query_at = now_millis();
                }
                ServiceEvent::ServiceResolved(info) => {
                    let maybe_ip = info
                        .get_addresses_v4()
                        .iter()
                        .next()
                        .map(|ip| ip.to_string())
                        .map(|ip| normalize_ip(&ip));
                    let Some(ip) = maybe_ip else {
                        continue;
                    };

                    let should_emit = {
                        let mut guard = state.lock_runtime();
                        if is_local_interface_ip(&ip, &guard.preferred_ip) {
                            continue;
                        }

                        let name = info
                            .get_property_val_str("name")
                            .map(|v| v.to_string())
                            .unwrap_or_else(|| ip.clone());
                        let peer_id = info
                            .get_property_val_str("id")
                            .map(|v| v.to_string())
                            .unwrap_or_default();

                        let fullname = info.get_fullname().to_string();
                        upsert_peer_locked(&mut guard, &ip, &peer_id, &name);
                        guard.peer_fullnames.insert(fullname, ip.clone());
                        guard.diagnostics.mdns_responses_received += 1;
                        guard.diagnostics.last_mdns_response_at = now_millis();
                        true
                    };
                    if should_emit {
                        emit_peers_snapshot(&app, &state);
                        emit_network_status(&app, &state);
                    }
                }
                ServiceEvent::ServiceRemoved(_, fullname) => {
                    let mut guard = state.lock_runtime();
                    let _ = guard.peer_fullnames.remove(&fullname);
                }
                _ => {}
            }
        }

        let _ = mdns.shutdown();
    });
}

pub fn start_ping_listener(app: AppHandle, state: NetworkingState) {
    std::thread::spawn(move || {
        let socket = match UdpSocket::bind(("0.0.0.0", PING_PORT)) {
            Ok(s) => s,
            Err(err) => {
                let mut guard = state.lock_runtime();
                guard.diagnostics.last_connect_error = format!("ping-bind:{err}");
                return;
            }
        };
        let mut buffer = vec![0u8; 4096];
        loop {
            let Ok((size, from_addr)) = socket.recv_from(&mut buffer) else {
                continue;
            };
            let Ok(text) = std::str::from_utf8(&buffer[..size]) else {
                continue;
            };
            let Ok(payload) = serde_json::from_str::<PingPayload>(text) else {
                continue;
            };
            let from_ip = normalize_ip(&from_addr.ip().to_string());

            {
                let mut guard = state.lock_runtime();
                if !is_local_interface_ip(&from_ip, &guard.preferred_ip) {
                    upsert_peer_locked(&mut guard, &from_ip, &payload.from_peer_id, &payload.from);
                }
            }

            emit_peers_snapshot(&app, &state);
            emit_network_status(&app, &state);
            overlay::show_ping_overlay(
                &app,
                &payload.from,
                &payload.from_ip,
                &payload.message,
                &payload.sound,
                &payload.shape,
                payload.timestamp,
            );
            record_incoming_ping(&app, &payload);
            let _ = app.emit("incoming-ping", payload);
        }
    });
}

fn record_incoming_ping(app: &AppHandle, payload: &PingPayload) {
    let _ = crate::store::record(
        app,
        &crate::store::HistoryEvent::new(
            "ping",
            "in",
            payload.from_peer_id.clone(),
            payload.from_ip.clone(),
            payload.from.clone(),
            payload.message.clone(),
            payload.timestamp,
        ),
    );
}

fn record_incoming_chat(app: &AppHandle, kind: &str, payload: &ChatPayload) {
    let _ = crate::store::record(
        app,
        &crate::store::HistoryEvent::new(
            kind,
            "in",
            payload.from_peer_id.clone(),
            payload.from_ip.clone(),
            payload.from.clone(),
            payload.message.clone(),
            payload.timestamp,
        ),
    );
}

pub fn start_legacy_ping_listener(app: AppHandle, state: NetworkingState) {
    std::thread::spawn(move || {
        let runtime = match tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => rt,
            Err(err) => {
                let mut guard = state.lock_runtime();
                guard.diagnostics.last_connect_error = format!("legacy-ping-rt:{err}");
                return;
            }
        };

        runtime.block_on(async move {
            let (layer, io) = SocketIo::new_layer();

            let app_for_ns = app.clone();
            let state_for_ns = state.clone();
            io.ns("/", move |socket: socketioxide::extract::SocketRef| {
                let app_for_event = app_for_ns.clone();
                let state_for_event = state_for_ns.clone();
                async move {
                    socket.on("ping-user", move |Data(data): Data<LegacyPingData>| {
                        let app_for_emit = app_for_event.clone();
                        let state_for_emit = state_for_event.clone();
                        async move {
                            let from_name = data
                                .from
                                .as_deref()
                                .map(str::trim)
                                .filter(|v| !v.is_empty())
                                .unwrap_or("legacy-peer")
                                .to_string();
                            let from_ip_fallback = "legacy-v1".to_string();

                            let inferred_ip = {
                                let guard =
                                    state_for_emit.lock_runtime();
                                guard
                                    .peers
                                    .values()
                                    .find(|peer| peer.name == from_name)
                                    .map(|peer| peer.ip.clone())
                            };

                            let from_ip = inferred_ip.unwrap_or(from_ip_fallback);
                            let payload = PingPayload {
                                from: from_name.clone(),
                                from_ip: from_ip.clone(),
                                from_peer_id: String::new(),
                                message: data.message.unwrap_or_default(),
                                sound: data.sound.unwrap_or_else(|| "chime".to_string()),
                                shape: data.shape.unwrap_or_else(|| "circle".to_string()),
                                timestamp: now_millis(),
                            };

                            {
                                let mut guard =
                                    state_for_emit.lock_runtime();
                                if !is_local_interface_ip(&from_ip, &guard.preferred_ip) {
                                    upsert_peer_locked(&mut guard, &from_ip, "", &from_name);
                                }
                            }

                            emit_peers_snapshot(&app_for_emit, &state_for_emit);
                            emit_network_status(&app_for_emit, &state_for_emit);
                            overlay::show_ping_overlay(
                                &app_for_emit,
                                &payload.from,
                                &payload.from_ip,
                                &payload.message,
                                &payload.sound,
                                &payload.shape,
                                payload.timestamp,
                            );
                            record_incoming_ping(&app_for_emit, &payload);
                            let _ = app_for_emit.emit("incoming-ping", payload);
                        }
                    });
                }
            });

            let app_router = axum::Router::new().layer(layer);
            let listener = match tokio::net::TcpListener::bind(("0.0.0.0", PING_PORT)).await {
                Ok(v) => v,
                Err(err) => {
                    let mut guard = state.lock_runtime();
                    guard.diagnostics.last_connect_error = format!("legacy-ping-bind:{err}");
                    return;
                }
            };

            if let Err(err) = axum::serve(listener, app_router).await {
                let mut guard = state.lock_runtime();
                guard.diagnostics.last_connect_error = format!("legacy-ping-serve:{err}");
            }
        });
    });
}

pub fn start_chat_presence_listener(state: NetworkingState) {
    std::thread::spawn(move || {
        let listener = match TcpListener::bind(("0.0.0.0", CHAT_PORT)) {
            Ok(v) => v,
            Err(err) => {
                let mut guard = state.lock_runtime();
                guard.diagnostics.last_connect_error = format!("chat-presence-bind:{err}");
                return;
            }
        };
        loop {
            if listener.accept().is_err() {
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    });
}

pub fn start_chat_listener(app: AppHandle, state: NetworkingState) {
    std::thread::spawn(move || {
        let socket = match UdpSocket::bind(("0.0.0.0", CHAT_PORT)) {
            Ok(s) => s,
            Err(err) => {
                let mut guard = state.lock_runtime();
                guard.diagnostics.last_connect_error = format!("chat-bind:{err}");
                return;
            }
        };
        let mut buffer = vec![0u8; 8192];
        loop {
            let Ok((size, from_addr)) = socket.recv_from(&mut buffer) else {
                continue;
            };
            let Ok(text) = std::str::from_utf8(&buffer[..size]) else {
                continue;
            };
            let Ok(mut payload) = serde_json::from_str::<ChatPayload>(text) else {
                continue;
            };
            let source_ip = normalize_ip(&from_addr.ip().to_string());

            {
                let guard = state.lock_runtime();
                if is_local_interface_ip(&source_ip, &guard.preferred_ip) {
                    continue;
                }
            }

            payload.from_ip = source_ip.clone();
            touch_peer(&state, &source_ip, &payload.from_peer_id, &payload.from);

            // An ack confirms a private message we sent was delivered. Tell the
            // frontend and stop — acks are not messages and are not recorded.
            if payload.kind == "ack" {
                let _ = app.emit(
                    "chat-ack",
                    serde_json::json!({
                        "id": payload.id,
                        "fromIp": source_ip,
                        "fromPeerId": payload.from_peer_id,
                    }),
                );
                continue;
            }

            emit_peers_snapshot(&app, &state);
            emit_network_status(&app, &state);

            if payload.kind == "private" {
                let should_accept = {
                    let guard = state.lock_runtime();
                    payload.to_ip.trim().is_empty()
                        || is_local_interface_ip(&payload.to_ip, &guard.preferred_ip)
                };
                if !should_accept {
                    continue;
                }
                let _ = overlay::open_direct_chat_window(
                    &app,
                    &payload.from_ip,
                    Some(payload.from.clone()),
                );
                if let Ok(value) = serde_json::to_value(payload.clone()) {
                    overlay::emit_private_chat_to_window(
                        &app,
                        &payload.from_ip,
                        Some(payload.from.as_str()),
                        value,
                    );
                }
                record_incoming_chat(&app, "chat", &payload);
                if !payload.id.trim().is_empty() {
                    send_ack(&state, &source_ip, &payload.id);
                }
                let _ = app.emit("incoming-private-chat", payload);
                continue;
            }

            record_incoming_chat(&app, "team-chat", &payload);
            let _ = app.emit("incoming-team-chat", payload);
        }
    });
}

pub fn send_ping(
    state: &NetworkingState,
    target_ip: String,
    message: String,
    sound: String,
    shape: String,
) -> Result<PingPayload, String> {
    let (from_name, from_ip, from_peer_id) = {
        let guard = state.lock_runtime();
        (
            guard.display_name.clone(),
            guard.local_ip.clone(),
            guard.local_peer_id.clone(),
        )
    };

    let payload = PingPayload {
        from: from_name,
        from_ip,
        from_peer_id,
        message,
        sound: if sound.trim().is_empty() {
            "chime".to_string()
        } else {
            sound
        },
        shape: if shape.trim().is_empty() {
            "circle".to_string()
        } else {
            shape
        },
        timestamp: now_millis(),
    };

    let socket = UdpSocket::bind(("0.0.0.0", 0)).map_err(|e| format!("ping-send-bind:{e}"))?;
    let bytes = serde_json::to_vec(&payload).map_err(|e| format!("ping-send-serialize:{e}"))?;
    socket
        .send_to(&bytes, (target_ip.as_str(), PING_PORT))
        .map_err(|e| format!("ping-send:{e}"))?;

    Ok(payload)
}

pub fn send_team_chat(state: &NetworkingState, message: String) -> Result<ChatPayload, String> {
    let (from_name, from_ip, from_peer_id, peer_ips) = {
        let guard = state.lock_runtime();
        let ips = guard
            .peers
            .keys()
            .filter(|ip| **ip != guard.local_ip)
            .cloned()
            .collect::<Vec<_>>();
        (
            guard.display_name.clone(),
            guard.local_ip.clone(),
            guard.local_peer_id.clone(),
            ips,
        )
    };

    let payload = ChatPayload {
        id: String::new(),
        kind: "team".to_string(),
        from: from_name,
        from_ip,
        from_peer_id,
        to_ip: String::new(),
        message,
        timestamp: now_millis(),
    };

    let socket = UdpSocket::bind(("0.0.0.0", 0)).map_err(|e| format!("team-chat-bind:{e}"))?;
    let bytes = serde_json::to_vec(&payload).map_err(|e| format!("team-chat-serialize:{e}"))?;
    for ip in peer_ips {
        let _ = socket.send_to(&bytes, (ip.as_str(), CHAT_PORT));
    }

    Ok(payload)
}

pub fn send_private_chat(
    state: &NetworkingState,
    target_ip: String,
    message: String,
) -> Result<ChatPayload, String> {
    let (from_name, from_ip, from_peer_id) = {
        let guard = state.lock_runtime();
        (
            guard.display_name.clone(),
            guard.local_ip.clone(),
            guard.local_peer_id.clone(),
        )
    };

    let payload = ChatPayload {
        id: uuid::Uuid::new_v4().to_string(),
        kind: "private".to_string(),
        from: from_name,
        from_ip,
        from_peer_id,
        to_ip: target_ip.clone(),
        message,
        timestamp: now_millis(),
    };

    let socket = UdpSocket::bind(("0.0.0.0", 0)).map_err(|e| format!("private-chat-bind:{e}"))?;
    let bytes = serde_json::to_vec(&payload).map_err(|e| format!("private-chat-serialize:{e}"))?;
    socket
        .send_to(&bytes, (target_ip.as_str(), CHAT_PORT))
        .map_err(|e| format!("private-chat-send:{e}"))?;

    Ok(payload)
}

/// Send a delivery acknowledgement for a received private message back to its
/// sender. Best-effort: a lost ack just leaves the sender showing "sent"
/// instead of "delivered", never blocks anything.
fn send_ack(state: &NetworkingState, target_ip: &str, message_id: &str) {
    let (from_name, from_ip, from_peer_id) = {
        let guard = state.lock_runtime();
        (
            guard.display_name.clone(),
            guard.local_ip.clone(),
            guard.local_peer_id.clone(),
        )
    };

    let payload = ChatPayload {
        id: message_id.to_string(),
        kind: "ack".to_string(),
        from: from_name,
        from_ip,
        from_peer_id,
        to_ip: target_ip.to_string(),
        message: String::new(),
        timestamp: now_millis(),
    };

    let Ok(socket) = UdpSocket::bind(("0.0.0.0", 0)) else {
        return;
    };
    if let Ok(bytes) = serde_json::to_vec(&payload) {
        let _ = socket.send_to(&bytes, (target_ip, CHAT_PORT));
    }
}

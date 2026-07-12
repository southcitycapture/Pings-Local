//! Pings Dispatch — the team rendezvous + relay server (phases D1–D2).
//!
//! Three roles, each optional per deployment:
//! - **Directory** (D1): clients register on a heartbeat cadence and pull the
//!   roster — unicast discovery where multicast can't reach.
//! - **Relay** (D2): clients hold one outbound WebSocket; when two peers
//!   can't route to each other, envelopes are forwarded through it. Frames
//!   are content-blind — the server routes on `{to, channel}` and never
//!   inspects `payload` (keeps the door open for end-to-end encryption).
//! - **Enrollment** (D2): the team key is the *enrollment* secret; each
//!   device trades it for its own revocable token, stored server-side only
//!   as a SHA-256 hash.
//!
//! Pings and chat still prefer direct peer-to-peer; the relay is the
//! fallback, not the path.
//!
//! Ships in two forms off this one library:
//! - the **headless CLI** (`src/main.rs`) for real deployments — VPS,
//!   container, a spare machine on the tailnet; env-configured, TLS-capable.
//! - the **embedded host** ([`spawn_host`]) — the Pings desktop app runs the
//!   same server in-process behind an Options toggle, so any teammate can
//!   *be* the server without installing anything.

pub mod push;

use crate::push::{PushKind, PushNote, PushSender};
use axum::extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

/// Same staleness window as the desktop peer table: a peer that hasn't
/// re-registered in 15 minutes drops off the roster.
const PEER_STALE_MS: u64 = 900_000;
pub const DEFAULT_ADDR: &str = "0.0.0.0:43217";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RosterPeer {
    peer_id: String,
    #[serde(default)]
    name: String,
    #[serde(default = "default_kind")]
    kind: String,
    ip: String,
    #[serde(default)]
    port: u16,
    /// Server-stamped on register; clients feed it straight into their
    /// presence logic.
    #[serde(default)]
    last_seen: u64,
}

fn default_kind() -> String {
    "human".to_string()
}

/// An enrolled device. Only the token's hash is stored — a leaked state file
/// doesn't leak credentials.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Device {
    peer_id: String,
    #[serde(default)]
    name: String,
    token_hash: String,
    enrolled_at: u64,
    /// Push registration ("apns" | "fcm"), set by `/v1/push-token`. Optional
    /// with skip-if-none so state files from before push support round-trip
    /// byte-identical.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    push_platform: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    push_token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PushTokenRequest {
    peer_id: String,
    platform: String,
    push_token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnrollRequest {
    peer_id: String,
    #[serde(default)]
    name: String,
}

/// A relay frame from a client: route `payload` to peer `to` on `channel`.
/// The payload is opaque to the server.
#[derive(Deserialize)]
struct RelayFrame {
    to: String,
    channel: String,
    payload: serde_json::Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PeersResponse {
    peers: Vec<RosterPeer>,
}

#[derive(Clone)]
pub struct AppState {
    team_key: Arc<String>,
    roster: Arc<Mutex<HashMap<String, RosterPeer>>>,
    devices: Arc<Mutex<HashMap<String, Device>>>,
    /// peerId -> outbound frame queue of that peer's live WebSocket.
    conns: Arc<Mutex<HashMap<String, UnboundedSender<String>>>>,
    state_file: Option<PathBuf>,
    started_at: u64,
    /// Push gateway for frames the relay can't deliver. `None` (the default)
    /// means exactly the pre-push behavior.
    push: Option<Arc<dyn PushSender>>,
}

impl AppState {
    /// Build server state, loading any previously enrolled devices from the
    /// state file.
    pub fn new(team_key: String, state_file: Option<PathBuf>) -> Self {
        let state = Self {
            team_key: Arc::new(team_key),
            roster: Arc::new(Mutex::new(HashMap::new())),
            devices: Arc::new(Mutex::new(HashMap::new())),
            conns: Arc::new(Mutex::new(HashMap::new())),
            state_file,
            started_at: now_millis(),
            push: None,
        };
        state.load_devices();
        state
    }

    /// Attach a push gateway — undeliverable relay frames to peers with a
    /// registered push token become platform pushes.
    pub fn with_push_sender(mut self, sender: Arc<dyn PushSender>) -> Self {
        self.push = Some(sender);
        self
    }

    pub fn roster_count(&self) -> usize {
        self.roster.lock().map(|r| r.len()).unwrap_or(0)
    }

    pub fn device_count(&self) -> usize {
        self.devices.lock().map(|d| d.len()).unwrap_or(0)
    }

    pub fn relay_connection_count(&self) -> usize {
        self.conns.lock().map(|c| c.len()).unwrap_or(0)
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Constant-time comparison — a plain `==` short-circuits on the first
/// differing byte, which leaks how much of a guessed secret was right.
fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
}

impl AppState {
    fn is_team_key(&self, token: &str) -> bool {
        ct_eq(&self.team_key, token)
    }

    /// Which enrolled device does this token belong to?
    fn device_for_token(&self, token: &str) -> Option<String> {
        let hash = sha256_hex(token);
        let devices = self.devices.lock().ok()?;
        devices
            .values()
            .find(|d| ct_eq(&d.token_hash, &hash))
            .map(|d| d.peer_id.clone())
    }

    /// Register/list/deregister accept a device token or the team key (root).
    fn authorized(&self, headers: &HeaderMap) -> bool {
        bearer(headers)
            .map(|t| self.is_team_key(t) || self.device_for_token(t).is_some())
            .unwrap_or(false)
    }

    /// Persist enrolled devices (best-effort — enrollment still works
    /// in-memory without a state file, it just doesn't survive restarts).
    fn save_devices(&self) {
        let Some(path) = &self.state_file else {
            return;
        };
        let Ok(devices) = self.devices.lock() else {
            return;
        };
        let all: Vec<&Device> = devices.values().collect();
        if let Ok(bytes) = serde_json::to_vec_pretty(&all) {
            if let Err(err) = std::fs::write(path, bytes) {
                eprintln!("pings-dispatch: cannot write state file: {err}");
            }
        }
    }

    fn load_devices(&self) {
        let Some(path) = &self.state_file else {
            return;
        };
        let Ok(text) = std::fs::read_to_string(path) else {
            return;
        };
        if let Ok(all) = serde_json::from_str::<Vec<Device>>(&text) {
            if let Ok(mut devices) = self.devices.lock() {
                *devices = all.into_iter().map(|d| (d.peer_id.clone(), d)).collect();
            }
        }
    }
}

/// Drop roster entries that stopped re-registering.
fn prune_locked(roster: &mut HashMap<String, RosterPeer>, now: u64) {
    roster.retain(|_, p| now.saturating_sub(p.last_seen) <= PEER_STALE_MS);
}

// ---------------------------------------------------------------- handlers

/// Trade the team key for a per-device token. Re-enrolling the same peerId
/// rotates its token (the old one stops working).
async fn enroll(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<EnrollRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let key_ok = bearer(&headers).map(|t| state.is_team_key(t)).unwrap_or(false);
    if !key_ok {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let peer_id = req.peer_id.trim().to_string();
    if peer_id.is_empty() {
        return Err(StatusCode::UNPROCESSABLE_ENTITY);
    }
    // Two UUIDs' worth of entropy, hex-encoded.
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    {
        let mut devices = state
            .devices
            .lock()
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        devices.insert(
            peer_id.clone(),
            Device {
                peer_id,
                name: req.name.trim().to_string(),
                token_hash: sha256_hex(&token),
                enrolled_at: now_millis(),
                // Re-enrolling resets push registration too — the app
                // re-POSTs /v1/push-token at every session start.
                push_platform: None,
                push_token: None,
            },
        );
    }
    state.save_devices();
    Ok(Json(serde_json::json!({ "deviceToken": token })))
}

/// Attach a platform push token to the calling device. Device-token auth
/// only — a push token routes alerts to a device's mailbox, and the
/// enrollment secret shouldn't be able to redirect someone else's.
async fn push_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<PushTokenRequest>,
) -> StatusCode {
    let Some(caller) = bearer(&headers).and_then(|t| state.device_for_token(t)) else {
        return StatusCode::UNAUTHORIZED;
    };
    if req.peer_id.trim() != caller {
        return StatusCode::FORBIDDEN;
    }
    let platform = req.platform.trim();
    let token = req.push_token.trim();
    if !matches!(platform, "apns" | "fcm") || token.is_empty() {
        return StatusCode::UNPROCESSABLE_ENTITY;
    }
    {
        let Ok(mut devices) = state.devices.lock() else {
            return StatusCode::INTERNAL_SERVER_ERROR;
        };
        let Some(device) = devices.get_mut(&caller) else {
            return StatusCode::UNAUTHORIZED;
        };
        device.push_platform = Some(platform.to_string());
        device.push_token = Some(token.to_string());
    }
    state.save_devices();
    StatusCode::NO_CONTENT
}

/// Admin: list enrolled devices (team key only). Token hashes stay private.
async fn list_devices(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let key_ok = bearer(&headers).map(|t| state.is_team_key(t)).unwrap_or(false);
    if !key_ok {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let devices = state.devices.lock().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut list: Vec<serde_json::Value> = devices
        .values()
        .map(|d| {
            serde_json::json!({
                "peerId": d.peer_id,
                "name": d.name,
                "enrolledAt": d.enrolled_at,
            })
        })
        .collect();
    list.sort_by_key(|d| d["peerId"].as_str().unwrap_or_default().to_string());
    Ok(Json(serde_json::json!({ "devices": list })))
}

/// Admin: revoke a device (team key only). Kills its token, roster entry,
/// and live relay connection in one stroke.
async fn revoke_device(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(peer_id): Path<String>,
) -> StatusCode {
    let key_ok = bearer(&headers).map(|t| state.is_team_key(t)).unwrap_or(false);
    if !key_ok {
        return StatusCode::UNAUTHORIZED;
    }
    let peer_id = peer_id.trim();
    if let Ok(mut devices) = state.devices.lock() {
        devices.remove(peer_id);
    }
    if let Ok(mut roster) = state.roster.lock() {
        roster.remove(peer_id);
    }
    if let Ok(mut conns) = state.conns.lock() {
        conns.remove(peer_id); // dropping the sender closes the socket task
    }
    state.save_devices();
    StatusCode::NO_CONTENT
}

/// Register is the heartbeat: an idempotent upsert stamped with the server's
/// clock. Clients call it every heartbeat interval.
async fn register(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(mut peer): Json<RosterPeer>,
) -> StatusCode {
    if !state.authorized(&headers) {
        return StatusCode::UNAUTHORIZED;
    }
    peer.peer_id = peer.peer_id.trim().to_string();
    peer.ip = peer.ip.trim().to_string();
    if peer.peer_id.is_empty() || peer.ip.is_empty() {
        return StatusCode::UNPROCESSABLE_ENTITY;
    }
    peer.last_seen = now_millis();
    if let Ok(mut roster) = state.roster.lock() {
        roster.insert(peer.peer_id.clone(), peer);
    }
    StatusCode::NO_CONTENT
}

async fn list_peers(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<PeersResponse>, StatusCode> {
    if !state.authorized(&headers) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let mut peers = {
        let mut roster = state.roster.lock().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        prune_locked(&mut roster, now_millis());
        roster.values().cloned().collect::<Vec<_>>()
    };
    peers.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(Json(PeersResponse { peers }))
}

async fn deregister(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(peer_id): Path<String>,
) -> StatusCode {
    if !state.authorized(&headers) {
        return StatusCode::UNAUTHORIZED;
    }
    if let Ok(mut roster) = state.roster.lock() {
        roster.remove(peer_id.trim());
    }
    StatusCode::NO_CONTENT
}

/// Unauthenticated liveness probe — reveals nothing but the version.
async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "app": "pings-dispatch",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

/// Admin: server vitals for the dashboard (team key only).
async fn admin_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let key_ok = bearer(&headers).map(|t| state.is_team_key(t)).unwrap_or(false);
    if !key_ok {
        return Err(StatusCode::UNAUTHORIZED);
    }
    // Prune first so the roster count matches what /v1/peers would say.
    if let Ok(mut roster) = state.roster.lock() {
        prune_locked(&mut roster, now_millis());
    }
    Ok(Json(serde_json::json!({
        "app": "pings-dispatch",
        "version": env!("CARGO_PKG_VERSION"),
        "startedAt": state.started_at,
        "rosterCount": state.roster_count(),
        "deviceCount": state.device_count(),
        "relayConnections": state.relay_connection_count(),
    })))
}

/// The admin dashboard — a single self-contained page baked into the binary.
async fn admin_page() -> axum::response::Html<&'static str> {
    axum::response::Html(include_str!("admin.html"))
}

/// Pings Go! — the mobile companion, served straight from the server so a
/// phone needs nothing but a browser (and "Add to Home Screen" makes it an
/// app). A single self-contained page plus the PWA fittings below.
async fn go_page() -> axum::response::Html<&'static str> {
    axum::response::Html(include_str!("go.html"))
}

async fn go_manifest() -> ([(&'static str, &'static str); 1], &'static str) {
    (
        [("content-type", "application/manifest+json")],
        include_str!("go-manifest.json"),
    )
}

async fn go_service_worker() -> ([(&'static str, &'static str); 1], &'static str) {
    ([("content-type", "text/javascript")], include_str!("go-sw.js"))
}

async fn go_icon_192() -> ([(&'static str, &'static str); 1], &'static [u8]) {
    ([("content-type", "image/png")], include_bytes!("go-icon-192.png"))
}

async fn go_icon_512() -> ([(&'static str, &'static str); 1], &'static [u8]) {
    ([("content-type", "image/png")], include_bytes!("go-icon-512.png"))
}

// ---------------------------------------------------------------- relay

/// The relay socket. Device-token auth only — the team key is for enrollment
/// and admin, not for impersonating a peer on the wire. The token arrives as
/// a Bearer header (native clients) or a `?token=` query parameter (browser
/// WebSocket API can't set headers — used by Pings Go!).
async fn ws_upgrade(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Query(params): axum::extract::Query<HashMap<String, String>>,
    upgrade: WebSocketUpgrade,
) -> Result<Response, StatusCode> {
    let token = bearer(&headers)
        .map(str::to_string)
        .or_else(|| params.get("token").cloned());
    let peer_id = token
        .and_then(|t| state.device_for_token(&t))
        .ok_or(StatusCode::UNAUTHORIZED)?;
    Ok(upgrade.on_upgrade(move |socket| relay_session(state, peer_id, socket)))
}

/// One connected client: pump queued outbound frames to it, and route every
/// frame it sends to the recipient's queue. Content-blind by design.
async fn relay_session(state: AppState, peer_id: String, socket: WebSocket) {
    let (tx, mut rx) = unbounded_channel::<String>();
    if let Ok(mut conns) = state.conns.lock() {
        conns.insert(peer_id.clone(), tx);
    }

    let (mut sink, mut stream) = socket.split();
    loop {
        tokio::select! {
            queued = rx.recv() => {
                let Some(frame) = queued else { break }; // revoked or replaced
                if sink.send(WsMessage::Text(frame.into())).await.is_err() {
                    break;
                }
            }
            incoming = stream.next() => {
                match incoming {
                    Some(Ok(WsMessage::Text(text))) => {
                        let Ok(frame) = serde_json::from_str::<RelayFrame>(&text) else {
                            continue;
                        };
                        let delivered = state
                            .conns
                            .lock()
                            .ok()
                            .and_then(|conns| {
                                conns.get(frame.to.trim()).map(|peer_tx| {
                                    let forward = serde_json::json!({
                                        "channel": frame.channel,
                                        "payload": frame.payload,
                                    });
                                    peer_tx.send(forward.to_string()).is_ok()
                                })
                            })
                            .unwrap_or(false);
                        if !delivered {
                            // Best-effort notice; sender-side delivery states
                            // (acks) remain the source of truth.
                            let notice = serde_json::json!({
                                "channel": "system",
                                "payload": { "type": "undeliverable", "to": frame.to },
                            });
                            if let Ok(conns) = state.conns.lock() {
                                if let Some(self_tx) = conns.get(&peer_id) {
                                    let _ = self_tx.send(notice.to_string());
                                }
                            }
                            // No live socket, but a push mailbox: wake the
                            // recipient's phone. Only the channel and the
                            // sender's chosen display name leave the server;
                            // the notice above still went to the sender, and
                            // no ack is faked.
                            if let Some(push) = &state.push {
                                let kind = match frame.channel.as_str() {
                                    "ping" => Some(PushKind::Ping),
                                    "chat" => Some(PushKind::Chat),
                                    _ => None,
                                };
                                let token = state.devices.lock().ok().and_then(|devices| {
                                    devices
                                        .get(frame.to.trim())
                                        .filter(|d| d.push_platform.as_deref() == Some("apns"))
                                        .and_then(|d| d.push_token.clone())
                                });
                                if let (Some(kind), Some(push_token)) = (kind, token) {
                                    let sender_name = frame
                                        .payload
                                        .get("from")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("Pings")
                                        .to_string();
                                    push.send(PushNote { push_token, kind, sender_name });
                                }
                            }
                        }
                    }
                    Some(Ok(WsMessage::Close(_))) | Some(Err(_)) | None => break,
                    Some(Ok(_)) => {} // ignore binary/ping/pong payloads
                }
            }
        }
    }

    // Only remove our own registration — a reconnect may already have
    // replaced it with a fresh sender.
    if let Ok(mut conns) = state.conns.lock() {
        if conns.get(&peer_id).map(|tx| tx.is_closed()).unwrap_or(false) {
            conns.remove(&peer_id);
        }
    }
}

// ---------------------------------------------------------------- boot

/// CORS for the native Go! shells: their webviews live on an app origin
/// (`tauri://localhost`), not ours, so every /v1 fetch is cross-origin.
/// Wildcard is safe here — auth is bearer tokens, never cookies, so there's
/// nothing a foreign page could ride.
async fn cors(
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    use axum::response::IntoResponse;
    fn add_headers(headers: &mut HeaderMap) {
        let pairs = [
            ("access-control-allow-origin", "*"),
            ("access-control-allow-methods", "GET, POST, DELETE, OPTIONS"),
            ("access-control-allow-headers", "authorization, content-type"),
            ("access-control-max-age", "86400"),
        ];
        for (name, value) in pairs {
            if let Ok(value) = value.parse() {
                headers.insert(name, value);
            }
        }
    }
    if req.method() == axum::http::Method::OPTIONS {
        let mut res = StatusCode::NO_CONTENT.into_response();
        add_headers(res.headers_mut());
        return res;
    }
    let mut res = next.run(req).await;
    add_headers(res.headers_mut());
    res
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/", get(|| async { axum::response::Redirect::temporary("/go") }))
        .route("/admin", get(admin_page))
        .route("/go", get(go_page))
        .route("/go/manifest.webmanifest", get(go_manifest))
        .route("/go/sw.js", get(go_service_worker))
        .route("/go/icon-192.png", get(go_icon_192))
        .route("/go/icon-512.png", get(go_icon_512))
        .route("/v1/health", get(health))
        .route("/v1/status", get(admin_status))
        .route("/v1/enroll", post(enroll))
        .route("/v1/push-token", post(push_token))
        .route("/v1/devices", get(list_devices))
        .route("/v1/devices/{peer_id}", delete(revoke_device))
        .route("/v1/register", post(register))
        .route("/v1/peers", get(list_peers))
        .route("/v1/peers/{peer_id}", delete(deregister))
        .route("/v1/ws", get(ws_upgrade))
        .layer(axum::middleware::from_fn(cors))
        .with_state(state)
}

// ---------------------------------------------------------------- embedded host

/// Where an embedded host is in its lifecycle.
#[derive(Clone, Debug, PartialEq)]
pub enum HostStatus {
    Starting,
    Running { addr: String },
    Failed { error: String },
    Stopped,
}

/// A handle to an embedded Dispatch server running on its own thread.
/// Cloneable; dropping it does NOT stop the server — call [`HostHandle::stop`].
#[derive(Clone)]
pub struct HostHandle {
    state: AppState,
    status: Arc<Mutex<HostStatus>>,
    shutdown: tokio::sync::watch::Sender<bool>,
}

impl HostHandle {
    pub fn status(&self) -> HostStatus {
        self.status
            .lock()
            .map(|s| s.clone())
            .unwrap_or(HostStatus::Failed { error: "status-poisoned".into() })
    }

    pub fn roster_count(&self) -> usize {
        self.state.roster_count()
    }

    pub fn device_count(&self) -> usize {
        self.state.device_count()
    }

    /// Graceful shutdown; in-flight requests finish, the port frees.
    pub fn stop(&self) {
        let _ = self.shutdown.send(true);
    }
}

/// Run a Dispatch server on a background thread (plain HTTP — embedded hosts
/// serve a LAN/tailnet; use the CLI for TLS deployments). Returns immediately;
/// poll [`HostHandle::status`] for bind success or failure.
pub fn spawn_host(team_key: String, addr: String, state_file: Option<PathBuf>) -> HostHandle {
    let state = AppState::new(team_key, state_file);
    let status = Arc::new(Mutex::new(HostStatus::Starting));
    let (shutdown_tx, mut shutdown_rx) = tokio::sync::watch::channel(false);
    let handle = HostHandle {
        state: state.clone(),
        status: status.clone(),
        shutdown: shutdown_tx,
    };

    std::thread::spawn(move || {
        let set_status = |value: HostStatus| {
            if let Ok(mut s) = status.lock() {
                *s = value;
            }
        };
        let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
            Ok(rt) => rt,
            Err(err) => {
                set_status(HostStatus::Failed { error: format!("runtime: {err}") });
                return;
            }
        };
        runtime.block_on(async {
            let listener = match tokio::net::TcpListener::bind(&addr).await {
                Ok(l) => l,
                Err(err) => {
                    set_status(HostStatus::Failed { error: err.to_string() });
                    return;
                }
            };
            let bound = listener
                .local_addr()
                .map(|a| a.to_string())
                .unwrap_or_else(|_| addr.clone());
            set_status(HostStatus::Running { addr: bound });
            let result = axum::serve(listener, router(state))
                .with_graceful_shutdown(async move {
                    let _ = shutdown_rx.changed().await;
                })
                .await;
            match result {
                Ok(()) => set_status(HostStatus::Stopped),
                Err(err) => set_status(HostStatus::Failed { error: err.to_string() }),
            }
        });
    });

    handle
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn test_state() -> AppState {
        AppState::new("sesame".to_string(), None)
    }

    fn json_req(method: &str, uri: &str, auth: Option<&str>, body: &str) -> Request<Body> {
        let mut req = Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json");
        if let Some(key) = auth {
            req = req.header("authorization", format!("Bearer {key}"));
        }
        req.body(Body::from(body.to_string())).unwrap()
    }

    async fn body_json(res: Response) -> serde_json::Value {
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[test]
    fn embedded_host_starts_serves_and_stops() {
        let handle = spawn_host("host-key".to_string(), "127.0.0.1:0".to_string(), None);

        // Wait for the bind to resolve (Starting -> Running/Failed).
        let mut addr = None;
        for _ in 0..100 {
            match handle.status() {
                HostStatus::Running { addr: a } => {
                    addr = Some(a);
                    break;
                }
                HostStatus::Failed { error } => panic!("host failed to start: {error}"),
                _ => std::thread::sleep(std::time::Duration::from_millis(20)),
            }
        }
        let addr = addr.expect("host reached Running within 2s");

        // Plain blocking HTTP/1.0 request — the embedded server answers health.
        use std::io::{Read, Write};
        let mut stream = std::net::TcpStream::connect(&addr).unwrap();
        stream
            .write_all(b"GET /v1/health HTTP/1.0\r\nHost: localhost\r\n\r\n")
            .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        assert!(response.contains("200"), "health responds: {response}");
        assert!(response.contains("pings-dispatch"));

        // Graceful stop frees the port.
        handle.stop();
        for _ in 0..100 {
            if handle.status() == HostStatus::Stopped {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert_eq!(handle.status(), HostStatus::Stopped);
        assert!(
            std::net::TcpListener::bind(&addr).is_ok(),
            "port released after stop"
        );
    }

    #[test]
    fn ct_eq_is_exact() {
        assert!(ct_eq("sesame", "sesame"));
        assert!(!ct_eq("sesame", "sesamE"));
        assert!(!ct_eq("sesame", "sesam"));
        assert!(!ct_eq("sesame", ""));
    }

    #[test]
    fn prune_drops_only_stale_entries() {
        let mut roster = HashMap::new();
        let now = 2_000_000u64;
        for (id, last_seen) in [("fresh", now - 1_000), ("stale", now - PEER_STALE_MS - 1)] {
            roster.insert(
                id.to_string(),
                RosterPeer {
                    peer_id: id.to_string(),
                    name: id.to_string(),
                    kind: "human".to_string(),
                    ip: "100.64.0.9".to_string(),
                    port: 43210,
                    last_seen,
                },
            );
        }
        prune_locked(&mut roster, now);
        assert!(roster.contains_key("fresh"));
        assert!(!roster.contains_key("stale"));
    }

    #[tokio::test]
    async fn enroll_issues_working_revocable_tokens() {
        let state = test_state();

        // Enrollment needs the team key.
        let res = router(state.clone())
            .oneshot(json_req("POST", "/v1/enroll", Some("guess"), r#"{"peerId":"dev-1"}"#))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

        let res = router(state.clone())
            .oneshot(json_req(
                "POST",
                "/v1/enroll",
                Some("sesame"),
                r#"{"peerId":"dev-1","name":"Zach's MBP"}"#,
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let token = body_json(res).await["deviceToken"].as_str().unwrap().to_string();
        assert_eq!(token.len(), 64);

        // The device token registers; a made-up one doesn't.
        let peer = r#"{"peerId":"dev-1","name":"Zach","ip":"100.64.0.7","port":43210}"#;
        let res = router(state.clone())
            .oneshot(json_req("POST", "/v1/register", Some(&token), peer))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
        let res = router(state.clone())
            .oneshot(json_req("POST", "/v1/register", Some("bogus-token"), peer))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

        // Revoke → same token now rejected, roster entry gone.
        let res = router(state.clone())
            .oneshot(json_req("DELETE", "/v1/devices/dev-1", Some("sesame"), ""))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
        let res = router(state.clone())
            .oneshot(json_req("POST", "/v1/register", Some(&token), peer))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn reenroll_rotates_the_token() {
        let state = test_state();
        let first = body_json(
            router(state.clone())
                .oneshot(json_req("POST", "/v1/enroll", Some("sesame"), r#"{"peerId":"d"}"#))
                .await
                .unwrap(),
        )
        .await["deviceToken"]
            .as_str()
            .unwrap()
            .to_string();
        let second = body_json(
            router(state.clone())
                .oneshot(json_req("POST", "/v1/enroll", Some("sesame"), r#"{"peerId":"d"}"#))
                .await
                .unwrap(),
        )
        .await["deviceToken"]
            .as_str()
            .unwrap()
            .to_string();
        assert_ne!(first, second);
        assert!(state.device_for_token(&second).is_some());
        assert!(state.device_for_token(&first).is_none(), "old token stops working");
    }

    #[tokio::test]
    async fn admin_page_is_served_and_status_needs_the_key() {
        // The dashboard shell is public (it holds no data)...
        let res = router(test_state())
            .oneshot(Request::builder().uri("/admin").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        let page = String::from_utf8_lossy(&bytes);
        assert!(page.contains("Pings Dispatch"));
        assert!(page.contains("Enrolled devices"));

        // ...but the vitals endpoint is team-key only.
        let res = router(test_state())
            .oneshot(json_req("GET", "/v1/status", Some("guess"), ""))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
        let res = router(test_state())
            .oneshot(json_req("GET", "/v1/status", Some("sesame"), ""))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let status = body_json(res).await;
        assert_eq!(status["app"], "pings-dispatch");
        assert_eq!(status["rosterCount"], 0);
        assert_eq!(status["relayConnections"], 0);
        assert!(status["startedAt"].as_u64().unwrap() > 0);
    }

    #[tokio::test]
    async fn go_app_and_pwa_fittings_are_served() {
        for (path, marker) in [
            ("/go", "Pings Go!"),
            ("/go/manifest.webmanifest", "\"start_url\": \"/go\""),
            ("/go/sw.js", "pings-go"),
        ] {
            let res = router(test_state())
                .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(res.status(), StatusCode::OK, "{path}");
            let bytes = res.into_body().collect().await.unwrap().to_bytes();
            assert!(
                String::from_utf8_lossy(&bytes).contains(marker),
                "{path} contains {marker}"
            );
        }
        // Icons are binary PNGs.
        let res = router(test_state())
            .oneshot(Request::builder().uri("/go/icon-192.png").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(&bytes[1..4], b"PNG");
    }

    #[tokio::test]
    async fn ws_accepts_token_as_query_param() {
        // Browsers can't set WS headers — the query param must authenticate,
        // and a junk query token must not.
        let state = test_state();
        let token = body_json(
            router(state.clone())
                .oneshot(json_req("POST", "/v1/enroll", Some("sesame"), r#"{"peerId":"phone"}"#))
                .await
                .unwrap(),
        )
        .await["deviceToken"]
            .as_str()
            .unwrap()
            .to_string();

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = router(state.clone());
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let good = tokio_tungstenite::connect_async(format!("ws://{addr}/v1/ws?token={token}")).await;
        assert!(good.is_ok(), "query-param token connects");
        let bad = tokio_tungstenite::connect_async(format!("ws://{addr}/v1/ws?token=junk")).await;
        assert!(bad.is_err(), "junk query token rejected");
    }

    #[tokio::test]
    async fn team_key_still_registers_and_lists() {
        let state = test_state();
        let peer = r#"{"peerId":"abc","name":"Zach","ip":"100.64.0.7","port":43210}"#;
        let res = router(state.clone())
            .oneshot(json_req("POST", "/v1/register", Some("sesame"), peer))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
        let res = router(state.clone())
            .oneshot(json_req("GET", "/v1/peers", Some("sesame"), ""))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let peers = body_json(res).await["peers"].as_array().unwrap().len();
        assert_eq!(peers, 1);
    }

    #[tokio::test]
    async fn cors_lets_the_native_shells_in() {
        // Preflight (what WKWebView sends before a cross-origin POST with
        // an Authorization header) answers 204 with the allow headers…
        let res = router(test_state())
            .oneshot(json_req("OPTIONS", "/v1/enroll", None, ""))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
        assert_eq!(res.headers()["access-control-allow-origin"], "*");
        assert!(res.headers()["access-control-allow-headers"]
            .to_str()
            .unwrap()
            .contains("authorization"));

        // …and every normal response carries the allow-origin header.
        let res = router(test_state())
            .oneshot(Request::builder().uri("/v1/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.headers()["access-control-allow-origin"], "*");
    }

    #[tokio::test]
    async fn push_token_requires_matching_device_token() {
        let state = test_state();
        let token = body_json(
            router(state.clone())
                .oneshot(json_req("POST", "/v1/enroll", Some("sesame"), r#"{"peerId":"phone"}"#))
                .await
                .unwrap(),
        )
        .await["deviceToken"]
            .as_str()
            .unwrap()
            .to_string();

        let body = r#"{"peerId":"phone","platform":"apns","pushToken":"tok-1"}"#;

        // The team key must NOT set push tokens — a push token routes alerts
        // to a device's mailbox, only that device may point it somewhere.
        let res = router(state.clone())
            .oneshot(json_req("POST", "/v1/push-token", Some("sesame"), body))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

        // A device can't set someone else's token either.
        let other = r#"{"peerId":"laptop","platform":"apns","pushToken":"tok-1"}"#;
        let res = router(state.clone())
            .oneshot(json_req("POST", "/v1/push-token", Some(&token), other))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::FORBIDDEN);

        // Junk platform rejected.
        let junk = r#"{"peerId":"phone","platform":"smoke-signal","pushToken":"tok-1"}"#;
        let res = router(state.clone())
            .oneshot(json_req("POST", "/v1/push-token", Some(&token), junk))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNPROCESSABLE_ENTITY);

        // The device's own token works.
        let res = router(state.clone())
            .oneshot(json_req("POST", "/v1/push-token", Some(&token), body))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
        let devices = state.devices.lock().unwrap();
        let device = devices.get("phone").unwrap();
        assert_eq!(device.push_platform.as_deref(), Some("apns"));
        assert_eq!(device.push_token.as_deref(), Some("tok-1"));
    }

    #[tokio::test]
    async fn push_fields_persist_and_legacy_state_files_load() {
        let dir = std::env::temp_dir().join(format!("dispatch-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.json");

        // A state file from before push support — no push fields at all.
        std::fs::write(
            &path,
            r#"[{"peerId":"old","name":"Old Phone","tokenHash":"abc","enrolledAt":1}]"#,
        )
        .unwrap();
        let state = AppState::new("sesame".to_string(), Some(path.clone()));
        assert_eq!(state.device_count(), 1, "legacy state file loads");

        // Devices without push tokens serialize without the keys.
        state.save_devices();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("pushToken"), "no push keys for tokenless devices");

        // Enroll + set a push token → both fields round-trip the file.
        let token = body_json(
            router(state.clone())
                .oneshot(json_req("POST", "/v1/enroll", Some("sesame"), r#"{"peerId":"new"}"#))
                .await
                .unwrap(),
        )
        .await["deviceToken"]
            .as_str()
            .unwrap()
            .to_string();
        let body = r#"{"peerId":"new","platform":"apns","pushToken":"tok-9"}"#;
        let res = router(state.clone())
            .oneshot(json_req("POST", "/v1/push-token", Some(&token), body))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NO_CONTENT);

        let reloaded = AppState::new("sesame".to_string(), Some(path.clone()));
        let devices = reloaded.devices.lock().unwrap();
        let device = devices.get("new").unwrap();
        assert_eq!(device.push_platform.as_deref(), Some("apns"));
        assert_eq!(device.push_token.as_deref(), Some("tok-9"));
        drop(devices);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(feature = "push")]
    #[test]
    fn apns_payloads_match_the_simctl_fixtures() {
        // One source of truth: the unit test and `xcrun simctl push` (Phase 3
        // of the Go! native plan) use the same fixture files.
        for (kind, fixture) in [
            (PushKind::Ping, include_str!("../tests/fixtures/apns-ping.json")),
            (PushKind::Chat, include_str!("../tests/fixtures/apns-chat.json")),
        ] {
            let expected: serde_json::Value = serde_json::from_str(fixture).unwrap();
            assert_eq!(push::payload_json(kind, "Zach"), expected);
        }
    }

    #[tokio::test]
    async fn relay_routes_between_connected_clients() {
        // Full integration: real listener, two WS clients, one frame across.
        let state = test_state();

        // Enroll two devices over the router.
        let mut tokens = Vec::new();
        for id in ["alpha", "beta"] {
            let res = router(state.clone())
                .oneshot(json_req(
                    "POST",
                    "/v1/enroll",
                    Some("sesame"),
                    &format!(r#"{{"peerId":"{id}"}}"#),
                ))
                .await
                .unwrap();
            tokens.push(body_json(res).await["deviceToken"].as_str().unwrap().to_string());
        }

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = router(state.clone());
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let connect = |token: String| async move {
            let req = tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(
                format!("ws://{addr}/v1/ws"),
            )
            .map(|mut r| {
                r.headers_mut().insert(
                    "authorization",
                    format!("Bearer {token}").parse().unwrap(),
                );
                r
            })
            .unwrap();
            tokio_tungstenite::connect_async(req).await.unwrap().0
        };

        let mut alpha = connect(tokens[0].clone()).await;
        let mut beta = connect(tokens[1].clone()).await;

        // A bogus token must not connect.
        {
            let req = tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(
                format!("ws://{addr}/v1/ws"),
            )
            .map(|mut r| {
                r.headers_mut()
                    .insert("authorization", "Bearer nope".parse().unwrap());
                r
            })
            .unwrap();
            assert!(tokio_tungstenite::connect_async(req).await.is_err());
        }

        // alpha -> beta
        alpha
            .send(tokio_tungstenite::tungstenite::Message::Text(
                r#"{"to":"beta","channel":"chat","payload":{"kind":"private","message":"hi"}}"#.into(),
            ))
            .await
            .unwrap();
        let received = tokio::time::timeout(std::time::Duration::from_secs(5), beta.next())
            .await
            .expect("beta received within 5s")
            .unwrap()
            .unwrap();
        let parsed: serde_json::Value =
            serde_json::from_str(received.to_text().unwrap()).unwrap();
        assert_eq!(parsed["channel"], "chat");
        assert_eq!(parsed["payload"]["message"], "hi");

        // Frame to a peer with no live socket → undeliverable notice back.
        alpha
            .send(tokio_tungstenite::tungstenite::Message::Text(
                r#"{"to":"ghost","channel":"chat","payload":{}}"#.into(),
            ))
            .await
            .unwrap();
        let notice = tokio::time::timeout(std::time::Duration::from_secs(5), alpha.next())
            .await
            .expect("alpha notified within 5s")
            .unwrap()
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(notice.to_text().unwrap()).unwrap();
        assert_eq!(parsed["channel"], "system");
        assert_eq!(parsed["payload"]["type"], "undeliverable");
    }

    /// Records every note instead of pushing — the assertion surface for the
    /// undeliverable→push hook.
    struct MockPush(Mutex<Vec<PushNote>>);

    impl PushSender for MockPush {
        fn send(&self, note: PushNote) {
            self.0.lock().unwrap().push(note);
        }
    }

    #[tokio::test]
    async fn undeliverable_frames_push_when_a_token_is_registered() {
        let mock = Arc::new(MockPush(Mutex::new(Vec::new())));
        let state = test_state().with_push_sender(mock.clone());

        // alpha is online; phone and mute are offline. phone registered a
        // push token, mute never did.
        let mut tokens = HashMap::new();
        for id in ["alpha", "phone", "mute"] {
            let res = router(state.clone())
                .oneshot(json_req(
                    "POST",
                    "/v1/enroll",
                    Some("sesame"),
                    &format!(r#"{{"peerId":"{id}"}}"#),
                ))
                .await
                .unwrap();
            let token = body_json(res).await["deviceToken"].as_str().unwrap().to_string();
            tokens.insert(id, token);
        }
        let res = router(state.clone())
            .oneshot(json_req(
                "POST",
                "/v1/push-token",
                Some(&tokens["phone"]),
                r#"{"peerId":"phone","platform":"apns","pushToken":"apns-tok-1"}"#,
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NO_CONTENT);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = router(state.clone());
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let (mut alpha, _) = tokio_tungstenite::connect_async(format!(
            "ws://{addr}/v1/ws?token={}",
            tokens["alpha"]
        ))
        .await
        .unwrap();

        // Helper: send a frame, then wait for the undeliverable notice so the
        // server has definitely processed the frame before we assert.
        type Ws = tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >;
        async fn send_and_bounce(ws: &mut Ws, frame: &str) {
            ws.send(tokio_tungstenite::tungstenite::Message::Text(frame.to_string().into()))
                .await
                .unwrap();
            let notice = tokio::time::timeout(std::time::Duration::from_secs(5), ws.next())
                .await
                .expect("undeliverable notice within 5s")
                .unwrap()
                .unwrap();
            let parsed: serde_json::Value = serde_json::from_str(notice.to_text().unwrap()).unwrap();
            assert_eq!(parsed["payload"]["type"], "undeliverable");
        }

        // Ping to the offline phone → time-sensitive push with sender name.
        send_and_bounce(
            &mut alpha,
            r#"{"to":"phone","channel":"ping","payload":{"from":"Zach","message":"meeting"}}"#,
        )
        .await;
        // Chat to the offline phone → normal push.
        send_and_bounce(
            &mut alpha,
            r#"{"to":"phone","channel":"chat","payload":{"from":"Zach","kind":"private","message":"hey"}}"#,
        )
        .await;
        // Offline peer with no push token → notice only, no push.
        send_and_bounce(
            &mut alpha,
            r#"{"to":"mute","channel":"ping","payload":{"from":"Zach"}}"#,
        )
        .await;
        // System-ish channel to the phone → no push either.
        send_and_bounce(
            &mut alpha,
            r#"{"to":"phone","channel":"presence","payload":{"from":"Zach"}}"#,
        )
        .await;

        let notes = mock.0.lock().unwrap();
        assert_eq!(notes.len(), 2, "only ping+chat to the push-registered peer");
        assert_eq!(notes[0].kind, PushKind::Ping);
        assert_eq!(notes[0].push_token, "apns-tok-1");
        assert_eq!(notes[0].sender_name, "Zach");
        assert_eq!(notes[1].kind, PushKind::Chat);
        drop(notes);

        // A frame the relay CAN deliver never pushes. beta connects live,
        // registers a push token, then alpha messages it.
        let res = router(state.clone())
            .oneshot(json_req(
                "POST",
                "/v1/enroll",
                Some("sesame"),
                r#"{"peerId":"beta"}"#,
            ))
            .await
            .unwrap();
        let beta_token = body_json(res).await["deviceToken"].as_str().unwrap().to_string();
        let res = router(state.clone())
            .oneshot(json_req(
                "POST",
                "/v1/push-token",
                Some(&beta_token),
                r#"{"peerId":"beta","platform":"apns","pushToken":"apns-tok-2"}"#,
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
        let (mut beta, _) =
            tokio_tungstenite::connect_async(format!("ws://{addr}/v1/ws?token={beta_token}"))
                .await
                .unwrap();
        alpha
            .send(tokio_tungstenite::tungstenite::Message::Text(
                r#"{"to":"beta","channel":"ping","payload":{"from":"Zach"}}"#.into(),
            ))
            .await
            .unwrap();
        let received = tokio::time::timeout(std::time::Duration::from_secs(5), beta.next())
            .await
            .expect("beta received within 5s")
            .unwrap()
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(received.to_text().unwrap()).unwrap();
        assert_eq!(parsed["channel"], "ping");
        assert_eq!(mock.0.lock().unwrap().len(), 2, "delivered frames never push");
    }
}

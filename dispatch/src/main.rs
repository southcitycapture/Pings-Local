//! Pings Dispatch — the team rendezvous server (phase D1).
//!
//! Replaces "shout on the local wire" with "ask a known address who's
//! around": clients POST themselves to `/v1/register` on the desktop's
//! heartbeat cadence and GET `/v1/peers` for the roster. Pings and chat still
//! flow directly peer-to-peer — Dispatch only introduces.
//!
//! Deliberately small for D1: in-memory roster, one shared team key, plain
//! HTTP. Deploy it on a tailnet and let WireGuard carry transport security;
//! TLS and per-device tokens arrive in D2 (see docs/DISPATCH-PLAN.md).
//!
//! Configuration (env):
//!   DISPATCH_TEAM_KEY  required — the shared secret clients present
//!   DISPATCH_ADDR      optional — listen address, default 0.0.0.0:43217

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

/// Same staleness window as the desktop peer table: a peer that hasn't
/// re-registered in 15 minutes drops off the roster.
const PEER_STALE_MS: u64 = 900_000;
const DEFAULT_ADDR: &str = "0.0.0.0:43217";

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
    /// presence logic (same field the desktop peer table keys presence off).
    #[serde(default)]
    last_seen: u64,
}

fn default_kind() -> String {
    "human".to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PeersResponse {
    peers: Vec<RosterPeer>,
}

#[derive(Clone)]
struct AppState {
    team_key: Arc<String>,
    roster: Arc<Mutex<HashMap<String, RosterPeer>>>,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Constant-time key comparison — a plain `==` short-circuits on the first
/// differing byte, which leaks how much of a guessed key was right.
fn key_matches(expected: &str, provided: &str) -> bool {
    let (a, b) = (expected.as_bytes(), provided.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn authorized(state: &AppState, headers: &HeaderMap) -> bool {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .is_some_and(|key| key_matches(&state.team_key, key))
}

/// Drop roster entries that stopped re-registering.
fn prune_locked(roster: &mut HashMap<String, RosterPeer>, now: u64) {
    roster.retain(|_, p| now.saturating_sub(p.last_seen) <= PEER_STALE_MS);
}

/// Register is the heartbeat: an idempotent upsert stamped with the server's
/// clock. Clients call it every heartbeat interval.
async fn register(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(mut peer): Json<RosterPeer>,
) -> StatusCode {
    if !authorized(&state, &headers) {
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
    if !authorized(&state, &headers) {
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
    if !authorized(&state, &headers) {
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

fn router(state: AppState) -> Router {
    Router::new()
        .route("/v1/health", get(health))
        .route("/v1/register", post(register))
        .route("/v1/peers", get(list_peers))
        .route("/v1/peers/{peer_id}", delete(deregister))
        .with_state(state)
}

#[tokio::main]
async fn main() {
    let team_key = match std::env::var("DISPATCH_TEAM_KEY") {
        Ok(key) if !key.trim().is_empty() => key.trim().to_string(),
        _ => {
            eprintln!("pings-dispatch: set DISPATCH_TEAM_KEY (the shared secret clients present)");
            std::process::exit(2);
        }
    };
    let addr = std::env::var("DISPATCH_ADDR").unwrap_or_else(|_| DEFAULT_ADDR.to_string());

    let state = AppState {
        team_key: Arc::new(team_key),
        roster: Arc::new(Mutex::new(HashMap::new())),
    };

    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(err) => {
            eprintln!("pings-dispatch: cannot bind {addr}: {err}");
            std::process::exit(1);
        }
    };
    println!("pings-dispatch v{} listening on {addr}", env!("CARGO_PKG_VERSION"));

    let server = axum::serve(listener, router(state));
    tokio::select! {
        result = server => {
            if let Err(err) = result {
                eprintln!("pings-dispatch: server error: {err}");
            }
        }
        _ = tokio::signal::ctrl_c() => {
            println!("pings-dispatch: shutting down");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn test_state() -> AppState {
        AppState {
            team_key: Arc::new("sesame".to_string()),
            roster: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn register_req(auth: Option<&str>, body: &str) -> Request<Body> {
        let mut req = Request::builder()
            .method("POST")
            .uri("/v1/register")
            .header("content-type", "application/json");
        if let Some(key) = auth {
            req = req.header("authorization", format!("Bearer {key}"));
        }
        req.body(Body::from(body.to_string())).unwrap()
    }

    #[test]
    fn key_compare_is_exact() {
        assert!(key_matches("sesame", "sesame"));
        assert!(!key_matches("sesame", "sesamE"));
        assert!(!key_matches("sesame", "sesam"));
        assert!(!key_matches("sesame", ""));
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
    async fn register_requires_auth_and_lists_back() {
        let state = test_state();
        let peer_json =
            r#"{"peerId":"abc-123","name":"Zach","kind":"human","ip":"100.64.0.7","port":43210}"#;

        // No auth → 401 and nothing stored.
        let res = router(state.clone())
            .oneshot(register_req(None, peer_json))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

        // Wrong key → 401.
        let res = router(state.clone())
            .oneshot(register_req(Some("guess"), peer_json))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

        // Right key → stored and listed with a server-stamped lastSeen.
        let res = router(state.clone())
            .oneshot(register_req(Some("sesame"), peer_json))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NO_CONTENT);

        let res = router(state.clone())
            .oneshot(
                Request::builder()
                    .uri("/v1/peers")
                    .header("authorization", "Bearer sesame")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let peers = parsed["peers"].as_array().unwrap();
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0]["peerId"], "abc-123");
        assert_eq!(peers[0]["ip"], "100.64.0.7");
        assert!(peers[0]["lastSeen"].as_u64().unwrap() > 0);
    }

    #[tokio::test]
    async fn register_rejects_missing_identity() {
        let res = router(test_state())
            .oneshot(register_req(Some("sesame"), r#"{"peerId":"  ","ip":"1.2.3.4"}"#))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }
}

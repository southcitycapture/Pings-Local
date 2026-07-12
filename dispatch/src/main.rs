//! The headless Dispatch CLI. All server logic lives in the library (also
//! embedded by the Pings desktop app's host mode); this binary just reads env
//! configuration and serves — plain HTTP for tailnet deployments, TLS when a
//! cert pair is provided.
//!
//! Configuration (env):
//!   DISPATCH_TEAM_KEY    required — enrollment secret (and root key)
//!   DISPATCH_ADDR        optional — listen address, default 0.0.0.0:43217
//!   DISPATCH_STATE_FILE  optional — JSON file persisting enrolled devices
//!                        across restarts (tokens survive; roster doesn't
//!                        need to — clients re-register within 30s)
//!   DISPATCH_TLS_CERT /  optional — PEM cert + key; both set = HTTPS/WSS,
//!   DISPATCH_TLS_KEY     neither = plain HTTP for tailnet deployments
//!   DISPATCH_APNS_KEY /  optional — all four set = APNs push for
//!   DISPATCH_APNS_KEY_ID /         undeliverable relay frames: path to the
//!   DISPATCH_APNS_TEAM_ID /        .p8 auth key, its key id, the Apple team
//!   DISPATCH_APNS_TOPIC            id, and the app bundle id. None = no push.
//!   DISPATCH_APNS_ENDPOINT optional — "sandbox" (dev-signed builds) or
//!                        "production" (TestFlight/App Store, the default)
//!   DISPATCH_PUSH_DEBUG  optional — "log" prints would-push lines instead of
//!                        calling Apple (end-to-end testing without a key)

use pings_dispatch::push::{ApnsConfig, ApnsPushSender, LoggingPushSender, PushSender};
use pings_dispatch::{router, AppState, DEFAULT_ADDR};
use std::path::PathBuf;
use std::sync::Arc;

/// Read the APNs env quartet: all set → a live APNs sender, none set → no
/// push, a partial set → configuration error (mirrors the TLS pairing rule).
/// `DISPATCH_PUSH_DEBUG=log` overrides with the logging sender.
fn push_sender_from_env() -> Option<Arc<dyn PushSender>> {
    if std::env::var("DISPATCH_PUSH_DEBUG").ok().as_deref() == Some("log") {
        println!("pings-dispatch: push debug — logging would-push lines, not calling Apple");
        return Some(Arc::new(LoggingPushSender));
    }
    let vars = [
        "DISPATCH_APNS_KEY",
        "DISPATCH_APNS_KEY_ID",
        "DISPATCH_APNS_TEAM_ID",
        "DISPATCH_APNS_TOPIC",
    ];
    let values: [Option<String>; 4] =
        vars.map(|v| std::env::var(v).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()));
    if values.iter().all(Option::is_none) {
        return None;
    }
    if values.iter().any(Option::is_none) {
        eprintln!("pings-dispatch: set all of {}, or none", vars.join(", "));
        std::process::exit(2);
    }
    let [key, key_id, team_id, topic] = values.map(Option::unwrap);
    let sandbox = match std::env::var("DISPATCH_APNS_ENDPOINT").ok().as_deref() {
        Some("sandbox") => true,
        Some("production") | None => false,
        Some(other) => {
            eprintln!("pings-dispatch: DISPATCH_APNS_ENDPOINT must be sandbox or production, got {other}");
            std::process::exit(2);
        }
    };
    match ApnsPushSender::new(ApnsConfig {
        key_path: PathBuf::from(key),
        key_id,
        team_id,
        topic: topic.clone(),
        sandbox,
    }) {
        Ok(sender) => {
            let env = if sandbox { "sandbox" } else { "production" };
            println!("pings-dispatch: APNs push enabled (topic {topic}, {env})");
            Some(Arc::new(sender))
        }
        Err(err) => {
            eprintln!("pings-dispatch: {err}");
            std::process::exit(2);
        }
    }
}

#[tokio::main]
async fn main() {
    let team_key = match std::env::var("DISPATCH_TEAM_KEY") {
        Ok(key) if !key.trim().is_empty() => key.trim().to_string(),
        _ => {
            eprintln!("pings-dispatch: set DISPATCH_TEAM_KEY (the enrollment secret)");
            std::process::exit(2);
        }
    };
    let addr = std::env::var("DISPATCH_ADDR").unwrap_or_else(|_| DEFAULT_ADDR.to_string());
    let state_file = std::env::var("DISPATCH_STATE_FILE").ok().map(PathBuf::from);

    let mut state = AppState::new(team_key, state_file);
    if let Some(sender) = push_sender_from_env() {
        state = state.with_push_sender(sender);
    }
    let app = router(state);
    let tls_cert = std::env::var("DISPATCH_TLS_CERT").ok();
    let tls_key = std::env::var("DISPATCH_TLS_KEY").ok();

    match (tls_cert, tls_key) {
        (Some(cert), Some(key)) => {
            let config = match axum_server::tls_rustls::RustlsConfig::from_pem_file(&cert, &key)
                .await
            {
                Ok(c) => c,
                Err(err) => {
                    eprintln!("pings-dispatch: cannot load TLS cert/key: {err}");
                    std::process::exit(1);
                }
            };
            let sock_addr: std::net::SocketAddr = match addr.parse() {
                Ok(a) => a,
                Err(err) => {
                    eprintln!("pings-dispatch: invalid DISPATCH_ADDR {addr}: {err}");
                    std::process::exit(1);
                }
            };
            println!(
                "pings-dispatch v{} listening on {addr} (TLS)",
                env!("CARGO_PKG_VERSION")
            );
            let server = axum_server::bind_rustls(sock_addr, config).serve(app.into_make_service());
            tokio::select! {
                result = server => {
                    if let Err(err) = result {
                        eprintln!("pings-dispatch: server error: {err}");
                    }
                }
                _ = tokio::signal::ctrl_c() => println!("pings-dispatch: shutting down"),
            }
        }
        (None, None) => {
            let listener = match tokio::net::TcpListener::bind(&addr).await {
                Ok(l) => l,
                Err(err) => {
                    eprintln!("pings-dispatch: cannot bind {addr}: {err}");
                    std::process::exit(1);
                }
            };
            println!(
                "pings-dispatch v{} listening on {addr} (plain HTTP — tailnet mode)",
                env!("CARGO_PKG_VERSION")
            );
            let server = axum::serve(listener, app);
            tokio::select! {
                result = server => {
                    if let Err(err) = result {
                        eprintln!("pings-dispatch: server error: {err}");
                    }
                }
                _ = tokio::signal::ctrl_c() => println!("pings-dispatch: shutting down"),
            }
        }
        _ => {
            eprintln!("pings-dispatch: set both DISPATCH_TLS_CERT and DISPATCH_TLS_KEY, or neither");
            std::process::exit(2);
        }
    }
}

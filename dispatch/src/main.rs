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

use pings_dispatch::{router, AppState, DEFAULT_ADDR};
use std::path::PathBuf;

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

    let app = router(AppState::new(team_key, state_file));
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

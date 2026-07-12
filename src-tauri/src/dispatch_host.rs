//! Host mode: run the team's Dispatch server inside the desktop app.
//!
//! The same library the headless `pings-dispatch` CLI is built from, spawned
//! on a background thread behind an Options toggle — so any teammate can *be*
//! the server without installing anything. Embedded hosting serves plain HTTP
//! for LAN/tailnet use; the CLI remains the path for TLS deployments.

use pings_dispatch::{spawn_host, HostHandle, HostStatus};
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

/// Embedded hosts always serve the default Dispatch port.
const HOST_ADDR: &str = "0.0.0.0:43217";

#[derive(Default)]
pub struct DispatchHostState(pub Mutex<Option<HostHandle>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatusPayload {
    pub enabled: bool,
    pub running: bool,
    pub addr: String,
    pub error: String,
    pub devices: usize,
    pub roster: usize,
}

/// Reconcile the embedded server with the current settings: start it when
/// enabled and not running, stop it when disabled. Idempotent.
pub fn apply(app: &AppHandle, settings: &crate::persistence::Settings) {
    let host: State<'_, DispatchHostState> = app.state();
    let mut guard = host.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    match (settings.host_dispatch_enabled, guard.as_ref()) {
        (true, None) => {
            let state_file = app
                .path()
                .app_data_dir()
                .ok()
                .map(|dir| dir.join("dispatch-state.json"));
            *guard = Some(spawn_host(
                settings.host_dispatch_key.clone(),
                HOST_ADDR.to_string(),
                state_file,
            ));
        }
        (false, Some(handle)) => {
            handle.stop();
            *guard = None;
        }
        _ => {}
    }
}

/// Snapshot for the Options status line.
pub fn status(app: &AppHandle, enabled: bool) -> HostStatusPayload {
    let host: State<'_, DispatchHostState> = app.state();
    let guard = host.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    match guard.as_ref() {
        Some(handle) => {
            let (running, addr, error) = match handle.status() {
                HostStatus::Running { addr } => (true, addr, String::new()),
                HostStatus::Starting => (false, String::new(), String::new()),
                HostStatus::Failed { error } => (false, String::new(), error),
                HostStatus::Stopped => (false, String::new(), String::new()),
            };
            HostStatusPayload {
                enabled,
                running,
                addr,
                error,
                devices: handle.device_count(),
                roster: handle.roster_count(),
            }
        }
        None => HostStatusPayload {
            enabled,
            running: false,
            addr: String::new(),
            error: String::new(),
            devices: 0,
            roster: 0,
        },
    }
}

//! go-push — the one thing the native shell exists for: APNs registration.
//! The Swift side asks notification permission, calls
//! `registerForRemoteNotifications`, and delivers the hex device token to JS
//! (which POSTs it to Dispatch's /v1/push-token), plus badge counts and
//! notification-tap events.

use tauri::{
  plugin::{Builder, TauriPlugin},
  Manager, Runtime,
};

pub use models::*;

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

mod commands;
mod error;
mod models;

pub use error::{Error, Result};

#[cfg(desktop)]
use desktop::GoPush;
#[cfg(mobile)]
use mobile::GoPush;

/// Extensions to [`tauri::App`], [`tauri::AppHandle`] and [`tauri::Window`] to access the go-push APIs.
pub trait GoPushExt<R: Runtime> {
  fn go_push(&self) -> &GoPush<R>;
}

impl<R: Runtime, T: Manager<R>> crate::GoPushExt<R> for T {
  fn go_push(&self) -> &GoPush<R> {
    self.state::<GoPush<R>>().inner()
  }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
  Builder::new("go-push")
    .invoke_handler(tauri::generate_handler![
      commands::request_push,
      commands::get_token,
      commands::set_badge
    ])
    .setup(|app, api| {
      #[cfg(mobile)]
      let go_push = mobile::init(app, api)?;
      #[cfg(desktop)]
      let go_push = desktop::init(app, api)?;
      app.manage(go_push);
      Ok(())
    })
    .build()
}

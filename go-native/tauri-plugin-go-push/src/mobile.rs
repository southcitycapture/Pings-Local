use serde::de::DeserializeOwned;
use tauri::{
  plugin::{PluginApi, PluginHandle},
  AppHandle, Runtime,
};

use crate::models::*;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_go_push);

pub fn init<R: Runtime, C: DeserializeOwned>(
  _app: &AppHandle<R>,
  api: PluginApi<R, C>,
) -> crate::Result<GoPush<R>> {
  #[cfg(target_os = "ios")]
  let handle = api.register_ios_plugin(init_plugin_go_push)?;
  #[cfg(target_os = "android")]
  let handle = api.register_android_plugin("com.pings.go", "GoPushPlugin")?; // FCM, later
  Ok(GoPush(handle))
}

/// Access to the go-push APIs.
pub struct GoPush<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> GoPush<R> {
  pub fn request_push(&self) -> crate::Result<PushGrant> {
    self.0.run_mobile_plugin("requestPush", ()).map_err(Into::into)
  }

  pub fn get_token(&self) -> crate::Result<PushToken> {
    self.0.run_mobile_plugin("getToken", ()).map_err(Into::into)
  }

  pub fn set_badge(&self, count: u32) -> crate::Result<()> {
    self
      .0
      .run_mobile_plugin("setBadge", SetBadgeRequest { count })
      .map_err(Into::into)
  }
}

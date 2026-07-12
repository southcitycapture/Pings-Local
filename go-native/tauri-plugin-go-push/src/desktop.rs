//! Desktop stubs so `tauri dev` on the Mac runs the same UI — there's no
//! push registration to do; the token stays empty and the badge is ignored.

use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::*;

pub fn init<R: Runtime, C: DeserializeOwned>(
  app: &AppHandle<R>,
  _api: PluginApi<R, C>,
) -> crate::Result<GoPush<R>> {
  Ok(GoPush(app.clone()))
}

/// Access to the go-push APIs.
pub struct GoPush<R: Runtime>(AppHandle<R>);

impl<R: Runtime> GoPush<R> {
  pub fn request_push(&self) -> crate::Result<PushGrant> {
    Ok(PushGrant { granted: false })
  }

  pub fn get_token(&self) -> crate::Result<PushToken> {
    Ok(PushToken::default())
  }

  pub fn set_badge(&self, _count: u32) -> crate::Result<()> {
    Ok(())
  }
}

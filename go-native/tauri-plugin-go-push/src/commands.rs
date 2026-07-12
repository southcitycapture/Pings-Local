use tauri::{command, AppHandle, Runtime};

use crate::models::*;
use crate::GoPushExt;
use crate::Result;

#[command]
pub(crate) async fn request_push<R: Runtime>(app: AppHandle<R>) -> Result<PushGrant> {
  app.go_push().request_push()
}

#[command]
pub(crate) async fn get_token<R: Runtime>(app: AppHandle<R>) -> Result<PushToken> {
  app.go_push().get_token()
}

#[command]
pub(crate) async fn set_badge<R: Runtime>(app: AppHandle<R>, count: u32) -> Result<()> {
  app.go_push().set_badge(count)
}

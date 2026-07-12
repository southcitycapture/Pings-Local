use serde::{Deserialize, Serialize};

/// Did the user grant notification permission?
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushGrant {
  pub granted: bool,
}

/// The APNs device token, hex-encoded. Empty until registration completes —
/// a fresh token also arrives as a `pushToken` plugin event.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushToken {
  pub token: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetBadgeRequest {
  pub count: u32,
}

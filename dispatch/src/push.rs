//! Push gateway — fires a platform push for frames the relay could not
//! deliver, so a phone whose app is closed still gets the ping.
//!
//! Content-blind by the same rule as the relay: the only things that leave
//! for Apple are the frame's `channel` (routing metadata the server already
//! reads) and `payload.from` (the sender display name, which the sender chose
//! to put in the envelope). Message bodies never reach the push service, and
//! a push never fakes an ack — ✓✓ still means the recipient's device
//! processed the message.
//!
//! The trait is always compiled (tests inject mocks); the APNs implementation
//! sits behind the `push` feature so the embedded desktop host can build
//! without the HTTP/2 client stack.

/// What kind of frame went undelivered — sets the alert's urgency.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PushKind {
    Ping,
    Chat,
}

/// Everything the gateway is allowed to know about an undelivered frame.
#[derive(Clone, Debug)]
pub struct PushNote {
    pub push_token: String,
    pub kind: PushKind,
    pub sender_name: String,
}

/// Fire-and-forget push delivery. Implementations spawn onto the ambient
/// tokio runtime and log failures — push is best-effort, like `save_devices`.
pub trait PushSender: Send + Sync + 'static {
    fn send(&self, note: PushNote);
}

/// The exact wire payload for a note. Pure, so the unit tests and the
/// `simctl push` fixtures under `tests/fixtures/` can lock the same JSON.
pub fn payload_json(kind: PushKind, sender_name: &str) -> serde_json::Value {
    match kind {
        // A ping is the product: someone is actively trying to get your
        // attention right now. Time-sensitive lets it break through Focus.
        PushKind::Ping => serde_json::json!({
            "aps": {
                "alert": { "title": sender_name, "body": "is pinging you" },
                "sound": "default",
                "interruption-level": "time-sensitive",
            }
        }),
        // A chat is a normal message — no content, just who it's from.
        PushKind::Chat => serde_json::json!({
            "aps": {
                "alert": { "title": sender_name, "body": "New message" },
                "sound": "default",
            }
        }),
    }
}

/// Prints what *would* be pushed instead of calling Apple — lets the whole
/// undeliverable→push path be verified end-to-end with no credentials
/// (`DISPATCH_PUSH_DEBUG=log`).
pub struct LoggingPushSender;

impl PushSender for LoggingPushSender {
    fn send(&self, note: PushNote) {
        let kind = match note.kind {
            PushKind::Ping => "ping",
            PushKind::Chat => "chat",
        };
        let token8: String = note.push_token.chars().take(8).collect();
        println!(
            "pings-dispatch: would-push {kind} → {token8}… from {}",
            note.sender_name
        );
    }
}

#[cfg(feature = "push")]
pub use apns::{ApnsConfig, ApnsPushSender};

#[cfg(feature = "push")]
mod apns {
    use super::{payload_json, PushKind, PushNote, PushSender};
    use a2::request::payload::PayloadLike;
    use a2::NotificationOptions;
    use serde::Serialize;
    use std::path::PathBuf;

    pub struct ApnsConfig {
        /// Path to the .p8 auth key from the Apple developer portal.
        pub key_path: PathBuf,
        pub key_id: String,
        pub team_id: String,
        /// The iOS app's bundle identifier (`apns-topic`).
        pub topic: String,
        /// Development-signed builds get sandbox tokens; TestFlight/App Store
        /// builds use production.
        pub sandbox: bool,
    }

    pub struct ApnsPushSender {
        client: a2::Client,
        topic: String,
    }

    impl ApnsPushSender {
        pub fn new(config: ApnsConfig) -> Result<Self, String> {
            let key = std::fs::File::open(&config.key_path)
                .map_err(|err| format!("cannot open APNs key {}: {err}", config.key_path.display()))?;
            let endpoint = if config.sandbox {
                a2::Endpoint::Sandbox
            } else {
                a2::Endpoint::Production
            };
            let client = a2::Client::token(
                key,
                &config.key_id,
                &config.team_id,
                a2::ClientConfig::new(endpoint),
            )
            .map_err(|err| format!("APNs client: {err}"))?;
            Ok(Self { client, topic: config.topic })
        }
    }

    /// a2's typed `APS` predates `interruption-level`, so this serializes the
    /// exact JSON from [`payload_json`] instead — `PayloadLike` only needs
    /// the token and header options on the side.
    #[derive(Serialize, Debug)]
    struct RawPayload<'a> {
        #[serde(flatten)]
        body: serde_json::Value,
        #[serde(skip)]
        device_token: &'a str,
        #[serde(skip)]
        options: NotificationOptions<'a>,
    }

    impl PayloadLike for RawPayload<'_> {
        fn get_device_token(&self) -> &str {
            self.device_token
        }
        fn get_options(&self) -> &NotificationOptions<'_> {
            &self.options
        }
    }

    impl PushSender for ApnsPushSender {
        fn send(&self, note: PushNote) {
            let client = self.client.clone();
            let topic = self.topic.clone();
            tokio::spawn(async move {
                // Repeated pings from one sender collapse into a single
                // banner instead of stacking.
                let collapse = match note.kind {
                    PushKind::Ping => a2::CollapseId::new("pings-ping").ok(),
                    PushKind::Chat => None,
                };
                let payload = RawPayload {
                    body: payload_json(note.kind, &note.sender_name),
                    device_token: &note.push_token,
                    options: NotificationOptions {
                        apns_topic: Some(&topic),
                        apns_priority: Some(a2::Priority::High),
                        apns_push_type: Some(a2::request::notification::PushType::Alert),
                        apns_collapse_id: collapse,
                        ..Default::default()
                    },
                };
                if let Err(err) = client.send(payload).await {
                    eprintln!("pings-dispatch: push failed: {err}");
                }
            });
        }
    }
}

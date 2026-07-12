# Handoff: Pings Go! native (for the Mac-side session)

> Audience: the Claude Code session running locally on the Mac. The web
> version of Pings Go! is **built and verified** (served by Dispatch at
> `/go`); this document is the punch list for taking Go! native — the parts
> that physically require a Mac, Xcode, and developer accounts.

## What already exists (don't rebuild it)

- **Pings Go! web** (`dispatch/src/go.html` + PWA fittings): sign-in
  (name + team key → auto-enroll via `POST /v1/enroll`), roster with
  presence, tap-to-ping, full-screen flash + sound + vibration, DM threads
  with ✓✓ acks. Everything rides the relay WebSocket
  (`/v1/ws?token=<deviceToken>`); phones register with a pseudo-address
  (`go-<peerId8>`) so desktops route to them via relay automatically.
  Verified end-to-end: two headless mobile browsers against the real
  server — join → roster → ping (flash on the receiver) → DM (✓✓).
- **Dispatch** (D1–D3): directory + enrollment/device tokens + TLS + the
  content-blind relay + admin page. The full HTTP/WS contract is in
  [PROTOCOL.md](./PROTOCOL.md) ("Dispatch" section).
- **Desktop transport logic**: per-send direct-UDP vs relay decision
  (`should_relay` in `src-tauri/src/networking.rs`), shared chat processing
  (`process_chat_payload`), acks over either transport.

## What the native app adds (why bother)

One thing, really: **receiving when the app is closed** — push
notifications, plus platform flash affordances (iOS time-sensitive alerts,
Android full-screen intent) and real haptics. Everything else the web
version already does.

## The work, in order

### 1. Prerequisites (human tasks, not code)

- Apple Developer account ($99/yr) — also unlocks signing/notarizing the
  desktop app; do this first, it gates everything iOS.
- An APNs key (p8) from the Apple dev portal.
- A Firebase project for FCM (free) for Android push.
- Android Studio + SDK/NDK on the Mac for the Android target.

### 2. Dispatch grows a push gateway (Rust, buildable anywhere)

- New endpoint: `POST /v1/push-token` (device token auth) —
  `{peerId, platform: "apns"|"fcm", pushToken}` stored beside the device
  (extend `Device` + the state file).
- Relay delivery hook: in `relay_session`, when a frame's recipient has no
  live socket (today's "undeliverable" branch) **and** has a push token →
  send a push via APNs/FCM instead. Ping frames → high-priority/alert push
  with sender name; chat frames → normal message push.
- Crates: `a2` (APNs) and `fcm` or plain HTTP v1 API with `yup-oauth2`.
  Config via env: `DISPATCH_APNS_KEY/KEY_ID/TEAM_ID/TOPIC`,
  `DISPATCH_FCM_CREDENTIALS`.
- Keep it optional: no push config = today's behavior exactly.

### 3. The Tauri mobile shell

- `npm run tauri ios init` / `tauri android init` in this repo (Tauri 2
  already supports mobile; the desktop crate's `[lib]` already builds
  `staticlib`/`cdylib` for exactly this reason).
- The mobile UI can start as literally the existing `go.html` UI moved into
  the webview (same tokens, same relay client) — the Rust side only needs:
  push-token registration (via `tauri-plugin-notification` +
  platform channels), badge counts, and haptics.
- iOS: request time-sensitive notification entitlement (critical alerts
  need Apple approval — apply early, fall back to time-sensitive).
  Android: `USE_FULL_SCREEN_INTENT` permission for the flash-like alert.

### 4. Ship

- TestFlight for iOS beta (needs the dev account); APK sideload or Play
  internal track for Android.
- CI: add an `ios`/`android` job later — needs a macOS runner with Xcode
  for iOS; hold off until the app exists.

## Gotchas learned the hard way (read before coding)

- **Browsers can't set WS headers** — that's why `/v1/ws` accepts
  `?token=`. Native clients should keep using the `Authorization` header.
- **Phone pseudo-addresses**: Go! clients register `ip: "go-<peerId8>"`.
  Desktops key their peer table by that string and relay to it because
  there's never direct evidence for it. Don't "fix" this by sending a real
  IP — phone IPs are unroutable and change constantly; the pseudo-address
  is what makes the relay routing automatic.
- **Acks are the delivery truth** — the server's "undeliverable" notice is
  informational only. Push delivery must not fake an ack; ✓✓ means the
  recipient's device actually processed the message.
- **The relay is content-blind** — keep it that way when adding push. The
  push payload may carry the sender name (it's already in the envelope the
  sender chose to send), but the server still shouldn't parse/store
  message content beyond handing it to APNs/FCM.
- The desktop's `cargo check` on Linux misses macOS-only compile errors
  (feature-gated APIs) — same applies to iOS; build on the target early.

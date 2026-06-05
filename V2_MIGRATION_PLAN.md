# Pings v2 Migration Plan (Electron -> Tauri)

## Goal
- Replace Electron runtime with Tauri while preserving the existing Pings behavior.
- Ship macOS first (arm64 + x86_64), then port to Linux.

## Current State
- `v2/` Tauri app scaffold created.
- Basic Rust commands and frontend bridge are in place.
- App metadata aligned to `Pings` and `com.pings.app`.
- Phase 1 checkpoint completed:
  - Rust networking control surface for interface ranking + preferred IP + discovery node config.
  - `network-status` event emission on startup and every 5s.
  - Rust persistence layer for `settings.json`, `profile.json`, `history.json`.
  - Frontend smoke test panel wired to new network/persistence commands.

## Phase 1: Mac Parity (Required)

1. Networking service (Rust)
- Port from `/Users/zachjack/Apps/Pings/src/main/networking.js`.
- Keep the same concepts:
  - mDNS discovery (`_pings._tcp.local`)
  - ping server (`43210`)
  - chat server (`43211`)
  - discovery node bootstrap
  - subnet probe fallback
  - diagnostics counters/timestamps

2. Tauri command/event API (Rust <-> UI)
- Replace Electron preload API from `/Users/zachjack/Apps/Pings/src/preload/index.js`.
- Introduce versioned command surface:
  - `settings_get`, `settings_set`
  - `profile_get`, `profile_set`
  - `peers_subscribe`
  - `ping_send`
  - `chat_send`, `chat_private_send`, `typing_send`
  - `history_get`, `history_clear`
  - `network_interfaces_get`, `network_status_get`

3. Window model
- Port behavior from `/Users/zachjack/Apps/Pings/src/main/index.js`:
  - Main dashboard window.
  - Overlay alert window (transparent, click-through, always-on-top).
  - Floating private chat windows per peer.
  - Tray icon/menu with quick peer ping actions.

4. Renderer migration
- Reuse and adapt UI logic from:
  - `/Users/zachjack/Apps/Pings/src/renderer/dashboard.js`
  - `/Users/zachjack/Apps/Pings/src/renderer/private-chat.js`
  - `/Users/zachjack/Apps/Pings/src/renderer/main.js`
  - `/Users/zachjack/Apps/Pings/src/renderer/onboarding.js`
- Swap `window.api.*` with the Tauri bridge layer (`invoke` + event listeners).

5. Persistence
- Keep data files equivalent to v1:
  - `settings.json`
  - `profile.json`
  - `history.json`
- Store under Tauri app data directory, preserving schema where possible.

## Phase 2: Release Packaging (Mac)

1. macOS architectures
- Build `arm64`: `aarch64-apple-darwin`
- Build `x86_64`: `x86_64-apple-darwin`

2. Distribution
- Produce signed `.app` + `.dmg`.
- Preserve existing app identifier: `com.pings.app`.

## Phase 3: Linux Port (After Mac Stable)

1. Keep shared core
- Reuse Rust networking + UI bridge directly.

2. Desktop differences
- Validate tray and overlay behavior on:
  - GNOME (Wayland/X11)
  - KDE
- Add graceful fallback when compositor restrictions block exact overlay behavior.

3. Packaging
- Build `x86_64-unknown-linux-gnu`.
- Ship `.AppImage` and `.deb` first.

## v1 -> v2 Source Mapping

- App lifecycle/windows/tray:
  - v1: `/Users/zachjack/Apps/Pings/src/main/index.js`
  - v2 target: `/Users/zachjack/Apps/Pings/v2/src-tauri/src/` (window/tray modules)

- Networking/discovery/chat:
  - v1: `/Users/zachjack/Apps/Pings/src/main/networking.js`
  - v2 target: `/Users/zachjack/Apps/Pings/v2/src-tauri/src/` (networking service modules)

- IPC bridge:
  - v1: `/Users/zachjack/Apps/Pings/src/preload/index.js`
  - v2 target: `/Users/zachjack/Apps/Pings/v2/src/pings-api.js` + Rust commands/events

- Renderer UI:
  - v1: `/Users/zachjack/Apps/Pings/src/renderer/*`
  - v2 target: `/Users/zachjack/Apps/Pings/v2/src/*` (or split into dashboard/private-chat/overlay pages)

## Definition of Done (Mac v2)
- Peer discovery works in mixed local setups (including manual preferred IP path).
- Ping shapes render correctly (including border) without disruptive fullscreen switching.
- Team chat has no duplicate message regression.
- 1:1 chat auto-opens and supports delivery statuses.
- Tray quick ping works with per-peer sounds.
- App builds and runs on mac arm64 + x86_64.

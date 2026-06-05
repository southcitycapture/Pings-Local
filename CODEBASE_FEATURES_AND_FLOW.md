# Pings Codebase: Features and How It Works

This file documents the current implementation in `src/` so you can quickly understand and debug the app.

## Stack
- Electron + `electron-vite`
- Renderer: vanilla HTML/CSS/JS
- Realtime transport: `socket.io`
- Discovery: `multicast-dns` (mDNS PTR/SRV/TXT/A records)

## High-Level Architecture
- Main process (`src/main/`):
  - Owns app lifecycle, windows, tray, settings/profile/history persistence.
  - Runs networking (discovery, ping server, chat server, peer connections).
  - Bridges data/events to renderers via IPC.
- Preload (`src/preload/index.js`):
  - Exposes a safe `window.api` surface to renderer pages.
- Renderer (`src/renderer/`):
  - `dashboard.html/js`: peers, team chat, settings, diagnostics.
  - `private-chat.html/js`: floating 1:1 windows.
  - `index.html/js`: ping overlay UI + audio playback.
  - `onboarding.html/js`: first-run profile setup.

## Core Features
- Peer discovery on LAN (mDNS + subnet probing fallback).
- Manual network controls:
  - Preferred interface/IP selection.
  - Optional discovery node IP for peer list bootstrap.
- Ping alerts:
  - Shapes: `circle`, `square`, `diamond`, `border`.
  - Sender-selected shape is sent in payload.
  - Sound selection and per-peer sound overrides.
  - Optional custom message attached to ping.
- Team chat:
  - Group chat messages, typing indicators, quick replies.
  - Recent history broadcast to newly connected peers.
- 1:1 private chat:
  - Floating per-peer window.
  - Auto-open on inbound private message.
  - Local private history and delivery status (`sending`, `retrying`, `sent`, `failed`).
- Profile:
  - Display name, status, avatar color, avatar upload (stored as data URL).
- History:
  - Sent/received ping history with clear action.
- Tray:
  - Dynamic peer list and quick ping actions.
- Diagnostics:
  - Footer debug panel with mDNS counts/timestamps, connection/subnet probe stats, discovery-node status.

## File-by-File Responsibilities

### Main process
- `src/main/index.js`
  - App bootstrap (`onboarding` vs normal startup).
  - Creates windows:
    - Overlay window.
    - Dashboard window.
    - Onboarding window.
    - Private chat windows (`Map<peerIp, BrowserWindow>`).
  - Handles app events from networking (`incoming-ping`, `chat-message`, `private-message`, etc.).
  - Maintains `settings`, `profile`, `history` persistence in `app.getPath('userData')`.
  - IPC channels for all renderer operations.

- `src/main/networking.js`
  - Starts:
    - Ping server on `43210` (`socket.io`).
    - Chat server on `43211` (`socket.io`).
  - Handles mDNS announce/query + response parsing.
  - Maintains peer maps:
    - `peers` (discovery view)
    - `chatPeers` (socket/chat presence view)
  - Connects to discovered peers via chat sockets.
  - Implements:
    - Group messaging.
    - Private messaging with ack/retries.
    - Typing/status events.
    - Discovery node peer-list sync.
    - Local subnet probing fallback when discovery is empty.
  - Tracks diagnostics counters/timestamps.

### Preload bridge
- `src/preload/index.js`
  - Exposes `window.api` methods/events for:
    - Ping actions
    - Settings/profile/history
    - Network interfaces/status
    - Group + private chat
    - Onboarding completion

### Renderer pages
- `src/renderer/dashboard.js`
  - Loads settings/profile/history/interfaces on init.
  - Renders peers list + per-peer controls.
  - Sends group chat and typing events.
  - Handles profile save + avatar upload conversion to data URL.
  - Manages quick replies and all settings form controls.
  - Renders network diagnostics text from `network-status`.

- `src/renderer/private-chat.js`
  - Loads peer context from main (`get-peer-data`).
  - Loads private history and listens for private events.
  - Filters messages to current peer conversation.
  - Tracks delivery status labels per outgoing message.

- `src/renderer/main.js`
  - Overlay pulse logic for shape animations.
  - WebAudio-based ping sounds.
  - Applies runtime sound changes from main.

- `src/renderer/onboarding.js`
  - Collects initial display name/avatar color/sound.
  - Sends `complete-onboarding` to main.

## Runtime Data and Persistence
- User data directory (`app.getPath('userData')`):
  - `settings.json`
  - `profile.json`
  - `history.json`
- In-memory structures:
  - Main:
    - `privateChatWindows`, `pendingPrivateMessages`, `pingHistory`, `settings`
  - Networking:
    - `peers`, `chatPeers`, `chatSockets`
    - `chatMessages`, `privateChats`
    - `privateMessageRetries`
    - `seenChatMessages` (dedupe window)

## IPC Contract (Main <-> Renderer)
- Main listeners (`ipcMain.on`):
  - `trigger-ping`
  - `update-setting`
  - `set-profile`
  - `clear-history`
  - `complete-onboarding`
  - `send-chat-message`
  - `send-typing`
  - `send-private-message`
  - `send-private-typing`
  - `open-private-chat`
- Main handlers (`ipcMain.handle`):
  - `get-profile`
  - `get-settings`
  - `get-history`
  - `get-peer-data`
  - `get-private-chat-history`
  - `get-network-interfaces`
- Main emits to renderers:
  - `start-pulse`
  - `sound-changed`
  - `peers-updated`
  - `chat-peers-updated`
  - `chat-message`
  - `chat-typing`
  - `private-message`
  - `private-typing`
  - `private-history`
  - `private-message-status`
  - `network-status`
  - `settings-updated`
  - `history-updated`

## Networking Flow
1. App starts networking, picks local IP (`preferredIp` first, otherwise best-scored interface).
2. Announces `_pings._tcp.local` via mDNS and sends periodic PTR queries.
3. On mDNS responses:
   - Parses PTR/SRV/TXT/A records.
   - Builds/updates peer list.
   - Attempts chat socket connection to discovered IPs.
4. If no peers appear:
   - Optional discovery node bootstrap (`peer-list-request`).
   - Local subnet probe to detect hosts with open chat port.
5. Chat and presence state are emitted to dashboard/private windows.

## Ping Flow
1. Renderer calls `trigger-ping` with target IP/message.
2. Main calls `networking.sendPing(ip, message, soundOverride, shape)`.
3. Target ping server receives `ping-user` event and emits `incoming-ping`.
4. Main overlay window:
   - Uses sender shape (`data.shape`) if valid.
   - Shows animation/sound for ~4 seconds.
   - Records history.

## Chat Flow
- Group chat:
  - Message originates locally (`sendChatMessage`) and is emitted to chat server + local app event.
  - Remote sockets receive `message`, dedupe logic prevents repeated rendering.
- Private chat:
  - Outgoing message is stored in conversation bucket.
  - Sent directly to target peer with ack + retry logic.
  - Incoming private message triggers private window auto-open if needed.
  - Message status updates are emitted back to the private chat window.

## Windows and UX Behavior
- Dashboard: `titleBarStyle: hiddenInset` with min size constraints.
- Private chats:
  - Floating, always-on-top, cascaded near bottom-right.
  - Visible on all workspaces/fullscreen spaces.
- Overlay:
  - Transparent, click-through, always-on-top.
  - Border shape uses full active display bounds.
  - Other shapes use configured position (`top-left`, `top-right`, `center`).

## Run and Build
- Dev:
  - `npm start`
- Build output:
  - `npm run build` -> `out/`
- Package mac app:
  - `npm run package`
  - platform variants: `package:intel`, `package:arm64`, `package:universal`

## Useful Debug Pointers
- If peers do not show:
  - Check footer diagnostics in dashboard (`network-debug`).
  - Verify `preferredIp`, `discoveryNodeIp`, `lastMdnsResponseAt`, `lastPeerListSyncAt`, `lastSubnetProbeHits`.
- If chat duplicates appear:
  - Check dedupe logic in:
    - `src/main/networking.js` (`isDuplicateChatMessage`)
    - `src/renderer/dashboard.js` (render dedupe maps)
- If private chat does not open:
  - Follow `app.on('private-message')` path in `src/main/index.js`.
  - Verify target IP resolution (`otherIp` logic).

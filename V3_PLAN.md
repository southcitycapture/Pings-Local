# Pings v3 — Review & Redesign Plan

Pings v2 got the app onto Tauri, but it reads as a migration checkpoint that shipped: a debug panel that grew a UI, a networking layer with three overlapping delivery paths, and a theme that's half hard-coded. v3 is the version where Pings becomes a product: a tap-on-the-shoulder presence tool that lives in the menubar and gets out of the way.

**One-line thesis for v3:** *See who's around. Ping them in one keystroke.*

---

## Part 1 — Honest review of v2

### Implementation

1. **Pings are delivered twice between v2 peers.** `main.js` sends every ping via the native UDP path *and* the legacy socket.io bridge (`sendPing` + `sendLegacyPing` in `Promise.all`). A v2 receiver runs both listeners on port 43210 (UDP + TCP), so both fire `incoming-ping` — double overlay flash, double feed entry, double sound. The bridge should be receive-only compat, or removed.

2. **Peer identity is an IP address.** Aliases, dedup, chat routing, and window labels are all keyed by IP. DHCP renew = your alias and chat history point at the wrong machine. There is no stable peer ID anywhere in the system.

3. **The direct-chat window plumbing is a race-condition band-aid pile.** Window labels are derived from the peer *name* if present, else a lossy `.`→`_` sanitized IP that gets decoded back by replacing *all* underscores with dots. The same peer can get two windows (one by-name, one by-IP). Context is delivered by emitting the same event 6 times on a 120 ms timer hoping the window is listening by then. Incoming messages are matched by case-insensitive name *or* IP.

4. **Chat is fire-and-forget UDP.** Single datagram, no ack, no retry, no ordering, no delivery state (the v1 parity DoD explicitly listed delivery statuses). Silent message loss is a normal outcome.

5. **Nothing persists.** `history.json`, `load_history`, `clear_history`, and `HistoryEntry` all exist — and nothing ever writes a history entry. Every ping and every chat message is gone on restart.

6. **The subnet probe port-scans the LAN.** When no peers are known it spawns 24 threads every 15 s to TCP-connect to all 254 hosts, and treats "port 43211 open" as "this is a Pings peer" — any unrelated service on that port becomes a phantom peer named by its IP.

7. **The discovery node is a dead control.** `set_discovery_node_ip` stores a string and writes fake diagnostics (`"not-connected-yet"`, `discovery_node_connected` hard-coded `false`). No code ever connects to it. The UI presents it as a working feature.

8. **Half the settings do nothing.** `dnd` (the overlay never checks it — DND does not suppress pings), `position` (overlay is always fullscreen), `quickReplies`, `peerSounds`, `hasCompletedOnboarding` (there is no onboarding) — all persisted, surfaced, and unenforced.

9. **Three copies of everything in the frontend.** `playTone`/`playSound`/`escapeHtml`/`formatAgo` are pasted into `main.js`, `overlay.js`, and `direct-chat.js`. Settings are synced across windows by per-window 1.5 s TTL polling caches plus an event. There is no shared module.

10. **Full `innerHTML` re-render on every event.** Every peers update (every 5 s, plus every mDNS event) rebuilds all cards and re-attaches every listener. Practical effects: the ping button's "Sending…" state gets wiped mid-flight, and the alias editor loses focus while you're typing if a ping arrives.

11. **Rust concurrency is threads + one big mutex.** Six-plus OS threads, plus an entire multi-thread tokio runtime spun up solely for the legacy socket.io bridge, all funneling through `Arc<Mutex<NetworkRuntime>>` with `.expect("network state poisoned")` on every lock — one panic while holding the lock cascades into panics everywhere.

12. **The legacy bridge guesses sender identity by display name.** Incoming socket.io pings infer the sender's IP by scanning known peers for a matching name — wrong for duplicate names, trivially spoofable.

13. **Ship-blocking config in the repo.** Updater endpoints point at `ZachBook-Pro.local` with `dangerousInsecureTransportProtocol: true`, and CSP is `null`.

14. **One try/catch wraps all UI init.** Any single failure in `DOMContentLoaded` silently kills every subsequent wire-up and dumps the error into a hidden `<pre>`.

### Design

- **It's a debug panel wearing a UI.** Hidden `<pre>` JSON dumps, a "migration modules" list, raw settings/profile JSON rendered in the Options window.
- **Two competing settings surfaces.** The main window's "Your Settings" panel and the Options window both own sound and shape, with per-field "Save" buttons in one and auto-save in the other.
- **Dark mode is half broken by design.** Theme tokens exist, but `.peer-meta`, `.chat-meta`, `.tab-header`, the advanced-card summary, and every button gradient hard-code light-teal hex values that never change in dark mode.
- **Teal on teal on teal, gradient on every button.** Every card has an 8 px colored left bar; there are four different corner radii; there's no spacing system; the peer "color" is a CSS gradient string generated in Rust and injected as an inline style.
- **Google Fonts fetched from a CDN at runtime** in a desktop app — offline or slow network means fallback fonts.
- **Sounds are raw oscillator beeps** (square/sine/triangle tones), which reads as prototype, not product.
- **The core action is buried.** Pinging someone means: find the window → scan a card grid → click a button. For an app whose whole job is "ping a person," that should be one keystroke.

---

## Part 2 — v3 concept

### Product shape

Stop being a mini-Slack dashboard. Pings is a **presence utility**:

- **Compact buddy-list main window** (~360 × 560): you, then everyone on the network, one row each. Hover a row → Ping / Message actions. Double-click = ping. That's the whole window.
- **Menubar/tray first.** Tray menu lists peers for one-click pings; the window is optional. Global shortcut summons a **⌘K palette**: type two letters of a name, Enter to ping, ⇧Enter to ping with a note.
- **Activity is a drawer**, not a permanent third panel — a merged timeline (pings + chats) with day separators, persisted across restarts.
- **One settings window.** The main window has zero settings UI.
- **Overlay v2 — the full-screen border ping stays.** The whole-screen, click-through, always-on-top attention flash is the soul of the app and carries over intact, with every effect setting kept (color, thickness, feather, duration, circle vs. border). What's added: it finally respects DND, honors the position setting, and shows the (currently dead) quick replies as one-click response chips.
- **Agent peers.** Because v3 peers are stable identities speaking a documented protocol, an AI agent can join the network as just another peer. Presence gains a `kind: human | agent` field; agents appear in the buddy list with a badge and can be pinged and DM'd like anyone else, with real delivery states. We ship a reference bridge — a small headless daemon that speaks the Pings protocol on one side and plugs a local model or agent harness (Ollama/llama.cpp, OpenClaw-style frameworks, Hermes-class local models) into the other — and the protocol doc lets anyone write their own agent without us.
- **Real onboarding**: first run asks your name, previews the ping effect, done.

### Architecture

**Backend (Rust)**

- **Single tokio runtime, services as tasks**: `discovery`, `transport`, `store`, `windows` — each owning its state, talking over `mpsc` channels. No shared `Arc<Mutex<Everything>>`, no `.expect("poisoned")`.
- **One protocol.** Every message is one envelope on one UDP port:
  ```json
  { "v": 3, "id": "uuid", "kind": "ping|chat|ack|heartbeat",
    "from": { "peerId": "…", "name": "…" }, "ts": 0, "body": { } }
  ```
  Acks + a small retry window give real delivery states (sending → sent → delivered). The legacy v1 bridge becomes receive-only behind a feature flag, then dies.
- **Stable peer identity.** A generated `peerId` (UUID now; ed25519 pubkey later if we ever want signed messages) persisted in the profile and broadcast in discovery. Aliases, per-peer sounds, and history key off `peerId`, with IP as a routing detail.
- **Discovery = mDNS + heartbeat, no port scans.** mDNS TXT carries `peerId`, `name`, `version`, `status`; a periodic UDP heartbeat keeps `lastSeen` honest. Manual "Add by IP" stays as the escape hatch; the 254-host TCP scan becomes an explicit one-shot "Scan network" button or is deleted.
- **SQLite for history** (`rusqlite`): pings and messages survive restarts; the activity drawer and DM windows load from it.
- **Shared types**: serde structs are the single schema, with `ts-rs` generating the TypeScript types so the frontend can't drift.
- **Updater**: HTTPS + GitHub Releases, signed, no `dangerousInsecureTransportProtocol`, no dev-machine hostnames in the config. Real CSP.

**Frontend**

- **One shared core module** (`src/core/`): typed API client, event bus, state store, sound player, formatters — imported by every window. Zero copy-paste between windows.
- **Store pattern**: Rust owns the truth and pushes snapshots/deltas; windows subscribe and render. Keyed row updates instead of `innerHTML` wipes (a ~1 kB keyed-render helper or a small framework — Svelte compiles small and fits Tauri well; vanilla + keyed lists is also fine at this size).
- **Bundled audio samples** for the 5–6 sounds instead of oscillator beeps.
- **Bundled or system fonts only** — no runtime CDN fetches.

### Design system

The full visual direction is mocked up in [`docs/v3-mockup.html`](./docs/v3-mockup.html) — open it in a browser (it renders both light and dark). The rules:

- **Native first.** System font stack (SF Pro on macOS), `ui-monospace` for IPs/latency/timestamps, standard macOS titlebar with overlay traffic lights, vibrancy where it's cheap.
- **Tokens only.** Every color in the app comes from ~10 custom properties; dark mode is a token swap and nothing else. No hex values in component CSS.
- **One accent, spent carefully.** Deep teal (`#0E7C6E` light / `#34C4AE` dark) for interactive emphasis only. **Amber is reserved for the ping action** — the one loud thing in the app. Green is presence, red is failure; semantic colors never moonlight as decoration.
- **Quiet surfaces.** Elevation from 1 px borders and *subtle* shadow, not 28 px glows. Two corner radii (10 px containers, 6 px controls). 8 pt spacing grid. No gradients on controls, no colored left-bars on cards.
- **State reads at a glance**: presence dots, delivery ticks (✓ sent, ✓✓ delivered), an unread badge — form encodes state, not paragraphs of mono metadata under every row.

### Roadmap

| Phase | Scope | Outcome |
|-------|-------|---------|
| **v3.0 — Core** | peerId + envelope protocol + acks, single-runtime networking, SQLite store, kill double-delivery | Solid foundation under the existing UI |
| **v3.1 — Shell** | New main window + single settings window + DM windows on the shared frontend core | The redesign lands |
| **v3.2 — Slick** | Tray quick-ping, global shortcut, ⌘K palette, overlay v2 (full-screen border effect + DND, position, quick replies), onboarding, real sounds | The "one keystroke" promise |
| **v3.3 — Agents** | `kind: agent` presence, agent badge in the UI, reference bridge daemon for local models/harnesses, published protocol doc | AI teammates in the buddy list |
| **v3.4 — Ship** | Signed HTTPS updater, CSP, packaging, Linux port | Distributable |

### What gets deleted

The best part of v3 is the code that stops existing: the legacy socket.io runtime (eventually), the subnet scanner, the discovery-node stub, the emit-six-times context timer, the name-based window labels, the three copies of every helper, and the hidden `<pre>` debug panels.

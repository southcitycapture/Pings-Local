# Pings

> **See who's around. Ping them in one keystroke.**

Pings is a lightweight **presence utility** for macOS that lives in your
menubar. It shows everyone on your local network and lets you get someone's
attention instantly — a full-screen flash of colour on *their* screen — without
a chat app, an account, or a server in the middle. Everything travels directly,
peer-to-peer, over your LAN.

<p align="center">
  <img src="docs/images/buddy-list.png" alt="Pings buddy list" width="360">
  &nbsp;&nbsp;
  <img src="docs/images/command-palette.png" alt="Pings ⌘K command palette" width="380">
</p>

---

## What it does

**Presence at a glance.** A compact buddy list — you at the top, then everyone
on the network, one row each, with a presence dot and last-seen. Hover a row for
**Message** and an amber **Ping**; double-click to ping. That's the whole window.

**Ping in one keystroke.** The point of the app is that reaching someone is
never more than a keystroke away:
- **⌘⇧K** summons a command palette from anywhere — type two letters of a name,
  **Enter** to ping, **⌘Enter** to message.
- The **menubar tray** lists everyone around for a one-click ping.
- In the window, **⌘K** filters the list; Enter pings the top match.

**The attention flash.** The soul of the app — a whole-screen, click-through,
always-on-top border (or circle) that flashes on the recipient's display. Fully
tunable: colour, thickness, feather, duration, and shape.

**Quick-reply toast.** An incoming ping raises a small card, top-right, with the
sender, their message, and one-tap replies. It's a **non-activating panel**, so
it never steals focus from what you're doing and its replies send on the first
click.

**Do Not Disturb.** Flip it on and incoming pings make no flash, no toast, no
sound — but still land in your activity feed.

**Real messages, real delivery.** Direct messages and team chat with honest
delivery states — **✓ sent → ✓✓ delivered** once the other side receives it — and
a merged activity timeline, all persisted across restarts.

**Agent peers.** Because peers are stable identities speaking a documented
protocol, an AI agent can join the network as *just another peer* — it shows up
in the buddy list with an **AI** badge and you ping and DM it like anyone else.
A [reference bridge](./agent-bridge) plugs a local model (Ollama) into the
network in ~150 lines, and the [protocol](./docs/PROTOCOL.md) lets anyone write
their own.

**Quiet, native design.** System fonts, one accent colour spent carefully,
token-based light/dark that's a single swap, no gradients and no runtime CDNs.
First-run onboarding asks your name and previews the ping effect.

**Signed auto-updates.** HTTPS updates from GitHub Releases, signature-verified
before installing.

## How it works

- Built on **[Tauri](https://tauri.app)** — a Rust core with a web UI — macOS
  first (Apple Silicon + Intel).
- **No servers, no cloud, no accounts.** Peers are discovered on your LAN via
  **mDNS/Bonjour**; pings and messages travel directly over **UDP**.
- **Stable identity:** every peer has a persistent `peerId`, so aliases, history,
  and delivery all key off identity rather than a DHCP-assigned IP. One JSON
  envelope protocol on two ports, with acks for delivery states — the full wire
  contract is in **[docs/PROTOCOL.md](./docs/PROTOCOL.md)**.
- **Persistence:** SQLite keeps every ping and message across restarts.

## Status

**Feature-complete.** The full v3 line is built and verified on real hardware:

| Phase | What |
|-------|------|
| v3.0 | peerId + envelope protocol + acks, single-runtime networking, SQLite store |
| v3.1 | redesigned buddy-list shell + single settings window on a shared design system |
| v3.2 | tray quick-ping, global shortcut, ⌘K palette, overlay v2, DND, onboarding |
| v3.3 | agent peers + reference bridge + published protocol |
| v3.4 | signed HTTPS updater, real CSP, packaging |

Linux and Windows are a planned future port.

## Install it on a machine

**Download the app (once a release is published).** Grab the latest `.dmg` from
[**Releases**](https://github.com/southcitycapture/Pings-Local/releases/latest)
and drag **Pings** to Applications — or from a terminal:

```bash
gh release download --repo southcitycapture/Pings-Local --pattern "*.dmg"
open Pings_*.dmg
```

Until Apple notarization is wired up, macOS Gatekeeper warns on first launch:
**right-click `Pings.app` → Open** once, then it opens normally after that.
(Cutting that first release is a one-time setup — see
[Building a release](#building-a-release).)

**Or build it yourself right now.** Needs the Xcode command-line tools,
[Rust](https://rustup.rs), and Node 18+:

```bash
# one-time toolchain (skip whatever you already have)
xcode-select --install
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
brew install node

# build + install
git clone https://github.com/southcitycapture/Pings-Local.git
cd Pings-Local
npm install
npm run tauri build -- --config '{"bundle":{"createUpdaterArtifacts":false}}'
open src-tauri/target/release/bundle/dmg/     # drag Pings.app to Applications
```

The `--config` flag skips the signed-updater artifacts (which need the release
signing key) — fine for a personal install; drop it when building a real
release. To run it without installing, use `npm run tauri dev` (below).

## Getting started (development)

```bash
npm install
npm run tauri dev
```

You need **two machines on the same Wi-Fi / subnet** to see each other — some
guest and corporate networks isolate clients; see
[docs/TESTING.md](./docs/TESTING.md) for the network gotchas. To try an AI peer
on one machine, see [agent-bridge](./agent-bridge).

### Building a release

Releases are built and signed by CI on a version tag — see
[UPDATER_SETUP.md](./UPDATER_SETUP.md). In short: bump the version, push a `v*`
tag, and GitHub Actions produces a signed `.dmg` and the auto-update manifest.

## Docs

- **[docs/PROTOCOL.md](./docs/PROTOCOL.md)** — the wire protocol (build your own peer or agent)
- **[V3_PLAN.md](./V3_PLAN.md)** — design direction, architecture, and roadmap
- **[agent-bridge/](./agent-bridge)** — the reference AI-peer daemon
- **[UPDATER_SETUP.md](./UPDATER_SETUP.md)** — updater and release process
- **[docs/TESTING.md](./docs/TESTING.md)** — two-machine testing and network notes
</content>

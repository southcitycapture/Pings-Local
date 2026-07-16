# Pings

> **See who's around. Ping them in one keystroke.**
>
> **Beta** — desktop on macOS (primary) + Linux, a team server, and a phone
> client. One protocol, one repo.

Pings is a lightweight **presence utility** that lives in your menubar. It shows
everyone on your local network and lets you get someone's attention instantly — a
full-screen flash of colour on *their* screen — without a chat app, an account,
or a server in the middle. Everything travels directly, peer-to-peer, over your
LAN — and when your team outgrows one network, the **Dispatch** server carries
it across offices, tailnets, and phones.

## The Pings family

| | What | Where |
|---|---|---|
| **Pings** | The desktop app: buddy list, one-keystroke pings, the flash, DMs, agents. Serverless on your LAN, free forever. | macOS (primary) · Linux (beta) |
| **Pings Dispatch** | The team server: roster across networks, per-device tokens, a content-blind relay for peers that can't route to each other, an admin dashboard. Run it headless (CLI/Docker) — or just tick **"Host the team server"** inside Pings. | [`dispatch/`](./dispatch) |
| **Pings Go!** | The phone client, served *by* Dispatch at `/go`: join with a team key, live roster, tap-to-ping with the full-screen flash, DMs with ✓✓. Installable as a PWA — no app store. | any phone browser |

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

**Beyond the LAN — Dispatch.** Point Pings at a
[Dispatch](./dispatch) server (Options → Network) and the buddy list fills
across subnets, offices, and tailnets. Peers that can route to each other
still talk directly; peers that can't get **relayed** through the server —
content-blind frames, honest ✓✓ acks either way. Each device holds its own
revocable token; an **admin dashboard** at `/admin` shows the roster and cuts
devices off in one click. Don't want to run a server? Any teammate can *be*
the server: **Options → Network → "Host the team server on this computer."**

**Your team, on phones.** The same Dispatch serves **Pings Go!** at `/go` —
open it on a phone, join with the team key, and the phone is pingable: the
full-screen flash (with sound and vibration), DMs with delivery ticks, add-to-
home-screen. Native apps with push notifications are the
[next step](./docs/GO-NATIVE-HANDOFF.md).

## How it works

- Built on **[Tauri](https://tauri.app)** — a Rust core with a web UI — macOS
  first (Apple Silicon + Intel), with a Linux build (`.deb` / `.AppImage` /
  `.rpm`) in beta. The macOS-only bits (the non-activating NSPanel toast) are
  cfg-gated and fall back to a normal window elsewhere.
- **No servers required, no cloud, no accounts.** Peers are discovered on your
  LAN via **mDNS/Bonjour**; pings and messages travel directly over **UDP**.
  Dispatch is strictly additive — a roster + relay your team can self-host
  (one Rust binary, or the checkbox inside Pings); the LAN app never phones
  home and never needs it.
- **Stable identity:** every peer has a persistent `peerId`, so aliases, history,
  and delivery all key off identity rather than a DHCP-assigned IP. One JSON
  envelope protocol on two ports, with acks for delivery states — the full wire
  contract is in **[docs/PROTOCOL.md](./docs/PROTOCOL.md)**.
- **Persistence:** SQLite keeps every ping and message across restarts.

## Status

**Beta.** The desktop v3 line is built and verified on real Mac hardware, the
Linux build is in beta testing, and the Dispatch line is built and verified
end-to-end (unit tests + live server + headless-browser E2E), pending its
on-device pass:

| Phase | What |
|-------|------|
| v3.0 | peerId + envelope protocol + acks, single-runtime networking, SQLite store |
| v3.1 | redesigned buddy-list shell + single settings window on a shared design system |
| v3.2 | tray quick-ping, global shortcut, ⌘K palette, overlay v2, DND, onboarding |
| v3.3 | agent peers + reference bridge + published protocol |
| v3.4 | signed HTTPS updater, real CSP, packaging |
| Linux (beta) | cross-platform build — macOS-only NSPanel cfg-gated, `.deb`/`.AppImage`/`.rpm` in CI |
| Efficiency pass | hot-path rework: cached interface set, one send socket, coalesced UI updates, −74% startup bundle |
| Dispatch D0–D1 | Add-by-IP, Tailscale interface preference, the rendezvous server + Team-server client |
| Dispatch D2 | per-device tokens (enroll/revoke), TLS, the content-blind relay with per-send transport choice |
| Dispatch D3 | host mode (the server as an Options checkbox), admin dashboard at `/admin` |
| Pings Go! | phone client at `/go`: roster, flash, DMs with ✓✓, PWA — native + push handed off to the Mac-side project |

macOS is the primary desktop build; the Linux beta follows behind. Linux
auto-update isn't wired yet — beta testers re-download new builds for now.
Windows is a possible future port. The road past 1.0 (tiers, pricing,
sequencing) lives in [docs/PRODUCT-LINE.md](./docs/PRODUCT-LINE.md).

## Install it on a machine

Pings isn't code-signed with an Apple Developer ID yet, so the cleanest way to
put it on a Mac today is to **clone and build it** — a locally built app runs
straight away, without the Gatekeeper prompt a downloaded unsigned `.dmg` would
trigger.

### Clone & build (current method)

Needs the Xcode command-line tools, [Rust](https://rustup.rs), and Node 18+:

```bash
# one-time toolchain (skip whatever you already have)
xcode-select --install
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
brew install node

# pull, build, install
git clone https://github.com/southcitycapture/Pings-Local.git
cd Pings-Local
npm install
npm run tauri build -- --config '{"bundle":{"createUpdaterArtifacts":false}}'
open src-tauri/target/release/bundle/dmg/     # drag Pings.app to Applications
```

The `--config` flag skips the signed-updater artifacts (which need the release
signing key), so no key is required for a local install. To just run it without
installing, use `npm run tauri dev`.

### Linux (beta)

The Linux build is in beta. Grab a `.deb`, `.AppImage`, or `.rpm` from a
published release, or build it yourself. Building needs [Rust](https://rustup.rs),
Node 18+, and the WebKitGTK / GTK system libraries:

```bash
# Debian/Ubuntu system deps
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
  librsvg2-dev libssl-dev libxdo-dev build-essential curl wget file patchelf

# pull, build, install
git clone https://github.com/southcitycapture/Pings-Local.git
cd Pings-Local
npm install
npm run tauri build -- --config '{"bundle":{"createUpdaterArtifacts":false}}'
# installers land in src-tauri/target/release/bundle/{deb,appimage,rpm}/
```

The quick-reply toast falls back to a normal always-on-top window on Linux (the
non-activating panel is macOS-only); everything else — discovery, the attention
flash, chat, agents — works the same.

### Download a release (once one is published)

When a release is cut (see [Building a release](#building-a-release)), installing
becomes a plain download — no toolchain needed. Grab the `.dmg` on macOS, or the
`.deb` / `.AppImage` / `.rpm` on Linux:

```bash
# macOS
gh release download --repo southcitycapture/Pings-Local --pattern "*.dmg"
open Pings_*.dmg     # right-click → Open on first launch until notarized

# Linux (pick your format)
gh release download --repo southcitycapture/Pings-Local --pattern "*.AppImage"
chmod +x Pings_*.AppImage && ./Pings_*.AppImage
```

### Set up a team (Dispatch + phones)

The five-minute version, no separate server install:

1. On one machine, open Pings → **Options → Network** → tick **"Host the team
   server on this computer."** A host key appears — share it with the team.
2. Everyone else: **Options → Network → Team server** = the host's IP
   `:43217`, plus the key. The buddy list fills, even across subnets/tailnets.
3. Phones: open `http://<host-ip>:43217/go`, join with the same key, **Add to
   Home Screen**. The phone is now pingable — flash and all.
4. Admin view: `http://<host-ip>:43217/admin` (sign in with the key).

For an always-on server (VPS, Docker, a spare tailnet node) use the headless
CLI instead — see [`dispatch/`](./dispatch), including TLS setup for anything
that leaves a trusted overlay network.

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

Releases are built by CI on a version tag — see
[UPDATER_SETUP.md](./UPDATER_SETUP.md). In short: bump the version, push a `v*`
tag, and GitHub Actions builds a `macOS + Linux` matrix into a **draft** release —
a signed universal `.dmg` (with the macOS auto-update manifest) plus Linux
`.deb` / `.AppImage` / `.rpm`.

## Docs

- **[docs/PROTOCOL.md](./docs/PROTOCOL.md)** — the wire protocol + Dispatch HTTP/WS API (build your own peer, agent, or client)
- **[dispatch/](./dispatch)** — the team server: run modes, security model, API, smoke tests
- **[V3_PLAN.md](./V3_PLAN.md)** — design direction, architecture, and the desktop roadmap
- **[docs/PRODUCT-LINE.md](./docs/PRODUCT-LINE.md)** — the road past 1.0: Pings (free) · Pings Dispatch (server, paid) · Pings Go! (mobile)
- **[docs/DISPATCH-PLAN.md](./docs/DISPATCH-PLAN.md)** — the phased Dispatch/Go! build plan, with per-phase status
- **[docs/GO-NATIVE-HANDOFF.md](./docs/GO-NATIVE-HANDOFF.md)** — the punch list for native Pings Go! (push notifications)
- **[agent-bridge/](./agent-bridge)** — the reference AI-peer daemon
- **[UPDATER_SETUP.md](./UPDATER_SETUP.md)** — updater and release process
- **[docs/TESTING.md](./docs/TESTING.md)** — two-machine testing and network notes
</content>

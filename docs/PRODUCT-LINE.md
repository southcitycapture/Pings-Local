# The Pings product line

> Status: **plan.** Pings (the free desktop app) is in Beta 0.3.5 and
> feature-frozen toward 1.0. Everything else in this document is post-1.0 and
> nothing here is built yet. The build plan lives in
> [DISPATCH-PLAN.md](./DISPATCH-PLAN.md).

## The one-sentence version

**Pings** stays the free, serverless LAN tool people love; **Pings Dispatch**
is the paid server that takes it across networks and into the enterprise;
**Pings Go!** is the mobile companion that rides on Dispatch.

## Why a product line at all

Pings' core promise — see who's around, get their attention in one keystroke —
is delivered entirely peer-to-peer on the local network. That's its charm and
its ceiling. The moment a team says *"it doesn't work between our two
offices"* or *"can I get pinged on my phone?"*, the answer requires a server:
something always-on that introduces peers across networks and pushes to
devices that can't listen. Servers cost money to run and money to secure —
which is exactly what makes them the natural paid tier. The free app never
gets worse to make the paid one look better; the paid one exists where the
free one physically cannot go.

## The three products

### Pings — free, forever

The desktop app as it ships today. mDNS discovery, UDP pings/chat, the border
flash, agents, history — all local, no accounts, no server, no telemetry.

- **Audience:** homes, studios, single-office teams, anyone on one LAN.
- **Price:** free. This is the adoption engine and the reputation.
- **Promise that never breaks:** everything that works today keeps working
  with no account and no internet, forever. Dispatch is added around the free
  app, never carved out of it.

### Pings Dispatch — the server, paid

A small always-on service a team points their Pings clients at. It does what
multicast can't:

- **Cross-network presence** — one roster across subnets, VLANs, offices, and
  overlay networks (Tailscale is the flagship deployment: see
  [DISCOVERY-SERVER.md](./DISCOVERY-SERVER.md)). Peers that can route to each
  other still talk peer-to-peer; Dispatch just introduces them.
- **Relay** — when two peers *can't* route to each other (opposite sides of
  NAT), Dispatch forwards the envelopes, so pings work across the internet.
- **Push gateway** — the bridge that makes Pings Go! possible (mobile OSes
  only wake for push notifications; someone has to send them).
- **Enterprise glue** — team directory and admin, SSO, audit/retention for
  history, fleet configuration (default ping settings, DND policies), and the
  security upgrades the open internet demands (see below).

- **Audience:** multi-site companies, remote teams, MSPs.
- **Price shape:** per-seat subscription, or a flat self-hosted license.
  (Self-hosted matters: the kind of team that loves a LAN-first tool is the
  kind of team that wants to run its own server.)
- **Deployment:** a single binary/container. First-class on a tailnet, fine on
  a plain VPS.

### Pings Go! — mobile, the Dispatch companion

Pings on your phone. Sees the team roster, sends pings and messages, and —
the headline — **receives a ping as a push notification** when you're away
from your desk.

> Shipping in two steps: the **web companion is built** — served by
> Dispatch at `/go`, installable as a PWA, full flash/DM/ack experience
> while open (no accounts, no app store). The **native app** adds
> receiving-while-closed via push; its punch list is
> [GO-NATIVE-HANDOFF.md](./GO-NATIVE-HANDOFF.md) and it starts when the
> Apple Developer account exists.

- **Hard dependency:** Dispatch. This is a technical fact, not a marketing
  choice: iOS and Android will not let an app listen on UDP ports or browse
  mDNS in the background, and iOS has no full-screen flash over other apps. A
  ping reaches a sleeping phone only as a push notification, and push requires
  a server. So Go! without Dispatch cannot exist honestly — and Go! is
  therefore the strongest single reason a happy desktop team upgrades.
- **The mobile "flash":** a full-screen notification/alert *within what each
  OS allows* — critical-alert style on iOS (with the user's permission),
  full-screen intent on Android. The soul of the ping survives; the
  implementation differs per platform.
- **Codebase:** Tauri 2 ships iOS/Android targets, so Go! can share the Rust
  core and much of the web UI rather than being a rewrite.
- **Price shape:** free app; requires a Dispatch-connected team (that's where
  the money already is).

## Sequencing (and why this order)

1. **Now → Pings 1.0.** Feature freeze holds. Run the beta (macOS primary,
   Linux following), fix friction, sign the mac build when the developer
   account exists, ship 1.0. Nothing below starts until this ships.
2. **Dispatch first.** It unlocks revenue *and* is Go!'s prerequisite.
   Build it in the order the build plan lays out: rendezvous → relay → push →
   enterprise. Each stage is independently shippable and sellable.
3. **Go! second,** starting as a thin companion (roster + send + push
   receive), growing toward full parity where the platforms allow.

## The security line

The free LAN product trusts the network — unauthenticated, unencrypted UDP
JSON between desks is an acceptable, honest trade on a trusted LAN, and
changing it there would cost simplicity for little gain.

**Dispatch crosses that line.** The moment envelopes leave the LAN:

- every client authenticates (team key to start, SSO later),
- every hop is encrypted (ride Tailscale/WireGuard for transport in v1 — it's
  the deployment we're targeting anyway — TLS on the relay for the open
  internet after),
- the server authorizes who may register, list, and relay.

This is the honest technical cost of the paid tier, priced in from the start —
not a retrofit after an incident.

## What we deliberately don't build

- **No cloud-required version of the free app.** Pings never phones home.
- **No feature-gating the LAN.** If it works on one subnet today, it's free
  forever.
- **No chat platform.** Pings is presence + attention + quick words. It ends
  where Slack begins; Dispatch doesn't change that, it just widens the room.

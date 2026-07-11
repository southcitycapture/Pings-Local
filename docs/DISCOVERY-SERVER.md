# Future direction: a Pings discovery server (and Tailscale mode)

> Status: **absorbed into the product plan.** This idea grew into **Pings
> Dispatch** — see [PRODUCT-LINE.md](./PRODUCT-LINE.md) for the product tiers
> and [DISPATCH-PLAN.md](./DISPATCH-PLAN.md) for the phased build (this
> document is the technical seed for phase D1). Nothing here is built yet.

## The premise

Today Pings finds peers with mDNS/Bonjour — multicast on the local link. That's
perfect for the zero-config home/office case and nothing should change there.
But multicast doesn't cross most interesting boundaries: guest Wi-Fi with client
isolation, separate VLANs/subnets, and — the one we care about — **overlay
networks like Tailscale**.

The fix is a small **rendezvous (discovery) server**: a always-on process peers
register with and query over plain unicast. It replaces "shout on the local
wire" with "ask a known address who's around." One idea, three payoffs:

1. **mDNS-blocked networks** — discovery works where multicast is filtered.
2. **Cross-subnet / multi-site** — peers that can't hear each other's multicast
   but *can* route to each other still connect.
3. **Remote teams over Tailscale** — a flat, routable overlay where every device
   has a stable address but multicast doesn't flow. See below.

This is the natural "enterprise / teams" tier. Home stays free and zero-config
(mDNS); enterprise is "point Pings at your server."

## Why Tailscale is the killer case

Tailscale gives every device a stable `100.x.y.z` address (the CGNAT
`100.64.0.0/10` range) and makes them mutually routable from anywhere —
different offices, home, a coffee shop — subject to your ACLs. It's like one big
flat LAN, except:

- **It does not carry multicast/broadcast.** It's a unicast overlay, so standard
  mDNS discovery simply doesn't work across a tailnet.
- **But unicast does work.** Pings' actual transport — the UDP ping on `43210`
  and chat on `43211` — already talks unicast to a single address. Send those to
  a `100.x` address and they just flow. **The transport needs no changes; only
  discovery does.**

So "Pings over Tailscale" = give peers a way to learn each other's `100.x`
addresses without multicast. Two ways to do that:

- **A discovery server on the tailnet.** Run one node as the Pings server; every
  peer registers with it and pulls the roster. Fully automatic.
- **Manual peer list ("Add by IP").** For a handful of machines, just add each
  other's Tailscale IPs (or MagicDNS names). No server needed. This is the
  cheap first step and a good escape hatch regardless.

## What's already in the codebase pointing here

This idea isn't from scratch — v2 left hooks that line up with it:

- **A vestigial discovery-node setting.** `set_discovery_node_ip` /
  `discovery_node_ip` already exist (with a UI field). In v2 they were a dead
  stub — stored a value, faked a "not-connected" status, and nothing ever dialed
  it. That control is the seam a real discovery-server client slots into.
- **Tailscale/CGNAT awareness — currently backwards.** `interface_penalty()`
  explicitly *penalizes* interfaces named `tailscale`/`utun`/`wireguard`, and
  `is_carrier_grade_nat_ipv4()` detects the `100.64/10` range. So the app already
  recognizes a Tailscale interface — it just deprioritizes it, because for a LAN
  that's the right call. A "Tailscale mode" would flip this: prefer the `100.x`
  interface so we advertise and send from the tailnet address.
- **`preferred_ip` already works.** A user can point Pings at their `100.x`
  address today via the preferred-interface setting; that alone gets pings/chat
  flowing over Tailscale once peers know each other. A Tailscale mode would just
  automate this + the discovery half.
- **One protocol, stable peer IDs.** Because v3 peers already speak a single
  envelope keyed by a stable `peerId`, a discovery server is "just another
  participant/source," not a rewrite. Discovery becomes: mDNS **or** server
  **or** manual list — all feeding the same peer table.

## Rough shape (when/if we build it)

- **Server**: a tiny service (could be the same Rust core, headless) exposing
  `register(peerId, name, addr)` + `heartbeat` + `list()`. Optionally a
  message **relay** so it also works across the internet without direct
  routability. Auth via a shared team key or a Tailscale ACL.
- **Client**: teach the app a "discovery source" abstraction — `mdns`,
  `server(url)`, `static(list)` — merged into the existing peer table. Wire the
  old discovery-node field to the real client. Add a "prefer Tailscale interface"
  toggle (auto-detect the `100.x`/`tailscale*` interface).
- **Tiers**: home = mDNS only (unchanged). Teams/enterprise = server URL (or a
  Tailscale IP) + team key. Small teams = manual "Add by IP" with MagicDNS names.

## Cheapest first step

If we want a taste before building a server: ship **"Add by IP,"** and make the
app happily **prefer/advertise a Tailscale `100.x` interface**. That alone makes
"a couple of laptops on a tailnet ping each other" work — no server required —
and it's a small, self-contained change on top of the existing `preferred_ip`
and one-protocol foundation.

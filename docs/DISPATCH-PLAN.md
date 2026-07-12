# Build plan: Pings Dispatch + Pings Go!

> Status: **plan, post-1.0.** Nothing here is scheduled until Pings 1.0 ships
> (see the freeze in [PRODUCT-LINE.md](./PRODUCT-LINE.md)). The technical seed
> for phase D1 is [DISCOVERY-SERVER.md](./DISCOVERY-SERVER.md); this document
> turns it into a phased build with the same discipline as V3_PLAN.md: every
> phase independently shippable, tested on real hardware before the next.

## Architecture in one paragraph

Dispatch is **one headless Rust binary** (sharing this repo's core types —
`PeerInfo`, the envelope structs, the protocol) that plays three roles a team
can enable one at a time: **directory** (who's around — replaces multicast
with unicast register/list), **relay** (forward envelopes between peers that
can't route to each other), and **push gateway** (deliver pings to mobile via
APNs/FCM). Clients keep talking the existing JSON envelope protocol
([PROTOCOL.md](./PROTOCOL.md)); Dispatch is *another participant*, not a new
protocol. The desktop app grows one new abstraction — a **discovery source**
(`mdns` | `server(url)` | `static list`) feeding the existing peer table — and
everything downstream (buddy list, pings, chat, acks, history, agents) works
unchanged.

## Phase D0 — client seams (ships in a free Pings point-release)

> Status: **built** (Add-by-IP + overlay preference; verified headless, needs
> the usual on-device pass). Two items moved to D1 deliberately: the formal
> `DiscoverySource` trait (a static list turned out to be a re-seed loop, not
> a source — the trait earns its keep when the *server* source arrives) and
> wiring `discovery_node_ip` (it becomes the Dispatch URL field).

Small, free-tier-safe changes that make the desktop app Dispatch-ready and are
useful on their own:

- **"Add by IP" (static source).** A manual peer list in Options (one IPv4
  per line — MagicDNS names deferred so unresolved names can't become ghost
  rows). Entries join the peer table immediately, are exempt from
  stale-pruning, and the existing heartbeat/ack cycle fills in their real
  name/peerId and keeps presence honest. This is DISCOVERY-SERVER.md's
  "cheapest first step" — two laptops on a tailnet work *today*, no server,
  and it's the escape hatch forever.
- **Tailscale-friendly interface pick.** A "prefer overlay network" toggle
  that flips the `interface_penalty`/CGNAT bias so the app advertises its
  `100.x` address. (The detection code already existed — it penalized exactly
  what this prefers.)

**Verify:** two machines, mDNS off, static list over a tailnet — ping + chat +
acks round-trip. This phase alone closes the "two offices, small team" gap for
technical users.

## Phase D1 — Dispatch directory (first paid artifact)

> Status: **built** (server + client + Options UI; server verified live with
> curl, client verified by unit tests + compile — needs the two-machine
> tailnet pass). Implementation notes vs. the plan below: `dispatch/` is a
> **standalone crate**, not a workspace member — the `pings-core` extraction
> waits until Go! actually needs shared types, and the wire contract is the
> JSON in PROTOCOL.md either way. `heartbeat` was merged into `register`
> (an idempotent upsert *is* a heartbeat; one endpoint fewer). Roster
> updates are plain polling at the heartbeat cadence, as planned.

The rendezvous server, smallest sellable form:

- **Server:** new `dispatch/` crate in this repo (own binary + Dockerfile).
  Endpoints: `register(peerId, name, kind, addr, port)`, `heartbeat`,
  `list()`, `deregister`. HTTP+JSON to start (reuses serde types from the
  core; trivial to debug with curl). In-memory roster with the same staleness
  rules as the desktop peer table (`PEER_STALE_MS`).
- **Auth v1:** a per-team shared key (`Authorization: Bearer`), constant-time
  compared, set by server config. SSO comes in D3 — do not gold-plate here.
- **Transport security v1:** none of our own — **deploy on the tailnet** and
  let WireGuard carry it. Document this loudly. (TLS lands in D2 with the
  relay, where open-internet deployment first becomes sane.)
- **Client:** `server(url, team_key)` discovery source — register on start,
  heartbeat on the existing 30s cadence, poll `list()` (long-poll/SSE later
  if polling chafes). Peers learned from the server merge into the same peer
  table; pings/chat still flow **direct peer-to-peer** — Dispatch only
  introduces.
- **Options UI:** a "Team server" section — URL + key + connection status
  (the `discovery_node_connected` diagnostic finally becomes real).

**Verify:** three machines on a tailnet with multicast dead: all see each
other via Dispatch, pings/chat direct, roster survives server restart
(clients re-register on heartbeat), stale peers age out. **This is the moment
Dispatch is sellable to Tailscale-using teams.**

## Phase D2 — relay + hardening (Dispatch on the open internet)

> Status: **built** (tokens + TLS + relay; server verified live — TLS boot
> with a real cert pair, enrollment/revocation over HTTPS, and a two-client
> WebSocket relay integration test — client verified by unit tests +
> compile; needs the cross-NAT two-machine pass). Deviations: clients keep
> **UDP** for direct traffic (the plan's "everything over one WebSocket" was
> unnecessary — the socket exists for relay only, and transport is chosen
> per-send by direct-evidence freshness); team chat stays LAN/UDP for now
> (roster-wide relay fanout deferred); the E2EE decision below is still
> open, but the relay is already content-blind so it stays purely additive.
>
> **Post-D2 addition — host mode.** Dispatch ships in two forms off one
> library: the headless CLI (TLS-capable, for VPS/container/tailnet-node
> deployments) and an **embedded host inside the Pings desktop app**
> (Options → Network → "Host the team server on this computer") — the app
> spawns the same server in-process, mints and displays a shareable host
> key, and auto-joins its own roster. Small teams get a server by flipping
> a checkbox; the CLI remains the grown-up deployment.

- **Relay:** when a direct send fails (or the roster marks a peer
  unroutable), the client posts the envelope to Dispatch; Dispatch forwards
  it to the recipient over the recipient's persistent connection. Requires
  clients to hold one outbound connection (WebSocket) — which NAT permits —
  instead of relying on inbound UDP. Acks ride the same path, so delivery
  states stay honest.
- **TLS everywhere** (rustls; ACME/Let's Encrypt for the public case).
- **Auth v2:** per-device tokens issued on first join (team key becomes the
  *enrollment* secret, not the session secret), revocable server-side.
- **Message confidentiality decision point:** at minimum, transport
  encryption (TLS to the relay). Evaluate end-to-end encryption of envelope
  *payloads* here (peers already have stable IDs to hang keys off) — decide
  with real customer input, because E2EE constrains D3's audit feature and
  it's better to choose deliberately than drift.

**Verify:** two machines on different home NATs, no VPN: ping + chat + acks
via relay, ✓✓ delivered states correct, TLS verified, a revoked device is
actually cut off.

## Phase D3 — enterprise Dispatch

> Status: **admin surface built** — `GET /admin` serves a self-contained
> dashboard baked into the binary (team-key sign-in, stat tiles, live roster
> with presence, device list with one-click revoke, 5s auto-refresh), backed
> by a new team-key-only `GET /v1/status` vitals endpoint. Verified live:
> real server + headless browser, including a revoke round-trip through the
> UI. The remaining D3 items (SSO, audit/retention, key rotation, settings
> push, multi-tenant) stay deferred until real customer input — building
> them speculatively would guess at requirements we can just wait to hear.

Only what real customers ask for, in the order they ask:

- **Admin surface** (web page served by Dispatch): roster, device management,
  key rotation, team settings push (default ping config, DND policy).
- **SSO** (OIDC first — Google/Microsoft/Okta cover most).
- **Audit/retention:** server-side history of pings/messages *if the team
  enables it* (tension with E2EE decided in D2 — surface, don't bury).
- **Multi-team/tenant** if MSP interest materializes.

## Phase G1 — Pings Go! companion (needs D2)

> Status: **built, as the web companion** — Dispatch serves Pings Go! at
> `/go`: sign-in (name + team key → auto-enroll), live roster, tap-to-ping
> with the full-screen flash + sound + vibration, DM threads with ✓✓ acks,
> installable as a PWA. Everything rides the relay socket (which now also
> accepts `?token=` since browsers can't set WS headers); phones register
> a `go-<id>` pseudo-address so desktops relay to them automatically.
> Verified end-to-end: two headless mobile browsers against the real
> server — join → roster → ping (flash on the receiving phone) → DM (✓✓).
> **Deliberate deviation from the plan below:** the Tauri-native app and
> push notifications require Xcode, an Apple Developer account, and
> APNs/FCM credentials — none of which exist yet — so they move to a
> Mac-side project with a full punch list in
> [GO-NATIVE-HANDOFF.md](./GO-NATIVE-HANDOFF.md). The web version is what
> "no accounts, no app store, works today" looks like; native adds
> receiving-while-closed.

Thin client, maximum leverage:

- **Tauri 2 mobile targets** (iOS + Android) sharing the Rust core: envelope
  types, the Dispatch client, and the token/auth code all come along; UI
  reuses the design tokens.
- **Scope:** sign in to a Dispatch team → roster with presence → send pings
  and DMs → **receive pings as push notifications** (APNs/FCM sent by
  Dispatch's push gateway; that gateway is why G1 needs D2's persistent
  connections and device tokens).
- **The mobile "flash":** iOS time-sensitive/critical alerts (entitlement +
  user opt-in), Android full-screen intent + accent color. Sound + border
  color come through in the payload — the ping still *feels* like Pings.
- **Non-goals in G1:** no LAN/mDNS mode (the OSes make it a background
  fiction), no team chat, no history browsing. Send, receive, roster. Ship.

**Verify:** phone in pocket, screen locked, someone pings from a desktop on
another network — the phone lights up inside a second or two, tap opens the
DM.

## Phase G2 — Go! grows up

Informed by G1 usage: DM history sync via Dispatch, team chat, foreground
"same-Wi-Fi" direct mode where feasible, agents on mobile (they're just
peers), Watch/Wear complications for the truly keyboard-averse.

## Repo & release mechanics

- **Monorepo:** `dispatch/` (server crate) and later `go/` (mobile) live
  beside `src-tauri/` — shared types are the whole point. The workspace
  gains a `pings-core` crate (envelopes, PeerInfo, constants) that
  `src-tauri`, `dispatch`, and mobile all depend on; extracting it is D0/D1
  chore work, not a rewrite.
- **CI:** the existing release matrix gains a `dispatch` job (Linux
  container + binary). Mobile builds arrive with G1 (macOS runner for iOS,
  plus Android SDK job).
- **Versioning:** desktop app and Dispatch version independently;
  the *protocol* is versioned in PROTOCOL.md and both sides advertise it —
  that's the compatibility contract, same as v1/v2/v3 interop today.

## Open questions (decide when their phase starts, not before)

1. **Long-poll vs SSE vs WebSocket for D1 roster updates** — start with dumb
   polling at heartbeat cadence; upgrade only if it chafes.
2. **E2EE payloads** (D2) — security win vs D3 audit conflict; needs a real
   customer conversation.
3. **Licensing model for self-hosted Dispatch** (D1 ship time) — per-seat
   subscription vs flat license vs open-core the directory and charge for
   relay+push.
4. **Go! notification entitlements** (G1) — iOS critical alerts need Apple
   approval; time-sensitive is the fallback. Prototype early, it's the
   riskiest permission.
5. **Does the free desktop app get push too** (post-G1) — "ping my phone when
   my laptop's asleep" blurs the tier line; decide with the pricing hat on.

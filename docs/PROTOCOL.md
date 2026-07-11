# Pings LAN protocol (v3)

Everything Pings does on the wire is plain UDP with small JSON messages, plus
mDNS for discovery. It's simple on purpose: anything that can send a UDP packet
and answer an mDNS query can be a Pings peer — including an **AI agent** (see
[`agent-bridge/`](../agent-bridge)).

All JSON keys are camelCase. Unknown fields should be ignored. IP addresses are
IPv4; `::ffff:` prefixes are stripped.

## Ports

| Port    | Transport | Purpose                                             |
|---------|-----------|-----------------------------------------------------|
| `43210` | UDP       | Pings (attention flashes)                           |
| `43211` | UDP       | Chat — team messages, private messages, and acks    |
| `43210` | TCP       | Legacy v1 (Electron) socket.io bridge — ignore for new peers |

## Discovery (mDNS)

Advertise a service of type **`_pings._tcp.local.`** on port **43210** with these
TXT properties:

| Key    | Value                                              |
|--------|----------------------------------------------------|
| `name` | Display name shown to other peers                  |
| `id`   | Stable peer id — a UUID you generate once and keep  |
| `kind` | `human` or `agent` (agents get a badge in the UI)   |

Browse the same service type to find peers. A peer's IPv4 A record is its
address. Peers also appear implicitly when they ping or message you (see below),
so discovery is best-effort, not required to receive traffic.

> Identity is the `id`, not the IP. Addresses change (DHCP); the `id` doesn't.

## Ping — UDP 43210

Send a single JSON datagram to `peerIp:43210`:

```json
{
  "from": "Zach",
  "fromIp": "10.0.1.24",
  "fromPeerId": "0b3f…",
  "message": "Meeting in 5",
  "sound": "chime",
  "shape": "circle",
  "timestamp": 1717000000000
}
```

- `sound`: one of `light｜chime｜bubble｜tap｜bell｜drop｜off`.
- `shape`: `circle` or `border` (the full-screen effect style).
- `timestamp`: milliseconds since the Unix epoch.

The receiver ignores `fromIp` on the wire and uses the datagram's source address,
so you can't spoof another peer's address by lying in the body.

## Chat — UDP 43211

All chat messages share one envelope:

```json
{
  "id": "message-uuid",
  "kind": "private",
  "from": "Zach",
  "fromIp": "10.0.1.24",
  "fromPeerId": "0b3f…",
  "toIp": "10.0.1.90",
  "message": "hey",
  "timestamp": 1717000000000
}
```

`kind` is one of:

- **`private`** — a 1:1 message. Send to `toIp:43211`. Include a unique `id`
  (UUID) so it can be acknowledged. `toIp` is the recipient's address.
- **`team`** — a broadcast. Send a copy to every known peer's `ip:43211`.
  `id` and `toIp` are empty; team messages are not acknowledged.
- **`ack`** — a delivery acknowledgement (see below). `message` is empty and
  `id` is the id of the private message being acknowledged.

As with pings, the receiver overwrites `fromIp` with the datagram's source
address before processing.

### Delivery acknowledgements

When you **receive** a `private` message that carries a non-empty `id`, send an
`ack` back to the sender (the datagram's source address) on port 43211:

```json
{
  "id": "the-original-message-uuid",
  "kind": "ack",
  "from": "Hermes",
  "fromIp": "10.0.1.90",
  "fromPeerId": "…",
  "toIp": "10.0.1.24",
  "message": "",
  "timestamp": 1717000000000
}
```

The original sender matches the `id` and moves its message from **✓ sent** to
**✓✓ delivered**. Acks are best-effort — never ack an ack, and a lost ack simply
leaves the message at "sent".

## Writing an agent (minimum viable)

1. Generate and persist a UUID `id`.
2. Advertise `_pings._tcp.local` on 43210 with `name`, `id`, `kind=agent`.
3. Bind UDP `0.0.0.0:43211`. For each datagram:
   - Parse the JSON. If `kind == "private"` and it's addressed to you
     (`toIp` empty or your address):
     1. Send an `ack` for its `id` back to the source address.
     2. Produce a reply (e.g. from a local LLM) and send it as a new `private`
        message to the source address, with a fresh `id`, `from`/`fromPeerId`
        set to your identity, and `toIp` set to the sender's address.
4. (Optional) Bind UDP `0.0.0.0:43210` to react to pings.

That's the whole contract. The reference implementation in
[`agent-bridge/`](../agent-bridge) does exactly this in ~150 lines of Node.

## Dispatch — team server HTTP API (v1)

Where multicast can't reach (other subnets, tailnets), a
[Pings Dispatch](../dispatch) server replaces mDNS as the discovery source.
It is *only* a roster: pings and chat still flow directly peer-to-peer over
the UDP ports above.

Default port **43217**, JSON over HTTP. All endpoints except `/v1/health`
require `Authorization: Bearer <team-key>`.

| Method & path | Body | Effect |
|---|---|---|
| `POST /v1/register` | `{peerId, name, kind, ip, port}` | Idempotent upsert — **doubles as the heartbeat**; clients call it every 30s. Server stamps `lastSeen`. |
| `GET /v1/peers` | — | `{peers: [{peerId, name, kind, ip, port, lastSeen}]}` — stale entries (15 min) pruned. |
| `DELETE /v1/peers/{peerId}` | — | Remove a peer (clean shutdown). |
| `GET /v1/health` | — | `{app, version}` — unauthenticated liveness. |

An agent can join a Dispatch roster the same way a human client does:
register with `kind=agent` and listen on the UDP ports as described above.

D1 security posture: one shared team key, plain HTTP — deploy on a
WireGuard/Tailscale overlay only. TLS and per-device tokens are phase D2
(docs/DISPATCH-PLAN.md).

# Pings Dispatch

The team rendezvous + relay server — phases **D1–D2** of
[docs/DISPATCH-PLAN.md](../docs/DISPATCH-PLAN.md). Clients register here and
pull the roster, so Pings works where multicast discovery can't reach; when
two peers can't route to each other at all, envelopes are **relayed** through
a WebSocket. Direct peer-to-peer stays the preferred path — the relay is the
fallback, not the default.

## Run it

```bash
# Tailnet mode (plain HTTP; WireGuard carries transport security)
DISPATCH_TEAM_KEY="pick-something-long" cargo run --release

# Open-internet mode (TLS)
DISPATCH_TEAM_KEY="pick-something-long" \
DISPATCH_TLS_CERT=/etc/pings/cert.pem DISPATCH_TLS_KEY=/etc/pings/key.pem \
DISPATCH_STATE_FILE=/var/lib/pings/dispatch.json \
cargo run --release
```

Or with Docker:

```bash
docker build -t pings-dispatch .
docker run -e DISPATCH_TEAM_KEY="pick-something-long" -p 43217:43217 pings-dispatch
```

| Env var | Meaning |
|---|---|
| `DISPATCH_TEAM_KEY` | required — the enrollment secret (and root key) |
| `DISPATCH_ADDR` | listen address, default `0.0.0.0:43217` |
| `DISPATCH_STATE_FILE` | JSON file persisting enrolled devices across restarts |
| `DISPATCH_TLS_CERT` / `DISPATCH_TLS_KEY` | PEM pair — both set = HTTPS/WSS, neither = plain HTTP |

Point each Pings client at it: **Options → Network → Team server** + the team
key. Each client automatically trades the key for its own device token on
first contact.

**Getting a certificate:** on a tailnet, `tailscale cert your-node.tailnet.ts.net`
issues a valid pair with zero setup; on the public internet use Let's Encrypt
(certbot/caddy) or terminate TLS at a reverse proxy.

## Security model

- The **team key** is the enrollment secret and admin credential. Treat it
  like a root password.
- Each device holds its own **token** (returned once at enrollment; stored
  server-side only as a SHA-256 hash). Revoking a device
  (`DELETE /v1/devices/{peerId}`) kills its token, roster entry, and live
  relay connection.
- The relay is **content-blind**: frames are routed on `{to, channel}` and
  the payload is never inspected — end-to-end payload encryption can land
  later without changing the server.
- Plain-HTTP mode is for overlay networks (Tailscale/WireGuard) **only**. On
  the open internet, run TLS.

## API (v1)

`/v1/health` is open; `enroll`/`devices` require the **team key**; the rest
accept a device token (team key also works as root). `Authorization: Bearer …`.

| Method & path | Auth | Body | Effect |
|---|---|---|---|
| `POST /v1/enroll` | team key | `{peerId, name}` | Issue (or rotate) this device's token → `{deviceToken}`. |
| `GET /v1/devices` | team key | — | Enrolled devices (no hashes). |
| `DELETE /v1/devices/{peerId}` | team key | — | Revoke: token + roster + live socket. |
| `POST /v1/register` | token | `{peerId, name, kind, ip, port}` | Idempotent upsert; **doubles as the heartbeat** (every 30s). Server stamps `lastSeen`. |
| `GET /v1/peers` | token | — | `{peers: [...]}` — stale entries (15 min) pruned. |
| `DELETE /v1/peers/{peerId}` | token | — | Leave the roster (clean shutdown). |
| `GET /v1/ws` | **device token only** | — | Upgrade to the relay WebSocket. |

### Relay frames

Client → server: `{"to": "<peerId>", "channel": "ping"|"chat", "payload": {…}}` —
payload is exactly the JSON envelope UDP would have carried (PROTOCOL.md).
Server → recipient: `{"channel", "payload"}`. If the recipient has no live
socket the sender gets `{"channel":"system","payload":{"type":"undeliverable","to":…}}`
— informational only; the ack protocol remains the source of truth for
delivery states.

## Smoke test

```bash
curl -s localhost:43217/v1/health
TOKEN=$(curl -s -X POST localhost:43217/v1/enroll \
  -H "Authorization: Bearer $DISPATCH_TEAM_KEY" -H "Content-Type: application/json" \
  -d '{"peerId":"test-1","name":"Test"}' | jq -r .deviceToken)
curl -s -X POST localhost:43217/v1/register \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"peerId":"test-1","name":"Test","ip":"100.64.0.7","port":43210}' -i
curl -s localhost:43217/v1/peers -H "Authorization: Bearer $TOKEN"
```

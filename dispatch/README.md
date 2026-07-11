# Pings Dispatch

The team rendezvous server — phase **D1** of
[docs/DISPATCH-PLAN.md](../docs/DISPATCH-PLAN.md). Clients register themselves
here and pull the roster, so Pings works where multicast discovery can't reach:
across subnets, offices, and tailnets. **Pings and chat still flow directly
peer-to-peer — Dispatch only introduces.**

## Run it

```bash
DISPATCH_TEAM_KEY="pick-something-long" cargo run --release
# listening on 0.0.0.0:43217 (override with DISPATCH_ADDR)
```

Or with Docker:

```bash
docker build -t pings-dispatch .
docker run -e DISPATCH_TEAM_KEY="pick-something-long" -p 43217:43217 pings-dispatch
```

Point each Pings client at it: **Options → Network → Team server** (e.g.
`100.64.0.1:43217`) + the team key.

## Security posture (D1)

One shared team key over plain HTTP. **Deploy it on a tailnet** (or another
WireGuard overlay) and let the overlay carry transport security — that's the
supported D1 topology. TLS and per-device revocable tokens are phase D2; do not
put a D1 Dispatch on the open internet.

## API (v1)

All endpoints except `/v1/health` require `Authorization: Bearer <team-key>`.

| Method & path | Body | Effect |
|---|---|---|
| `POST /v1/register` | `{peerId, name, kind, ip, port}` | Idempotent upsert; **this is the heartbeat** — clients call it every 30s. Server stamps `lastSeen`. |
| `GET /v1/peers` | — | `{peers: [...]}`, stale entries (15 min silent) pruned, sorted by name. |
| `DELETE /v1/peers/{peerId}` | — | Remove a peer (clean shutdown). |
| `GET /v1/health` | — | `{app, version}` — unauthenticated liveness probe. |

## Smoke test

```bash
curl -s localhost:43217/v1/health
curl -s -X POST localhost:43217/v1/register \
  -H "Authorization: Bearer $DISPATCH_TEAM_KEY" -H "Content-Type: application/json" \
  -d '{"peerId":"test-1","name":"Test","ip":"100.64.0.7","port":43210}' -i
curl -s localhost:43217/v1/peers -H "Authorization: Bearer $DISPATCH_TEAM_KEY"
```

# Build plan: Dispatch Hooks — Pings as a notification layer

> Status: **plan.** Sequenced after the current Weekly stabilization push;
> first Pings-focus work of the next cycle. Same discipline as
> [DISPATCH-PLAN.md](./DISPATCH-PLAN.md): every phase independently
> shippable, tested on real hardware (and a real studio) before the next.

## Why

Pings already reaches humans well — flash on the desktop, toast with
quick replies, phone via Go!. Hooks make that reachable from *anything
that can POST JSON*: a cron job, a GitHub Action, Uptime Kuma, a Supabase
edge function, an AI agent without a mobile app of its own. The pitch is
one line in the README:

```bash
curl -X POST https://dispatch.example.com/hook/hk_live_9f3ab2… \
  -d '{"to": "zach", "message": "Aryeo sync failed — 3 retries exhausted"}'
```

…and Zach's screen flashes amber, or his phone buzzes if he's away, or it
lands silently in his feed if he's on DND. That last sentence is the
product: ntfy/Pushover/Gotify fire-and-forget at a device; Pings delivers
to a *person*, with presence, DND, and (in H2) a reply path back to the
thing that asked.

First customer: **Weekly**. Its "leavable" state needs an alert channel
for sync failures and error spikes, and the studio is the test bench —
we dogfood the exact integration story we want to sell.

## Design tenets

1. **A hook is a named, revocable sender credential — not a peer.** It
   has no socket, no roster row (in H1), no presence. It's the same
   pattern as device tokens: minted by an admin, stored server-side as a
   SHA-256 hash, revocable with one call, one per integration
   ("weekly-prod", "uptime-kuma", "hermes") so revoking one never breaks
   another.
2. **The wire format doesn't change.** A hook send becomes a standard
   ping/chat envelope ([PROTOCOL.md](./PROTOCOL.md)) injected into the
   recipient's existing relay WebSocket. Clients render it like any other
   ping — flash, toast, DND, feed, all client semantics untouched and no
   client update required for H1.
3. **Delivery honesty, extended.** The HTTP response tells the sender
   exactly who had a live socket and who didn't, the same way relay
   `undeliverable` frames work today. No silent maybe-delivery.
4. **The relay stays content-blind for peer traffic.** Hooks are a new
   *ingress*, not new inspection — peer→peer frames are still routed on
   `{to, channel}` only. (Hook payloads are necessarily constructed by
   the server; that's ingress, not snooping.)
5. **Ketchup rules.** Zero-SDK, curl-able, useful in the first five
   minutes. The moment a hook needs a client library or an onboarding
   call, we've failed.

---

## Phase H1 — inbound webhook (the 90% case)

### Management API (team key auth, `Authorization: Bearer`)

| Method & path | Body | Effect |
|---|---|---|
| `POST /v1/hooks` | `{name}` | Mint a hook → `{hookId, hookKey, name}`. **Key shown once**, stored hashed. `name` is the sender name recipients see. |
| `GET /v1/hooks` | — | List hooks: id, name, createdAt, lastUsedAt, sendCount. Never the key. |
| `DELETE /v1/hooks/{hookId}` | — | Revoke. Subsequent sends with that key 401. |

`hookId` is `hook-<uuid>` — the `hook-` prefix reserves a peerId
namespace (matters in H2, and prevents a device enrolling as a hook's
id). Keys are `hk_` + 32 random hex chars, minted from the same RNG as
device tokens, constant-time compared.

### Send API

Two spellings, one handler:

- **Canonical:** `POST /v1/hook` with `Authorization: Bearer <hookKey>`.
  For real integrations — the key stays out of URLs and access logs.
- **Convenience:** `POST /hook/{hookKey}`. For curl one-liners, cron
  jobs, and anything that can only set a URL. Documented with the caveat
  that the key will appear in proxy/access logs; rotating is one
  revoke + one mint.

Request body:

```json
{
  "to": "zach",
  "message": "Aryeo sync failed — 3 retries exhausted",
  "kind": "ping",
  "sound": "bell",
  "shape": "border"
}
```

| Field | Required | Meaning |
|---|---|---|
| `to` | yes | Recipient(s): a peerId, a display name, or an array of either. Names match case-insensitively against the live roster; an ambiguous name (two Sams) is a 409 listing the matches — never guess. |
| `message` | yes | The text. Cap 1 KB (protocol envelopes are small on purpose). |
| `kind` | no | `ping` (default — the flash) or `message` (a DM into the thread, no flash). Maps to the two envelope types. |
| `sound` / `shape` | no | Passed through to the ping envelope (`light｜chime｜bubble｜tap｜bell｜drop｜off`; `circle｜border`). Recipient's client settings still apply where they override. |

What the recipient's client receives is a normal envelope over its relay
socket — `from` = the hook's name, `fromPeerId` = the hook's `hook-<uuid>`
id, `timestamp` server-stamped. Unknown-field tolerance in PROTOCOL.md
means even old clients render it.

Response — per-recipient delivery truth:

```json
{
  "delivered": ["0b3f…"],
  "undeliverable": ["a91c…"]
}
```

`200` if at least one recipient had a live socket, `404` if none resolved,
`409` for ambiguous names, `401` bad key, `413` oversized, `429` rate
limited. **No store-and-forward in H1** — an offline recipient is
reported, not queued (that decision belongs with Go! native push; see
open questions).

### Semantics & limits

- **DND wins.** A hook ping is an ordinary ping; the client's DND
  behavior (no flash, no toast, lands in feed) applies unchanged. There
  is deliberately no bypass flag in H1 — see open question 1.
- **Rate limit:** token bucket per hook, 60/min default, `429` +
  `Retry-After`. Env-tunable.
- **Body cap:** 4 KB request, 1 KB message.
- **Admin dashboard** grows a Hooks card: list, mint (key shown once in a
  copy-me box), revoke, last-used — same one-page style as devices.

### Verify (real hardware)

One studio machine + one phone on Go!, hook minted in the dashboard:
`curl` from a laptop → desktop flashes; close the desktop app → same curl
reports that peer undeliverable while the phone (socket open) still
flashes; revoke the hook → curl gets 401; 61 rapid sends → 429. A cron
job on any box sends a daily test ping for a week without a single
mystery.

---

## Phase H2 — the reply path (the differentiator)

Fire-and-forget is table stakes. H2 closes the loop: the quick-reply
toast already exists, so let the reply travel *back to the thing that
asked*.

- **`replyUrl` per hook** (optional, set at mint or `PATCH /v1/hooks/{id}`).
  A recipient's quick-reply to a hook ping is a normal `private` envelope
  addressed to `hook-<uuid>`; Dispatch recognizes the reserved prefix and,
  instead of looking for a socket, POSTs to the `replyUrl`:

  ```json
  {
    "hookId": "hook-…",
    "from": "Zach",
    "fromPeerId": "0b3f…",
    "message": "ship it",
    "inReplyTo": "<original send id>",
    "timestamp": 1717000000000
  }
  ```

  Signed with `X-Pings-Signature: sha256=<HMAC>` over the raw body,
  keyed by a per-hook `replySecret` minted alongside the key. Retries
  with backoff (3 attempts), then dropped — replies are conversational,
  not transactional.
- **`GET /v1/hooks/{id}/inbox`** (hook key auth) — poll-based alternative
  for senders that can't host an endpoint. Ring buffer, last 100 replies,
  `?since=` cursor.
- **`replies` on send** — the sender may offer canned choices:
  `"replies": ["ship it", "hold"]` → the toast shows them as the one-tap
  options for this ping. Client change required (graceful: old clients
  show their default canned replies).
- **`sendId`** returned from every H1 send (add in H1, cheap) so
  `inReplyTo` can correlate.
- **Optional roster presence:** `PATCH {appearOnRoster: true}` puts the
  hook on the roster as `kind=agent` so people can *initiate* toward it
  (message it directly; delivery via replyUrl/inbox). Off by default —
  most hooks are ketchup, not buddies.

**Verify:** a deploy script pings "ready to ship?" with
`replies: ["ship","hold"]`; tapping **ship** on the phone POSTs to the
script's replyUrl and the deploy proceeds. Run it for a real Pings
release.

---

## Phase H3 — first integrations & the cookbook

- **Weekly → Pings** (the studio integration): Weekly grows a generic
  outbound notifier — URL + bearer secret in admin settings, fired on
  sync failure, error spike, and rush-order arrival. It's deliberately
  generic webhook-out on Weekly's side (useful beyond Pings); pointing it
  at a Dispatch hook is just configuration. Hermes can use the same hook
  via MCP for "something happened on the board" pings.
- **Cookbook page in the docs:** copy-paste recipes — GitHub Actions
  failure step, Uptime Kuma, Supabase edge function, plain cron. Each
  recipe is ≤10 lines or it doesn't ship.
- **`/hook` GET landing page:** hitting the convenience URL in a browser
  returns a tiny self-documenting page (like `/go`'s spirit) showing the
  curl example with *your* key blanked out.

**Verify:** two weeks of studio operation where Weekly's 3am sync failure
reaches a phone before anyone opens the board. That story becomes the
README's second paragraph.

---

## Open questions (decide when their phase starts, not before)

1. **DND bypass / priority tier (H1-adjacent).** A monitoring alert is
   exactly the thing that *should* break DND — "prod is down" vs "build
   passed" are different species. But a bypass flag on a webhook is also
   how ketchup becomes spam. Likely shape: recipients opt in per-hook
   ("this hook may break my DND"), never sender-declared. Needs client
   UI; decide with real usage from H1.
2. **Store-and-forward for offline recipients.** Undeliverable-and-honest
   is right for H1, but once Go! native push exists (G1 handoff), a
   queued hook ping becomes a push notification — that's the moment to
   revisit, not before. Interacts with the E2EE decision the same way D3
   audit does.
3. **Topics/groups.** `to: "#field-crew"` with client-side subscription
   is the obvious growth path (and what ntfy calls a topic). Wait for a
   real need — the studio's teams are small enough that arrays of names
   may cover it for a long while.
4. **Broadcast.** `to: "*"` is one incident-page away from being wanted
   and one bad cron loop away from being hated. If it lands, it lands
   with per-hook opt-in and a stiffer rate limit.
5. **Tier line.** Hooks ride Dispatch, which is already the paid
   artifact — but does the free LAN-only desktop get a listener port for
   local hooks (`POST localhost:43212/hook`)? It would make every
   developer's personal scripts a gateway drug. Decide with the pricing
   hat on, alongside DISPATCH-PLAN open question 5.

## Docs to touch when building

- PROTOCOL.md — document the `hook-` peerId prefix and (H2) the reply
  contract.
- dispatch/README.md — API table rows, smoke-test curl, security model
  note (hook keys hashed like device tokens; convenience-URL caveat).
- README.md — the one-liner, high up. It's the positioning.

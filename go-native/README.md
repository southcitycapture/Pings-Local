# Pings Go! native

The phone client as a real iOS app. The web version (served by Dispatch at
`/go`) already does everything *while it's open* — this shell exists for the
one thing a web app can't do: **receiving pings when the app is closed**,
via APNs time-sensitive notifications, plus real haptics and badge counts.

The UI (`ui/`) is adapted from [`dispatch/src/go.html`](../dispatch/src/go.html)
— the canonical web client. **Protocol changes must be mirrored between the
two.** What's different here, and why, is commented at the top of
[`ui/app.js`](ui/app.js).

## Layout

| Path | What |
|---|---|
| `ui/` | The whole product: vanilla HTML/CSS/JS, no bundler |
| `src-tauri/` | Tiny Tauri 2 shell: store (durable identity), haptics, go-push plugins |
| `src-tauri/gen/apple/` | Generated Xcode project — committed, hand-edited (ATS exception, entitlements). **Never re-run `tauri ios init` over it.** |
| `tauri-plugin-go-push/` | Custom plugin: APNs registration, token → JS, badge, tap events |

This is deliberately **not** the desktop crate (`../src-tauri`): the phone
needs none of its mDNS/UDP/tray machinery — the UI speaks to Dispatch over
HTTPS/WSS entirely from JS, so iOS builds stay small and fast.

## Run it

```sh
npm install
npx tauri ios dev "iPhone 17 Pro"     # builds + boots the simulator
npx tauri dev                          # same UI in a Mac window (no push)
```

Requirements: Xcode + iOS platform, rustup targets `aarch64-apple-ios{,-sim}`,
CocoaPods. Gotcha: if Homebrew's standalone `rust` shadows rustup, put
`/opt/homebrew/opt/rustup/bin` first on PATH or iOS builds can't find std.

Local server for testing:

```sh
cd ../dispatch
DISPATCH_TEAM_KEY=sesame DISPATCH_PUSH_DEBUG=log cargo run
```

`DISPATCH_PUSH_DEBUG=log` prints `would-push …` lines instead of calling
Apple, so the whole undeliverable→push path is verifiable with zero
credentials. In the app, use server `http://localhost:43217` (the simulator
shares the Mac's localhost; ATS is already excepted in the committed
Info.plist for plain-http tailnet servers).

Simulate the notification the server would send (app closed):

```sh
xcrun simctl push booted com.pings.go ../dispatch/tests/fixtures/apns-ping.json
```

The fixtures are locked by `cargo test -p pings-dispatch` to exactly match
the server's real payloads — one source of truth.

Grant notification permission headlessly (simulator only):

```sh
brew install wix/brew/applesimutils
applesimutils --booted --bundle com.pings.go --setPermissions notifications=YES
```

## How push works (the short version)

1. App start → go-push plugin: `requestAuthorization` +
   `registerForRemoteNotifications` → hex APNs token → JS.
2. JS POSTs `{peerId, platform:"apns", pushToken}` to Dispatch's
   `/v1/push-token` (device-token auth; re-posted every session start
   because re-enrolling wipes the server's record).
3. App backgrounds → the WS is **deliberately closed** (iOS freezes JS; a
   half-dead socket would swallow frames and suppress push).
4. Someone pings → relay finds no live socket → APNs alert with the sender's
   name. Pings are time-sensitive; chats are normal. Message content never
   leaves the server, and a push never fakes a ✓✓ ack.

## Ship checklist (needs the Apple Developer account)

- [ ] Portal: App ID `com.pings.go` + Push Notifications + Time-Sensitive
      Notifications capabilities; APNs Auth Key (.p8)
- [ ] `DEVELOPMENT_TEAM` in `src-tauri/gen/apple/project.yml`; run on device
- [ ] Dispatch env: `DISPATCH_APNS_KEY/KEY_ID/TEAM_ID/TOPIC`,
      `DISPATCH_APNS_ENDPOINT=sandbox` (dev builds) / `production` (TestFlight+)
- [ ] Entitlements: flip `aps-environment` to `production` for store builds
- [ ] Revisit the ATS `NSAllowsArbitraryLoads` exception before App Store review
- [ ] `npx tauri ios build --export-method app-store-connect` → TestFlight

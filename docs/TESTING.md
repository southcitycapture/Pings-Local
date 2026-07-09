# Testing Pings v3 on real Macs

You do **not** need an Apple Developer account to test locally. That account only
matters for *distributing* a signed/notarized app to other people. Everything
below works with a free Apple ID / no account.

You need **two Macs on the same Wi-Fi/LAN** (see "Network gotchas" — this is the
part most likely to trip you up).

---

## Recommended: dev mode on each Mac

This is the least-hassle path for a two-machine test. No app signing, no
Gatekeeper prompts, and you get a live log window.

On **each** Mac:

1. **Xcode Command Line Tools** (compiler + linker):
   ```bash
   xcode-select --install
   ```
2. **Rust**:
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   # then restart the terminal, or: source "$HOME/.cargo/env"
   ```
3. **Node 18+** — from <https://nodejs.org> or `brew install node`.
4. **Get the branch and run**:
   ```bash
   git clone <your-repo-url> Pings-Local
   cd Pings-Local
   git checkout claude/app-v3-redesign-pv1la6
   npm install
   npm run tauri dev
   ```

The first `npm run tauri dev` compiles the Rust backend and can take a few
minutes; after that it's fast. A "Pings" window opens. Do the same on the second
Mac, and they should discover each other.

---

## Alternative: build a clickable .app

If you'd rather have an app you can copy around instead of running from a
terminal, build one on a Mac that has the toolchain above:

```bash
# Native to whatever Mac you build on:
npm run tauri build

# Or a universal binary that runs on both Apple Silicon and Intel:
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run tauri build -- --target universal-apple-darwin
```

Output lands in:

- App:  `src-tauri/target/release/bundle/macos/Pings.app`
  (universal build: `src-tauri/target/universal-apple-darwin/release/bundle/macos/Pings.app`)
- DMG:  the sibling `.../bundle/dmg/Pings_0.1.0_*.dmg`

Copy the `.app` (or `.dmg`) to the other Mac. Because it isn't signed with a paid
Developer ID, **Gatekeeper will block it the first time.** Two ways past it:

- Right-click the app → **Open** → **Open** in the dialog, **or**
- Strip the quarantine flag from Terminal:
  ```bash
  xattr -cr /path/to/Pings.app
  ```

**Architecture note:** a plain `npm run tauri build` only targets the Mac you
built on. If your two Macs differ (one Apple Silicon, one Intel), use the
universal build above, or build once per architecture (`npm run build:mac:arm64`
/ `npm run build:mac:x64`).

---

## Network gotchas (read this — it's usually the problem)

Pings finds peers with mDNS (Bonjour) and talks over UDP on ports **43210**
(pings) and **43211** (chat). For two Macs to see each other:

- **Same network + same subnet.** Both on the same Wi-Fi or plugged into the same
  switch. Two different Wi-Fi networks (or Wi-Fi vs. a phone hotspot) won't work.
- **Avoid guest / public Wi-Fi.** Many guest and corporate networks enable
  "client isolation" (AP isolation), which blocks device-to-device traffic
  entirely. A normal home/office network or a direct ethernet link is best.
- **Allow the macOS "Local Network" prompt.** On recent macOS you'll get a
  *"Pings wants to find devices on your local network"* prompt — allow it. If you
  dismissed it, re-enable under **System Settings → Privacy & Security → Local
  Network**.
- **Allow the firewall prompt.** If the macOS firewall is on, it may ask to allow
  incoming connections for Pings (or `tauri`/`pings` in dev mode) — allow it.
  (System Settings → Network → Firewall.)

## What to check once both are running

- Each Mac shows the other under **"On your network"** with a green presence dot.
- Hover a peer → **Ping**: the other Mac flashes the full-screen border and plays
  a sound.
- **Message** opens a DM window; sent messages should show **✓ sent** and then
  **✓✓ delivered** once the other side receives them.
- The **Activity** drawer (bottom-right) logs pings/messages and survives a
  restart of the app.

## If they don't find each other

- Confirm both show their own IP on the same subnet (e.g. both `10.0.1.x`), shown
  in each app's top-left under your name.
- Double-check you're not on guest Wi-Fi with client isolation.
- As a quick sanity check, from one Mac: `ping <other-mac-ip>` should succeed.
- Discovery is mDNS-only in this build (the old network port-scanner was removed);
  if a network blocks mDNS, peers currently appear only after one pings/messages
  the other. A manual "Add by IP" is planned.

> Note: the built-in auto-updater in this build points at a dev machine and is
> not relevant to testing — ignore "Check for Updates" in Settings for now.

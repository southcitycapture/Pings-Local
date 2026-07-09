# On-device verification checklist (macOS)

Everything in v3 is built and compiles/builds clean, but a lot of it is **native
macOS window behavior that can only be confirmed on a real Mac** — the cloud dev
environment is headless Linux, so those items were reasoned about, not observed.
This is the punch list.

## For a local Claude Code session — how to actually observe

You're on the real machine, so use it:

- Build/run: `npm install && npm run tauri dev` (first build takes a few min).
- **Screenshot the real app** at any moment: `screencapture -x /tmp/pings.png`
  (whole screen) or `screencapture -o -l $(…)` for a window — then read the PNG.
  This is how you *see* the titlebar, tray, toast, and flash for real.
- **Read the app's console**: `npm run tauri dev` prints Rust `eprintln!`/`println!`
  and JS console to the terminal. Watch it for mDNS/discovery, shortcut
  registration (`[pings] failed to register palette shortcut`), and errors.
- The full design/rationale for each feature is in `V3_PLAN.md`.

## On-device results — 2026-07-09 (macOS, real hardware)

A local Claude Code session built the app and worked the list by screenshotting
the running app and reading the console. Everything locally verifiable passed;
items 8–10 need a second machine.

| # | Item | Result |
|---|------|--------|
| 1 | Window load flash | ✅ **Fixed** — webview backing now painted the theme ground; no white flash. |
| 2 | First-click / focus | ✅ Verified (palette + toast both register the first click). |
| 3 | Menubar tray | ✅ Verified — icon, peer list, peer-ping+log, hide-to-menubar on close, Open Pings reopen. (Quit not clicked to keep the session alive.) |
| 4 | ⌘K command palette | ✅ Verified — global shortcut summons it, focused and filtering. |
| 5 | Quick-reply toast | ✅ **Fixed** — it stole focus (confirmed); now a non-activating `NSPanel` + `accept_first_mouse` → one-click replies, no focus theft. |
| 6 | Do Not Disturb | ✅ Verified — ping logged, no flash / no toast. |
| 7 | Full-screen border ping | ✅ Verified — red border honors the effect settings. |
| 8 | Delivery states | ⏸️ Needs a 2nd machine — the chat listener drops local-source packets, so the delivered-ack can't be faked locally. |
| 9 | Agent round-trip | ⏸️ Needs a spare machine + Ollama. |
| 10 | Discovery | ⏸️ Needs a 2nd machine on the same subnet. |

## The list (each: what to check → likely fix if it fails)

1. **Window load flash** — ✅ **FIXED** (commit *paint webview backing the theme
   ground*). Caught the real flash on-device: the window showed solid **white**
   while the WKWebView loaded (the `.win-enter` opacity hold actually prolonged
   it). Fixed by painting the *webview's* backing layer the theme ground color
   via objc2 (`drawsBackground=false` + themed layer) on the main/options/DM
   windows — not the NSWindow, which had bled into the titlebar. Loading window
   now shows dark ground; titlebar and opaque content unchanged.

2. **First-click / focus** — click a peer's **Ping** immediately after focusing a
   window; it should register on the *first* click everywhere, including the
   **quick-reply toast chips** and the **⌘K palette**. (Regressed once when
   windows were shown off the main thread; now they're plain-visible / main-
   thread shown.) → If a surface still needs two clicks, it isn't becoming key;
   check it's shown+focused on the main thread.

3. **Menubar tray** — icon appears; menu lists current peers; clicking a peer
   pings them; **Open Pings** reopens the window after close; **Quit** exits;
   closing the main window hides to the menubar (doesn't quit). *(Reported
   working — re-confirm after any changes.)*

4. **⌘K command palette** — press **Cmd+Shift+K** with the window closed: the
   palette appears, focused, ready to type; two letters + **Enter** pings; **Esc**
   closes. → If the hotkey does nothing, watch the console for the registration
   warning (another app may hold the combo — it's a one-line change to rebind).

5. **Quick-reply toast** — ✅ **FIXED** (commit *non-activating panel + one-click
   quick replies*). Confirmed on-device that the old toast **stole focus** (a
   ping yanked focus from the foreground app). Now the toast is a real
   non-activating `NSPanel` (via `tauri-nspanel`) with `accept_first_mouse` — it
   appears without taking focus and a chip sends the reply on the **first**
   click. Also fixed a first-toast-of-session blank-render race (re-emit ~600ms
   after the webview loads).

6. **Do Not Disturb** — turn it on in Settings; an incoming ping should produce
   **no** flash, **no** toast, **no** sound, but still appear in Activity.

7. **Full-screen border ping** — still fires and honors the effect settings
   (color/thickness/feather/duration, circle vs border). *(Reported working.)*

8. **Delivery states** — ⏸️ **Needs a 2nd machine.** DM the other machine; your
   bubble shows **✓ sent** then **✓✓ delivered** once they receive it. Can't be
   faked locally: the chat listener drops packets from a local-source IP
   (self-filter), so a synthetic delivered-ack from this machine is ignored.

9. **Agent round-trip** — on a spare machine: `cd agent-bridge && npm install`,
   install Ollama + `ollama pull llama3.2`, then `npm start`. The agent should
   appear in the buddy list with an **AI** badge; DM it and get a model reply with
   delivery ticks. (`PINGS_ECHO=1 npm start` to test the plumbing with no model.)

10. **Discovery** — the two machines see each other on the same Wi-Fi/subnet
    (mDNS). See `docs/TESTING.md` for the network gotchas (guest Wi-Fi / client
    isolation).

## Not yet built (v3.4 — shipping)

- Signed **HTTPS auto-updater** (currently points at a dev hostname over plain
  HTTP with `dangerousInsecureTransportProtocol` — must be replaced before
  distributing) and packaging (`.dmg`, notarization when there's an account).

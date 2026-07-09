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

## The list (each: what to check → likely fix if it fails)

1. **Window load flash** — the one known-open cosmetic issue. On launch a window
   goes black → white → content. It's the WKWebView's own background before its
   first paint (below the level `.win-enter`/content-reveal reaches).
   → Fix path: set the *webview's* background (not the window's) via the native
   objc2 path already used in `src-tauri/src/overlay.rs` (`drawsBackground` /
   `setBackgroundColor` on the WKWebView), applied to each window.

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

5. **Quick-reply toast** — have the other machine ping you: a card appears
   top-right with sender + message + reply chips. Tapping a chip sends a reply on
   the **first** click and dismisses. Assess whether the toast **stealing focus**
   is disruptive. → If it is, the proper fix is a non-activating `NSPanel` (objc2)
   so it's clickable without taking focus.

6. **Do Not Disturb** — turn it on in Settings; an incoming ping should produce
   **no** flash, **no** toast, **no** sound, but still appear in Activity.

7. **Full-screen border ping** — still fires and honors the effect settings
   (color/thickness/feather/duration, circle vs border). *(Reported working.)*

8. **Delivery states** — DM the other machine; your bubble shows **✓ sent** then
   **✓✓ delivered** once they receive it.

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

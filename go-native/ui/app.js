// Pings Go! native — adapted from dispatch/src/go.html (the canonical web
// client). Protocol logic (frames, acks, roster) must stay mirrored with it.
// What's different here, and why:
//   - The webview has no Dispatch origin, so the server URL is explicit and
//     asked for at sign-in.
//   - Identity lives in tauri-plugin-store, not localStorage — WKWebView can
//     evict website data, and losing the device token forces a re-enroll.
//     (localStorage remains as a fallback so these files still run in a
//     plain browser for quick iteration.)
//   - Haptics go through the haptics plugin; navigator.vibrate is a silent
//     no-op inside WKWebView.
//   - The WebSocket is closed deliberately when the app backgrounds: iOS
//     freezes JS but the server would keep seeing a "live" socket and
//     deliver frames into it instead of pushing. Backgrounded = offline =
//     pushable, by design.
"use strict";
const $ = (id) => document.getElementById(id);
const esc = (t) => { const d = document.createElement("div"); d.textContent = String(t ?? ""); return d.innerHTML; };

const TAURI = window.__TAURI__ || null;

// ---------------------------------------------------------------- storage
const STORE_KEYS = ["go-token", "go-peer-id", "go-name", "go-server"];
const storage = {
  cache: new Map(),
  backend: null, // tauri store, when running in the shell
  async init() {
    if (TAURI?.store) {
      this.backend = await TAURI.store.load("go.json", { autoSave: true });
      for (const key of STORE_KEYS) {
        const value = await this.backend.get(key);
        if (value != null) this.cache.set(key, value);
      }
    } else {
      for (const key of STORE_KEYS) {
        const value = localStorage.getItem(key);
        if (value != null) this.cache.set(key, value);
      }
    }
  },
  get(key) { return this.cache.get(key) || ""; },
  set(key, value) {
    if (value) this.cache.set(key, value);
    else this.cache.delete(key);
    if (this.backend) {
      (value ? this.backend.set(key, value) : this.backend.delete(key)).catch(() => {});
    } else {
      try { value ? localStorage.setItem(key, value) : localStorage.removeItem(key); } catch {}
    }
  },
};

// ---------------------------------------------------------------- identity
const store = {
  get token() { return storage.get("go-token"); },
  set token(v) { storage.set("go-token", v); },
  get peerId() {
    let id = storage.get("go-peer-id");
    if (!id) { id = crypto.randomUUID(); storage.set("go-peer-id", id); }
    return id;
  },
  get name() { return storage.get("go-name"); },
  set name(v) { storage.set("go-name", v); },
  get server() { return storage.get("go-server"); },
  set server(v) { storage.set("go-server", v); },
};
// Our pseudo-address: unique per device, never routable — everything to and
// from a phone rides the relay, which is exactly the desktops' fallback path.
const myAddr = () => "go-" + store.peerId.slice(0, 8);

function normalizeServer(raw) {
  let s = String(raw || "").trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  return s.replace(/\/+$/, "");
}
const wsServer = () => store.server.replace(/^http/i, "ws");

// ---------------------------------------------------------------- state
let peers = [];            // roster from the server
let ws = null;             // relay socket
let wsUp = false;
let wsWanted = false;      // false while backgrounded/signed out — no reconnect
let currentChat = null;    // peerId of the open thread
const threads = new Map(); // peerId -> [{mine, message, timestamp, id, delivered}]
const unread = new Map();  // peerId -> count
let timers = [];

// ---------------------------------------------------------------- audio + haptics
let audioCtx = null;
// WKWebView only lets AudioContext produce sound after a user gesture; the
// Join tap (or any roster tap) unlocks it for the rest of the session.
function unlockAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  } catch {}
}
document.addEventListener("touchend", unlockAudio, { passive: true });
document.addEventListener("mousedown", unlockAudio);

function tone(freq, type, dur, gain) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator(), g = audioCtx.createGain();
    osc.type = type; osc.frequency.value = freq; g.gain.value = 0;
    osc.connect(g); g.connect(audioCtx.destination);
    const now = audioCtx.currentTime;
    g.gain.linearRampToValueAtTime(gain, now + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.start(now); osc.stop(now + dur);
  } catch { /* audio may need a user gesture first */ }
}
const sounds = {
  chime: () => tone(1140, "sine", 0.16, 0.25),
  bubble: () => tone(720, "sine", 0.11, 0.18),
  tap: () => tone(1350, "square", 0.05, 0.16),
};

// kind: "tap" (I did something) | "message" (something arrived) | "ping"
// (someone wants me NOW). Falls back to navigator.vibrate in a browser.
function buzz(kind) {
  if (TAURI?.haptics) {
    const h = TAURI.haptics;
    const fire = kind === "ping" ? h.notificationFeedback("warning")
      : kind === "message" ? h.impactFeedback("medium")
      : h.impactFeedback("light");
    Promise.resolve(fire).catch(() => {});
  } else {
    const pattern = kind === "ping" ? [120, 60, 120] : kind === "message" ? 40 : 30;
    try { navigator.vibrate?.(pattern); } catch {}
  }
}

// ---------------------------------------------------------------- api
async function api(path, options = {}) {
  const res = await fetch(store.server + path, {
    ...options,
    headers: {
      Authorization: "Bearer " + (options.key || store.token),
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) throw new Error("unauthorized");
  if (!res.ok) throw new Error("http " + res.status);
  return res.status === 204 ? null : res.json();
}

// ---------------------------------------------------------------- helpers
function ago(ts) {
  if (!ts) return "never";
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return s + "s ago";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  return h < 24 ? h + "h ago" : Math.floor(h / 24) + "d ago";
}
const online = (p) => Date.now() - (p.lastSeen || 0) <= 120000;
function initials(name) {
  const t = String(name || "?").trim();
  const parts = t.split(/\s+/).filter(Boolean);
  return (parts.length >= 2 ? parts[0][0] + parts[1][0] : t.slice(0, 2)).toUpperCase();
}
function hueClass(key) {
  let h = 0;
  for (const ch of key) h = (ch.charCodeAt(0) + ((h << 5) - h)) | 0;
  return "av-" + ((Math.abs(h) % 6) + 1);
}
function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 2200);
}

// ---------------------------------------------------------------- views
function show(view) {
  for (const id of ["signin", "roster", "chat"]) $(id).hidden = id !== view;
}

// ---------------------------------------------------------------- roster
function renderRoster() {
  const list = peers
    .filter((p) => p.peerId !== store.peerId)
    .sort((a, b) => (online(b) - online(a)) || (b.lastSeen || 0) - (a.lastSeen || 0));
  const box = $("peer-list");
  if (!list.length) {
    box.innerHTML = '<div class="empty-list">No one on the team roster yet.<br/>Desks and phones appear here as they join.</div>';
    return;
  }
  box.innerHTML = list.map((p) => {
    const n = unread.get(p.peerId) || 0;
    return `<button class="row" data-open="${esc(p.peerId)}">
      <span class="avatar ${hueClass(p.peerId)}">${p.kind === "agent" ? "🤖" : esc(initials(p.name))}</span>
      <span class="mid">
        <span class="name">${esc(p.name || p.ip)}<span class="dot${online(p) ? " online" : ""}"></span>${p.kind === "agent" ? '<span class="badge">AI</span>' : ""}</span>
        <span class="sub">${online(p) ? "online" : esc(ago(p.lastSeen))}</span>
      </span>
      ${n ? `<span class="unread">${n}</span>` : ""}
      <span class="ping-btn" data-ping="${esc(p.peerId)}">Ping</span>
    </button>`;
  }).join("");
}

function renderHeader() {
  $("self-name").textContent = store.name;
  $("conn-dot").className = "conn" + (wsUp ? " up" : "");
  $("self-sub").textContent = wsUp ? "connected · pingable" : "reconnecting…";
}

// ---------------------------------------------------------------- chat
function renderThread() {
  const peer = peers.find((p) => p.peerId === currentChat);
  $("chat-name").textContent = peer?.name || "Chat";
  $("chat-sub").textContent = peer && online(peer) ? "online" : peer ? ago(peer.lastSeen) : "";
  const msgs = threads.get(currentChat) || [];
  $("thread").innerHTML = msgs.map((m) => `
    <div class="bubble${m.mine ? " mine" : ""}">${esc(m.message)}
      <div class="meta">${m.mine ? (m.delivered ? "✓✓ delivered" : "✓ sent") : esc(ago(m.timestamp))}</div>
    </div>`).join("");
  $("thread").scrollTop = $("thread").scrollHeight;
}

function openChat(peerId) {
  currentChat = peerId;
  unread.delete(peerId);
  syncBadge();
  renderRoster();
  renderThread();
  show("chat");
}

// ---------------------------------------------------------------- relay
function relaySend(to, channel, payload) {
  if (!ws || ws.readyState !== 1) return false;
  ws.send(JSON.stringify({ to, channel, payload }));
  return true;
}

function sendPing(peerId) {
  const ok = relaySend(peerId, "ping", {
    from: store.name, fromIp: myAddr(), fromPeerId: store.peerId,
    message: "", sound: "chime", shape: "circle", timestamp: Date.now(),
  });
  buzz("tap");
  toast(ok ? "Ping sent" : "Not connected — try again in a second");
}

function sendChat() {
  const input = $("chat-input");
  const message = input.value.trim();
  if (!message || !currentChat) return;
  input.value = "";
  const payload = {
    id: crypto.randomUUID(), kind: "private",
    from: store.name, fromIp: myAddr(), fromPeerId: store.peerId,
    toIp: "", message, timestamp: Date.now(),
  };
  const ok = relaySend(currentChat, "chat", payload);
  if (!ok) { toast("Not connected"); return; }
  const list = threads.get(currentChat) || [];
  list.push({ mine: true, message, timestamp: payload.timestamp, id: payload.id, delivered: false });
  threads.set(currentChat, list);
  sounds.tap();
  renderThread();
}

function showFlash(from, message) {
  const flash = $("flash");
  flash.querySelector(".from").textContent = from || "Ping!";
  flash.querySelector(".msg").textContent = message || "is pinging you";
  flash.hidden = false;
  // restart the CSS animations
  for (const el of flash.querySelectorAll(".edge, .card")) {
    el.style.animation = "none"; void el.offsetWidth; el.style.animation = "";
  }
  sounds.chime();
  buzz("ping");
  clearTimeout(flash._t);
  flash._t = setTimeout(() => { flash.hidden = true; }, 1700);
}

function handleFrame(text) {
  let frame;
  try { frame = JSON.parse(text); } catch { return; }
  const p = frame.payload || {};

  if (frame.channel === "ping") {
    showFlash(p.from, p.message);
    return;
  }
  if (frame.channel !== "chat") return;

  if (p.kind === "ack") {
    for (const msgs of threads.values()) {
      const m = msgs.find((m) => m.mine && m.id === p.id && !m.delivered);
      if (m) { m.delivered = true; break; }
    }
    if (!$("chat").hidden) renderThread();
    return;
  }
  if (p.kind === "private") {
    const from = p.fromPeerId;
    if (!from) return;
    // ack first — delivery states stay honest even if rendering fails
    if (p.id) {
      relaySend(from, "chat", {
        id: p.id, kind: "ack", from: store.name, fromIp: myAddr(),
        fromPeerId: store.peerId, toIp: p.fromIp || "", message: "", timestamp: Date.now(),
      });
    }
    const list = threads.get(from) || [];
    list.push({ mine: false, message: p.message || "", timestamp: p.timestamp || Date.now() });
    threads.set(from, list);
    if (currentChat === from && !$("chat").hidden) {
      renderThread();
    } else {
      unread.set(from, (unread.get(from) || 0) + 1);
      syncBadge();
      renderRoster();
      toast((p.from || "Someone") + ": " + (p.message || ""));
    }
    sounds.bubble();
    buzz("message");
  }
}

function connectWs() {
  if (!store.token || !wsWanted) return;
  ws = new WebSocket(`${wsServer()}/v1/ws?token=${encodeURIComponent(store.token)}`);
  ws.onopen = () => { wsUp = true; renderHeader(); };
  ws.onmessage = (e) => handleFrame(e.data);
  ws.onclose = () => {
    wsUp = false; renderHeader();
    if (store.token && wsWanted) setTimeout(connectWs, 4000);
  };
  ws.onerror = () => ws.close();
}

// ---------------------------------------------------------------- push
// The whole point of the native shell: register for APNs and hand the token
// to Dispatch so undeliverable frames become notifications. Re-enrolling
// wipes the server's copy, so the token is re-POSTed every session start.
let pushListenersReady = false;

async function postPushToken(token) {
  if (!token) return;
  try {
    await api("/v1/push-token", {
      method: "POST",
      body: JSON.stringify({ peerId: store.peerId, platform: "apns", pushToken: token }),
    });
  } catch { /* best-effort; retried next session start */ }
}

async function initPush() {
  if (!TAURI?.core?.invoke) return; // browser / desktop dev: nothing to do
  const { invoke, addPluginListener } = TAURI.core;
  try {
    if (!pushListenersReady) {
      await addPluginListener("go-push", "pushToken", (e) => postPushToken(e.token));
      pushListenersReady = true;
      await invoke("plugin:go-push|request_push");
    }
    const current = await invoke("plugin:go-push|get_token");
    if (current?.token) postPushToken(current.token);
  } catch { /* plugin absent (desktop) or permission denied — web behavior remains */ }
}

function syncBadge() {
  if (!TAURI?.core?.invoke) return;
  let total = 0;
  for (const n of unread.values()) total += n;
  TAURI.core.invoke("plugin:go-push|set_badge", { count: total }).catch(() => {});
}

// ---------------------------------------------------------------- session
async function registerSelf() {
  await api("/v1/register", {
    method: "POST",
    body: JSON.stringify({
      peerId: store.peerId, name: store.name, kind: "human",
      ip: myAddr(), port: 0,
    }),
  });
}

async function refreshRoster() {
  const res = await api("/v1/peers");
  peers = res.peers || [];
  renderRoster();
  if (!$("chat").hidden) renderThread();
}

function startTimers() {
  stopTimers();
  timers.push(setInterval(() => registerSelf().catch(() => {}), 25000));
  timers.push(setInterval(() => refreshRoster().catch(() => {}), 10000));
}
function stopTimers() {
  timers.forEach(clearInterval);
  timers = [];
}

async function startSession() {
  wsWanted = true;
  renderHeader();
  show("roster");
  try {
    await registerSelf();
    await refreshRoster();
  } catch (err) {
    if (String(err.message) === "unauthorized") { signOut("Session expired — join again."); return; }
  }
  connectWs();
  startTimers();
  initPush();
}

// iOS freezes JS in the background but the server would keep the socket
// "live" for minutes and deliver frames nobody will see — which also
// suppresses push. Going hidden = deliberately offline; pushes take over.
function suspendSession() {
  wsWanted = false;
  stopTimers();
  try { ws?.close(); } catch {}
  ws = null; wsUp = false;
}
document.addEventListener("visibilitychange", () => {
  if (!store.token) return;
  if (document.hidden) suspendSession();
  else if ($("signin").hidden) startSession(); // signed in → resume
});

function signOut(message) {
  store.token = "";
  wsWanted = false;
  stopTimers();
  try { ws?.close(); } catch {}
  ws = null; wsUp = false;
  $("signin-error").textContent = message || "";
  $("in-server").value = store.server;
  show("signin");
}

async function join() {
  const server = normalizeServer($("in-server").value);
  const name = $("in-name").value.trim();
  const key = $("in-key").value.trim();
  if (!server) { $("signin-error").textContent = "Where's your Dispatch server?"; return; }
  if (!name || !key) { $("signin-error").textContent = "Name and team key, please."; return; }
  store.server = server;
  store.name = name;
  try {
    const res = await api("/v1/enroll", {
      method: "POST", key,
      body: JSON.stringify({ peerId: store.peerId, name }),
    });
    store.token = res.deviceToken;
  } catch (err) {
    $("signin-error").textContent =
      String(err.message) === "unauthorized" ? "That team key was not accepted." : "Can't reach the server.";
    return;
  }
  $("in-key").value = "";
  startSession();
}

// ---------------------------------------------------------------- wiring
$("in-go").addEventListener("click", join);
$("in-key").addEventListener("keydown", (e) => { if (e.key === "Enter") join(); });
$("signout").addEventListener("click", () => signOut());
$("chat-back").addEventListener("click", () => { currentChat = null; renderRoster(); show("roster"); });
$("chat-send").addEventListener("click", sendChat);
$("chat-input").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });
$("peer-list").addEventListener("click", (e) => {
  const ping = e.target.closest("[data-ping]");
  if (ping) { e.stopPropagation(); sendPing(ping.dataset.ping); return; }
  const open = e.target.closest("[data-open]");
  if (open) openChat(open.dataset.open);
});

// ---------------------------------------------------------------- boot
(async () => {
  await storage.init();
  $("in-server").value = store.server;
  $("in-name").value = store.name;
  if (store.token && store.name && store.server) {
    startSession();
  } else {
    show("signin");
  }
})();

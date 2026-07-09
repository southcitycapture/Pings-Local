import {
  getPeers,
  getNetworkStatus,
  onNetworkStatus,
  onPeersUpdated,
  onIncomingPing,
  onIncomingTeamChat,
  onIncomingPrivateChat,
  onSettingsUpdated,
  sendPing,
  sendTeamChat,
  getSettings,
  getProfile,
  setProfile,
  updateSetting,
  getHistory,
  openOptionsWindow,
  openDirectChatWindow,
} from "./pings-api.js";
import { io } from "socket.io-client";
import {
  normalizeIp,
  escapeHtml,
  formatAgo,
  initials,
  peerKey,
  displayName,
  presenceState,
} from "./core/format.js";
import { playSound } from "./core/sound.js";

// ---------------------------------------------------------------- state

let peers = [];
let settings = {
  customMessage: "",
  sound: "light",
  pingShape: "circle",
  chatSoundsEnabled: true,
  chatSendSound: "tap",
  chatReceiveSound: "bubble",
  darkMode: false,
};
let profile = {};
let status = null;
let historyAll = []; // oldest-first; the single history invariant
let teamMessages = []; // oldest-first

const unread = new Map(); // peerKey -> count
const sentFlash = new Map(); // peerKey -> { state, timer }
const rowEls = new Map(); // peerKey -> row refs

let filterText = "";
let drawerTab = "activity";

// ---------------------------------------------------------------- elements

const el = {};
function cacheElements() {
  el.selfAvatar = document.getElementById("self-avatar");
  el.selfName = document.getElementById("self-name");
  el.selfSub = document.getElementById("self-sub");
  el.openOptions = document.getElementById("open-options");
  el.finder = document.getElementById("finder-input");
  el.countLabel = document.getElementById("peers-count-label");
  el.peerList = document.getElementById("peer-list");
  el.peerEmpty = document.getElementById("peer-empty");
  el.pingsToday = document.getElementById("pings-today");
  el.openTeam = document.getElementById("open-team");
  el.openActivity = document.getElementById("open-activity");
  el.scrim = document.getElementById("drawer-scrim");
  el.drawer = document.getElementById("drawer");
  el.closeDrawer = document.getElementById("close-drawer");
  el.activityList = document.getElementById("activity-list");
  el.teamMessages = document.getElementById("team-messages");
  el.teamInput = document.getElementById("team-input");
  el.teamSend = document.getElementById("team-send");
  el.onboard = document.getElementById("onboard");
  el.onboardName = document.getElementById("onboard-name");
  el.onboardTry = document.getElementById("onboard-try");
  el.onboardDone = document.getElementById("onboard-done");
  el.onboardPreview = document.getElementById("onboard-preview");
}

// ---------------------------------------------------------------- helpers

function applyTheme(next) {
  document.documentElement.setAttribute("data-theme", next?.darkMode ? "dark" : "light");
}

function wireSound() {
  const s = settings.sound || "light";
  return s === "light" ? "chime" : s;
}

function avatarClass(key) {
  let hash = 0;
  for (const ch of key) hash = (ch.charCodeAt(0) + ((hash << 5) - hash)) | 0;
  return `av-${(Math.abs(hash) % 6) + 1}`;
}

function isToday(ts) {
  if (!ts) return false;
  const d = new Date(ts);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

function dedupePeers(list) {
  const byKey = new Map();
  for (const peer of Array.isArray(list) ? list : []) {
    const key = peerKey(peer);
    if (!key) continue;
    const prev = byKey.get(key);
    if (!prev || (peer?.lastSeen || 0) > (prev?.lastSeen || 0)) byKey.set(key, peer);
  }
  return [...byKey.values()];
}

function sortedFilteredPeers() {
  const q = filterText.trim().toLowerCase();
  let list = dedupePeers(peers);
  if (q) {
    list = list.filter(
      (p) => displayName(p).toLowerCase().includes(q) || normalizeIp(p.ip).includes(q),
    );
  }
  list.sort((a, b) => {
    const ao = presenceState(a.lastSeen) === "online" ? 0 : 1;
    const bo = presenceState(b.lastSeen) === "online" ? 0 : 1;
    if (ao !== bo) return ao - bo;
    return (b.lastSeen || 0) - (a.lastSeen || 0);
  });
  return list;
}

// ---------------------------------------------------------------- self

function renderSelf() {
  const name = profile.displayName || status?.hostname || "You";
  el.selfName.innerHTML = `${escapeHtml(name)}<span class="dot online"></span>`;
  el.selfAvatar.textContent = initials(name);
  el.selfSub.textContent = `${status?.ip || "n/a"} · online`;
}

// ---------------------------------------------------------------- peer rows

function createRow(peer, key) {
  const row = { peer };

  const node = document.createElement("div");
  node.className = "row";
  node.setAttribute("role", "listitem");
  node.dataset.key = key;
  node.tabIndex = 0;

  const avatar = document.createElement("span");
  avatar.className = `avatar ${avatarClass(key)}`;

  const who = document.createElement("div");
  who.className = "who";
  const name = document.createElement("div");
  name.className = "name";
  const nameText = document.createElement("span");
  const dot = document.createElement("span");
  dot.className = "dot";
  name.append(nameText, dot);
  const sub = document.createElement("div");
  sub.className = "sub";
  who.append(name, sub);

  const end = document.createElement("div");
  end.className = "row-end";
  const statusSlot = document.createElement("span");
  statusSlot.className = "status";
  const actions = document.createElement("div");
  actions.className = "actions";
  const msgBtn = document.createElement("button");
  msgBtn.className = "btn-msg";
  msgBtn.textContent = "Message";
  const pingBtn = document.createElement("button");
  pingBtn.className = "btn-ping";
  pingBtn.textContent = "Ping";
  actions.append(msgBtn, pingBtn);
  end.append(statusSlot, actions);

  node.append(avatar, who, end);

  Object.assign(row, { node, avatar, nameText, dot, sub, statusSlot, msgBtn, pingBtn });

  pingBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    void pingPeer(row);
  });
  msgBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    void messagePeer(row);
  });
  node.addEventListener("dblclick", () => void pingPeer(row));
  node.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void pingPeer(row);
  });

  return row;
}

function updateRowStatus(row, key) {
  const flash = sentFlash.get(key)?.state;
  const count = unread.get(key) || 0;
  row.statusSlot.textContent = "";
  if (flash === "sent") {
    const c = document.createElement("span");
    c.className = "sent-chip";
    c.textContent = "Sent ✓";
    row.statusSlot.append(c);
  } else if (flash === "failed") {
    const c = document.createElement("span");
    c.className = "failed-chip";
    c.textContent = "Failed";
    row.statusSlot.append(c);
  } else if (count > 0) {
    const b = document.createElement("span");
    b.className = "badge-unread";
    b.textContent = String(count);
    row.statusSlot.append(b);
  }
}

function updateRow(row, peer, key) {
  row.peer = peer;
  const label = displayName(peer);
  const online = presenceState(peer.lastSeen) === "online";
  if (row.nameText.textContent !== label) row.nameText.textContent = label;
  const dotClass = online ? "dot online" : "dot";
  if (row.dot.className !== dotClass) row.dot.className = dotClass;
  row.dot.title = online ? "online" : "away";
  const sub = `${normalizeIp(peer.ip) || "n/a"} · ${online ? "online" : formatAgo(peer.lastSeen)}`;
  if (row.sub.textContent !== sub) row.sub.textContent = sub;
  const init = initials(label);
  if (row.avatar.textContent !== init) row.avatar.textContent = init;
  updateRowStatus(row, key);
}

function reconcileList() {
  const list = sortedFilteredPeers();

  if (!list.length) {
    rowEls.forEach((row) => row.node.remove());
    rowEls.clear();
    el.peerEmpty.hidden = false;
    el.peerEmpty.textContent = filterText
      ? "No matches"
      : "Waiting for people on your network…";
    el.countLabel.textContent = filterText ? "No matches" : "On your network";
    return;
  }

  el.peerEmpty.hidden = true;
  const seen = new Set();
  for (const peer of list) {
    const key = peerKey(peer);
    seen.add(key);
    let row = rowEls.get(key);
    if (!row) {
      row = createRow(peer, key);
      rowEls.set(key, row);
    }
    updateRow(row, peer, key);
  }
  for (const [key, row] of rowEls) {
    if (!seen.has(key)) {
      row.node.remove();
      rowEls.delete(key);
    }
  }
  // Re-order DOM to match sort (appendChild moves existing nodes, no rebuild).
  for (const peer of list) {
    const row = rowEls.get(peerKey(peer));
    if (row) el.peerList.appendChild(row.node);
  }
  el.countLabel.textContent = `On your network · ${list.length}`;
}

// ---------------------------------------------------------------- actions

function flashStatus(key, state) {
  const prev = sentFlash.get(key);
  if (prev?.timer) clearTimeout(prev.timer);
  const timer = setTimeout(() => {
    sentFlash.delete(key);
    const row = rowEls.get(key);
    if (row) updateRowStatus(row, key);
  }, 1600);
  sentFlash.set(key, { state, timer });
  const row = rowEls.get(key);
  if (row) updateRowStatus(row, key);
}

async function pingPeer(row) {
  const peer = row.peer;
  const ip = normalizeIp(peer.ip);
  if (!ip) return;
  const key = peerKey(peer);
  row.pingBtn.disabled = true;
  try {
    const message = settings.customMessage || "";
    const shape = settings.pingShape || "circle";
    const targetIsV3 = Boolean(String(peer.peerId || "").trim());
    const sent = await sendPing(ip, message, wireSound(), shape);
    if (!targetIsV3) {
      try {
        await sendLegacyPing(ip, message, wireSound(), shape);
      } catch {
        // v1 bridge unreachable is fine; native path is authoritative.
      }
    }
    flashStatus(key, "sent");
    pushActivity({
      kind: "ping",
      direction: "out",
      peerId: peer.peerId || "",
      peerIp: ip,
      peerName: displayName(peer),
      message,
      timestamp: sent?.timestamp || Date.now(),
    });
  } catch {
    flashStatus(key, "failed");
  } finally {
    row.pingBtn.disabled = false;
  }
}

async function messagePeer(row) {
  const peer = row.peer;
  const ip = normalizeIp(peer.ip);
  if (!ip) return;
  const key = peerKey(peer);
  unread.delete(key);
  updateRowStatus(row, key);
  await openDirectChatWindow(ip, displayName(peer) || null);
}

// Legacy socket.io ping, sent only to reach v1 (Electron) peers with no peerId.
function sendLegacyPing(ip, message, sound, shape) {
  return new Promise((resolve) => {
    const socket = io(`http://${ip}:43210`, {
      timeout: 1200,
      reconnection: false,
      transports: ["websocket", "polling"],
    });
    const finish = (ok) => {
      try {
        socket.disconnect();
      } catch {
        // noop
      }
      resolve(ok);
    };
    socket.on("connect", () => {
      socket.emit("ping-user", {
        from: status?.hostname || "Pings",
        message: message || "",
        sound: sound || "chime",
        shape: shape || "circle",
      });
      setTimeout(() => finish(true), 180);
    });
    socket.on("connect_error", () => finish(false));
  });
}

// ---------------------------------------------------------------- activity + footer

function pushActivity(event) {
  historyAll.push(event); // keep oldest-first invariant
  if (historyAll.length > 500) historyAll = historyAll.slice(-500);
  updateFooter();
  if (!el.drawer.hidden && drawerTab === "activity") renderActivity();
}

function updateFooter() {
  const count = historyAll.filter((e) => e.kind === "ping" && isToday(e.timestamp)).length;
  el.pingsToday.textContent = `${count} ping${count === 1 ? "" : "s"} today`;
}

function activityTitle(event) {
  const who = escapeHtml(event.peerName || event.peerIp || "Someone");
  const mine = event.direction === "out";
  if (event.kind === "ping") return mine ? `You pinged <strong>${who}</strong>` : `<strong>${who}</strong> pinged you`;
  if (event.kind === "team-chat")
    return mine ? `You messaged <strong>the team</strong>` : `<strong>${who}</strong> messaged the team`;
  return mine ? `You messaged <strong>${who}</strong>` : `<strong>${who}</strong> messaged you`;
}

function dayLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

function renderActivity() {
  const events = [...historyAll].reverse(); // newest-first for display
  if (!events.length) {
    el.activityList.innerHTML = '<div class="empty-state">No activity yet</div>';
    return;
  }
  let html = "";
  let lastDay = "";
  for (const event of events) {
    const day = dayLabel(event.timestamp);
    if (day !== lastDay) {
      html += `<div class="day-sep">${escapeHtml(day)}</div>`;
      lastDay = day;
    }
    const glyph = event.kind === "ping" ? "ping" : event.kind === "team-chat" ? "team" : "chat";
    const msg = event.message
      ? `<div class="act-msg">${escapeHtml(event.message)}</div>`
      : "";
    html += `
      <div class="act-item">
        <span class="act-glyph ${glyph}"></span>
        <div class="act-body">
          <div class="act-title">${activityTitle(event)}</div>
          ${msg}
        </div>
        <span class="act-time">${escapeHtml(formatAgo(event.timestamp))}</span>
      </div>`;
  }
  el.activityList.innerHTML = html;
}

// ---------------------------------------------------------------- team chat

function maybeChatSound(kind) {
  if (!settings.chatSoundsEnabled) return;
  playSound(kind === "send" ? settings.chatSendSound || "tap" : settings.chatReceiveSound || "bubble");
}

function renderTeam() {
  if (!teamMessages.length) {
    el.teamMessages.innerHTML = '<div class="empty-state">No team messages yet</div>';
    return;
  }
  el.teamMessages.innerHTML = teamMessages
    .slice(-120)
    .map(
      (m) => `
      <div class="bubble ${m.mine ? "mine" : ""}">
        <span class="bubble-from">${escapeHtml(m.mine ? "You" : m.from || "Unknown")}</span>
        ${escapeHtml(m.message || "")}
      </div>`,
    )
    .join("");
  el.teamMessages.scrollTop = el.teamMessages.scrollHeight;
}

async function sendTeam() {
  const message = (el.teamInput.value || "").trim();
  if (!message) return;
  el.teamInput.value = "";
  const sent = await sendTeamChat(message);
  const ts = sent?.timestamp || Date.now();
  teamMessages.push({ from: "You", message, mine: true, timestamp: ts });
  pushActivity({ kind: "team-chat", direction: "out", peerName: "", peerIp: "", message, timestamp: ts });
  renderTeam();
  maybeChatSound("send");
}

// ---------------------------------------------------------------- drawer

function switchTab(tab) {
  drawerTab = tab;
  document.querySelectorAll(".tab").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === tab);
  });
  document.querySelectorAll(".drawer-panel").forEach((p) => {
    p.classList.toggle("active", p.dataset.panel === tab);
  });
  if (tab === "activity") renderActivity();
  if (tab === "team") {
    renderTeam();
    setTimeout(() => el.teamInput.focus(), 40);
  }
}

let drawerHideTimer = null;
function openDrawer(tab) {
  if (drawerHideTimer) clearTimeout(drawerHideTimer);
  el.drawer.hidden = false;
  el.scrim.hidden = false;
  el.drawer.setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => el.drawer.classList.add("open"));
  switchTab(tab);
}

function closeDrawer() {
  el.drawer.classList.remove("open");
  el.scrim.hidden = true;
  el.drawer.setAttribute("aria-hidden", "true");
  drawerHideTimer = setTimeout(() => {
    el.drawer.hidden = true;
  }, 210);
}

// ---------------------------------------------------------------- onboarding

function maybeShowOnboarding() {
  if (settings.hasCompletedOnboarding) return;
  el.onboard.hidden = false;
  el.onboardName.value = profile.displayName || status?.hostname || "";
  setTimeout(() => el.onboardName.focus(), 60);
}

async function finishOnboarding() {
  const name = (el.onboardName.value || "").trim();
  if (name) profile = await setProfile({ ...profile, displayName: name });
  const next = await updateSetting("hasCompletedOnboarding", true);
  settings = { ...settings, ...(next || {}) };
  el.onboard.hidden = true;
  renderSelf();
}

function previewPing() {
  el.onboardPreview.classList.remove("flash");
  void el.onboardPreview.offsetWidth; // restart the animation
  el.onboardPreview.classList.add("flash");
  playSound(settings.sound || "light");
}

// ---------------------------------------------------------------- wiring

function wireStaticControls() {
  el.onboardTry.addEventListener("click", previewPing);
  el.onboardDone.addEventListener("click", () => void finishOnboarding());
  el.onboardName.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void finishOnboarding();
  });

  el.openOptions.addEventListener("click", () => void openOptionsWindow());
  el.openTeam.addEventListener("click", () => openDrawer("team"));
  el.openActivity.addEventListener("click", () => openDrawer("activity"));
  el.closeDrawer.addEventListener("click", closeDrawer);
  el.scrim.addEventListener("click", closeDrawer);
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab || "activity"));
  });

  el.teamSend.addEventListener("click", () => void sendTeam());
  el.teamInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void sendTeam();
  });

  el.finder.addEventListener("input", () => {
    filterText = el.finder.value || "";
    reconcileList();
  });
  el.finder.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      el.finder.value = "";
      filterText = "";
      reconcileList();
      el.finder.blur();
      return;
    }
    if (e.key === "Enter") {
      const top = sortedFilteredPeers()[0];
      if (top) {
        const row = rowEls.get(peerKey(top));
        if (row) void pingPeer(row);
      }
    }
  });

  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      el.finder.focus();
      el.finder.select();
    }
    if (e.key === "Escape" && !el.drawer.hidden) closeDrawer();
  });
}

async function wireEvents() {
  await onPeersUpdated((payload) => {
    peers = Array.isArray(payload) ? payload : [];
    reconcileList();
  });

  await onNetworkStatus((payload) => {
    status = payload || status;
    renderSelf();
  });

  await onIncomingPing((payload) => {
    pushActivity({
      kind: "ping",
      direction: "in",
      peerId: payload?.fromPeerId || "",
      peerIp: normalizeIp(payload?.fromIp || ""),
      peerName: String(payload?.from || "").trim(),
      message: payload?.message || "",
      timestamp: payload?.timestamp || Date.now(),
    });
  });

  await onIncomingTeamChat((payload) => {
    const ts = payload?.timestamp || Date.now();
    teamMessages.push({
      from: String(payload?.from || "").trim() || "Unknown",
      message: payload?.message || "",
      mine: false,
      timestamp: ts,
    });
    pushActivity({
      kind: "team-chat",
      direction: "in",
      peerId: payload?.fromPeerId || "",
      peerIp: normalizeIp(payload?.fromIp || ""),
      peerName: String(payload?.from || "").trim(),
      message: payload?.message || "",
      timestamp: ts,
    });
    if (!el.drawer.hidden && drawerTab === "team") renderTeam();
    maybeChatSound("receive");
  });

  await onIncomingPrivateChat((payload) => {
    const key = String(payload?.fromPeerId || "").trim()
      ? `id:${String(payload.fromPeerId).trim()}`
      : `ip:${normalizeIp(payload?.fromIp || "")}`;
    if (key && key !== "ip:") {
      unread.set(key, (unread.get(key) || 0) + 1);
      const row = rowEls.get(key);
      if (row) updateRowStatus(row, key);
    }
    pushActivity({
      kind: "chat",
      direction: "in",
      peerId: payload?.fromPeerId || "",
      peerIp: normalizeIp(payload?.fromIp || ""),
      peerName: String(payload?.from || "").trim(),
      message: payload?.message || "",
      timestamp: payload?.timestamp || Date.now(),
    });
  });

  await onSettingsUpdated((next) => {
    settings = { ...settings, ...(next || {}) };
    applyTheme(settings);
  });
}

async function boot() {
  cacheElements();
  wireStaticControls();
  try {
    const [loadedSettings, loadedProfile, loadedStatus] = await Promise.all([
      getSettings(),
      getProfile(),
      getNetworkStatus(),
    ]);
    settings = { ...settings, ...(loadedSettings || {}) };
    profile = loadedProfile || {};
    status = loadedStatus || null;
    applyTheme(settings);
    renderSelf();
    maybeShowOnboarding();

    const [loadedPeers, loadedHistory] = await Promise.all([getPeers(), getHistory(200)]);
    peers = Array.isArray(loadedPeers) ? loadedPeers : [];
    historyAll = Array.isArray(loadedHistory) ? loadedHistory : [];
    teamMessages = historyAll
      .filter((e) => e.kind === "team-chat")
      .map((e) => ({
        from: e.direction === "out" ? "You" : e.peerName || "Unknown",
        message: e.message,
        mine: e.direction === "out",
        timestamp: e.timestamp,
      }));

    reconcileList();
    updateFooter();
    await wireEvents();

    // Keep relative times + presence honest without a server round-trip.
    setInterval(() => reconcileList(), 30_000);
  } catch (error) {
    el.peerEmpty.hidden = false;
    el.peerEmpty.textContent = `Couldn't start: ${String(error)}`;
  } finally {
    // Content is rendered — fade it in as a unit (see .win-enter in tokens.css).
    document.querySelector(".win-enter")?.classList.add("win-ready");
  }
}

window.addEventListener("DOMContentLoaded", () => void boot());

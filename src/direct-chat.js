import {
  getDirectChatContext,
  getPeers,
  getProfile,
  getNetworkStatus,
  getSettings,
  onIncomingPrivateChatWindow,
  onIncomingChatAck,
  onPeersUpdated,
  onSettingsUpdated,
  sendPrivateChat,
} from "./pings-api.js";
import { escapeHtml, formatAgo, initials } from "./core/format.js";
import { playSound } from "./core/sound.js";

const { listen } = window.__TAURI__.event;

let peerIp = "";
let peerName = "";
let messages = [];
let seenIncomingMessageKeys = new Set();
let cachedSettings = null;
let lastSettingsFetch = 0;

function applyTheme(settings = {}) {
  document.documentElement.setAttribute("data-theme", settings?.darkMode ? "dark" : "light");
}

function getCurrentLabel() {
  try {
    const win = window.__TAURI__?.webviewWindow?.getCurrentWebviewWindow?.();
    return String(win?.label || "");
  } catch {
    return "";
  }
}

function decodePeerIpFromLabel() {
  const label = getCurrentLabel();
  if (!label.startsWith("direct-chat-ip-")) return "";
  const raw = label.slice("direct-chat-ip-".length);
  return raw.replace(/_/g, ".");
}

function renderHeader() {
  const nameEl = document.getElementById("peer-name");
  const metaEl = document.getElementById("peer-meta");
  const avatarEl = document.getElementById("peer-avatar");
  const label = peerName || peerIp || "Direct Message";
  nameEl.textContent = label;
  metaEl.textContent = peerIp ? `${peerIp} · online` : "Waiting for peer info...";
  avatarEl.textContent = initials(label);
}

function renderMessages() {
  const el = document.getElementById("messages");
  if (!messages.length) {
    el.innerHTML = '<div class="empty">No messages yet</div>';
    return;
  }
  el.innerHTML = messages
    .slice(-120)
    .map((msg) => {
      const meta = msg.mine
        ? msg.delivered
          ? "✓✓ delivered"
          : "✓ sent"
        : formatAgo(msg.timestamp);
      return `
        <div class="bubble ${msg.mine ? "mine" : ""}">
          ${escapeHtml(msg.message || "")}
          <div class="meta">${escapeHtml(meta)}</div>
        </div>
      `;
    })
    .join("");
  el.scrollTop = el.scrollHeight;
}

function incomingMessageKey(payload) {
  return [
    payload?.kind || "",
    payload?.fromIp || "",
    payload?.toIp || "",
    payload?.timestamp || 0,
    payload?.message || "",
  ].join("|");
}

async function getLiveSettings() {
  if (cachedSettings && Date.now() - lastSettingsFetch < 1500) {
    return cachedSettings;
  }
  try {
    cachedSettings = await getSettings();
    lastSettingsFetch = Date.now();
    applyTheme(cachedSettings);
  } catch {
    cachedSettings = cachedSettings || {};
  }
  return cachedSettings;
}

async function maybePlayChatSound(kind) {
  const settings = await getLiveSettings();
  if (!settings?.chatSoundsEnabled) return;
  if (kind === "send") {
    playSound(settings.chatSendSound || "tap");
    return;
  }
  playSound(settings.chatReceiveSound || "bubble");
}

// Track this DM's peer across IP/name changes. `peersList` is the payload the
// peers-updated event already carries — no extra round-trip to the backend.
function refreshPeerIdentity(peersList) {
  const list = Array.isArray(peersList) ? peersList : [];
  if (!peerIp && !peerName) return;

  let peer = list.find((p) => p?.ip === peerIp);
  if (!peer && peerName) {
    peer = list
      .filter((p) => (p?.name || "").trim().toLowerCase() === peerName.trim().toLowerCase())
      .sort((a, b) => (b?.lastSeen || 0) - (a?.lastSeen || 0))[0];
  }

  if (!peer) return;
  if (peer?.ip && peer.ip !== peerIp) peerIp = peer.ip;
  if (peer?.name && peer.name !== peerName) peerName = peer.name;
  renderHeader();
}

function applyContext(payload = {}) {
  if (payload?.peerIp) {
    peerIp = String(payload.peerIp);
  }
  if (payload?.peerName) {
    peerName = String(payload.peerName);
  }
  renderHeader();
}

async function bootstrapContextFromBackend() {
  const label = getCurrentLabel();
  if (!label) return;
  try {
    const context = await getDirectChatContext(label);
    if (context) {
      applyContext(context);
    }
  } catch {
    // ignore backend context race, fallback paths will still run
  }
}

async function initWindowContext() {
  peerIp = decodePeerIpFromLabel();

  if (!peerIp) {
    const peers = await getPeers();
    if (Array.isArray(peers) && peers.length > 0) {
      peerIp = peers[0].ip || "";
      peerName = peers[0].name || "";
    }
  }

  if (!peerName && peerIp) {
    const peers = await getPeers();
    const peer = (Array.isArray(peers) ? peers : []).find((p) => p?.ip === peerIp);
    if (peer) peerName = peer.name || "";
  }

  if (!peerName) {
    const status = await getNetworkStatus();
    if (status?.hostname && !peerIp) peerName = status.hostname;
  }

  renderHeader();
}

async function wireComposer() {
  const input = document.getElementById("message-input");
  const sendBtn = document.getElementById("send-message");

  const sendNow = async () => {
    if (!peerIp) return;
    const message = (input.value || "").trim();
    if (!message) return;
    input.value = "";
    const sent = await sendPrivateChat(peerIp, message);
    messages.push({ ...sent, mine: true, delivered: false });
    renderMessages();
    await maybePlayChatSound("send");
  };

  sendBtn.addEventListener("click", () => void sendNow());
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      void sendNow();
    }
  });
}

window.addEventListener("DOMContentLoaded", async () => {
  const [settings] = await Promise.all([getLiveSettings(), getProfile()]);
  applyTheme(settings || {});

  await listen("direct-chat-context", async (event) => {
    applyContext(event.payload || {});
    refreshPeerIdentity(await getPeers());
  });

  await bootstrapContextFromBackend();
  await initWindowContext();
  await wireComposer();

  await onIncomingPrivateChatWindow(async (payload) => {
    const fromIp = payload?.fromIp || "";
    const fromName = String(payload?.from || "").trim().toLowerCase();
    const matchesIp = Boolean(peerIp && fromIp === peerIp);
    const matchesName = Boolean(peerName && fromName && fromName === peerName.trim().toLowerCase());
    if (!matchesIp && !matchesName) return;

    const key = incomingMessageKey(payload);
    if (seenIncomingMessageKeys.has(key)) return;
    seenIncomingMessageKeys.add(key);
    if (seenIncomingMessageKeys.size > 300) {
      seenIncomingMessageKeys = new Set([...seenIncomingMessageKeys].slice(-180));
    }

    if (fromIp && fromIp !== peerIp) {
      peerIp = fromIp;
      renderHeader();
    }

    messages.push({ ...payload, mine: false });
    renderMessages();
    await maybePlayChatSound("receive");
  });

  await onIncomingChatAck((payload) => {
    const id = payload?.id;
    if (!id) return;
    const msg = messages.find((m) => m.mine && m.id === id && !m.delivered);
    if (msg) {
      msg.delivered = true;
      renderMessages();
    }
  });

  await onPeersUpdated((peersList) => {
    refreshPeerIdentity(peersList);
  });

  await onSettingsUpdated((nextSettings) => {
    cachedSettings = nextSettings || cachedSettings;
    lastSettingsFetch = Date.now();
    applyTheme(cachedSettings || {});
  });

  renderMessages();
  document.querySelector(".win-enter")?.classList.add("win-ready");
});

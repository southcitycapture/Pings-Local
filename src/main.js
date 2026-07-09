import {
  health,
  migrationModules,
  getNetworkInterfaces,
  getNetworkStatus,
  getPeers,
  setPreferredIp,
  setDiscoveryNodeIp,
  onNetworkStatus,
  onPeersUpdated,
  onIncomingPing,
  onIncomingTeamChat,
  onIncomingPrivateChat,
  onSettingsUpdated,
  sendPing,
  sendTeamChat,
  getSettings,
  updateSetting,
  getProfile,
  setProfile,
  openOptionsWindow,
  openDirectChatWindow,
} from "./pings-api.js";
import { io } from "socket.io-client";

let peers = [];
let pingFeed = [];
let latestNetworkStatus = null;
let audioContext = null;
let teamMessages = [];
let activeAliasEditIp = "";
let currentSettings = {
  customMessage: "",
  sound: "light",
  pingShape: "circle",
  peerAliases: {},
  chatSoundsEnabled: true,
  chatSendSound: "tap",
  chatReceiveSound: "bubble",
  darkMode: false,
};

function applyTheme(settings = {}) {
  document.body.classList.toggle("dark", Boolean(settings.darkMode));
}

function getAudioContext() {
  if (!audioContext) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) {
      audioContext = new Ctx();
    }
  }
  return audioContext;
}

function playTone(freq = 800, type = "sine", duration = 0.12, gainValue = 0.24) {
  const ctx = getAudioContext();
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.value = 0;
  osc.connect(gain);
  gain.connect(ctx.destination);
  const now = ctx.currentTime;
  gain.gain.linearRampToValueAtTime(gainValue, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  osc.start(now);
  osc.stop(now + duration);
}

function playSound(rawSound) {
  const sound = String(rawSound || "light").toLowerCase();
  if (sound === "off") return;
  if (sound === "light") {
    playTone(980, "sine", 0.1, 0.14);
    return;
  }
  if (sound === "bubble") {
    playTone(720, "sine", 0.11, 0.18);
    return;
  }
  if (sound === "tap") {
    playTone(1350, "square", 0.05, 0.16);
    return;
  }
  if (sound === "bell") {
    playTone(620, "triangle", 0.22, 0.2);
    return;
  }
  if (sound === "drop") {
    playTone(340, "sine", 0.13, 0.2);
    return;
  }
  playTone(1140, "sine", 0.14, 0.24);
}

function maybePlayChatSound(kind) {
  if (!currentSettings.chatSoundsEnabled) return;
  if (kind === "send") {
    playSound(currentSettings.chatSendSound || "tap");
    return;
  }
  playSound(currentSettings.chatReceiveSound || "bubble");
}

function escapeHtml(text = "") {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function normalizeIp(value) {
  return String(value || "")
    .replace("::ffff:", "")
    .trim();
}

function getPeerAliases() {
  const raw = currentSettings.peerAliases;
  if (raw && typeof raw === "object") {
    return raw;
  }
  return {};
}

function getPeerAlias(ip) {
  const key = normalizeIp(ip);
  if (!key) return "";
  return String(getPeerAliases()[key] || "").trim();
}

function getDisplayPeerName(name, ip) {
  const alias = getPeerAlias(ip);
  if (alias) return alias;
  const fallbackName = String(name || "").trim();
  if (!fallbackName) return normalizeIp(ip) || "Unknown";
  if (normalizeIp(fallbackName) === normalizeIp(ip)) return normalizeIp(ip) || fallbackName;
  return fallbackName;
}

function guessAliasSeed(name, ip) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return "";
  if (normalizeIp(trimmed) === normalizeIp(ip)) return "";
  if (trimmed.toLowerCase() === "unknown") return "";
  return trimmed;
}

function formatAgo(ts) {
  if (!ts) return "never";
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  return `${Math.floor(min / 60)}h ago`;
}

function renderHealth(payload) {
  const healthEl = document.getElementById("health");
  if (healthEl) {
    healthEl.textContent = JSON.stringify(payload, null, 2);
  }
}

function renderModules(modules) {
  const list = document.getElementById("modules");
  if (!list) return;
  list.innerHTML = modules.map((name) => `<li>${escapeHtml(name)}</li>`).join("");
}

function renderInterfaceOptions(interfaces, selectedIp = "") {
  const select = document.getElementById("preferred-ip");
  const options = [
    '<option value="">Auto (Best LAN IP)</option>',
    ...interfaces.map(
      (item) =>
        `<option value="${escapeHtml(item.address)}">${escapeHtml(item.name)} - ${escapeHtml(item.address)}</option>`,
    ),
  ];
  select.innerHTML = options.join("");
  select.value = selectedIp || "";
}

function renderStatusPill(status) {
  const el = document.getElementById("active-status");
  const count = status?.diagnostics?.peersCount || peers.length || 0;
  el.textContent = `${status?.hostname || "Pings"} on ${status?.ip || "n/a"} | ${count} peer${count === 1 ? "" : "s"}`;
}

function renderNetworkStatus(payload) {
  latestNetworkStatus = payload || latestNetworkStatus;
  const networkEl = document.getElementById("network-status");
  if (networkEl) {
    networkEl.textContent = JSON.stringify(payload, null, 2);
  }
  renderStatusPill(payload);
}

function renderPersistenceStatus(payload) {
  const persistenceEl = document.getElementById("persistence-status");
  if (persistenceEl) {
    persistenceEl.textContent = JSON.stringify(payload, null, 2);
  }
}

function applyUiSettings(settings) {
  currentSettings = { ...currentSettings, ...(settings || {}) };
  applyTheme(currentSettings);
}

async function savePeerAlias(ip, nextName) {
  const normalizedIp = normalizeIp(ip);
  if (!normalizedIp) return;
  const current = { ...getPeerAliases() };
  const trimmed = String(nextName || "").trim();
  if (!trimmed) {
    delete current[normalizedIp];
  } else {
    current[normalizedIp] = trimmed;
  }
  const settings = await updateSetting("peerAliases", current);
  applyUiSettings(settings);
  renderPeers();
  renderPingFeed();
  renderTeamChat();
}

function switchTab(tabName) {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-tab") === tabName);
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.getAttribute("data-panel") === tabName);
  });
}

function wireTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      switchTab(btn.getAttribute("data-tab") || "people");
    });
  });
}

function setPingButtonState(btn, state) {
  btn.classList.remove("is-sending", "is-sent", "is-failed");
  btn.disabled = false;
  if (state === "sending") {
    btn.classList.add("is-sending");
    btn.disabled = true;
    btn.textContent = "Sending...";
    return;
  }
  if (state === "sent") {
    btn.classList.add("is-sent");
    btn.textContent = "Sent";
    return;
  }
  if (state === "failed") {
    btn.classList.add("is-failed");
    btn.textContent = "Failed";
    return;
  }
  btn.textContent = "Ping";
}

function renderPeers() {
  const peersList = document.getElementById("peers-list");
  const peersSummary = document.getElementById("peers-summary");
  const dedupedPeers = Array.isArray(peers)
    ? Object.values(
        peers.reduce((acc, peer) => {
          // Prefer the stable peerId so a peer that changed IP collapses to a
          // single row instead of appearing twice during the stale window.
          const key = peer?.peerId || peer?.ip || peer?.name || "unknown-peer";
          const prev = acc[key];
          if (!prev || (peer?.lastSeen || 0) > (prev?.lastSeen || 0)) {
            acc[key] = peer;
          }
          return acc;
        }, {}),
      )
    : [];

  if (dedupedPeers.length === 0) {
    peersSummary.textContent = "No peers discovered yet";
    peersList.innerHTML = '<div class="empty-state">Waiting for LAN peers...</div>';
    return;
  }

  peersSummary.textContent = `${dedupedPeers.length} peer${dedupedPeers.length === 1 ? "" : "s"} discovered`;
  peersList.innerHTML = dedupedPeers
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
    .map((peer) => {
      const peerIp = normalizeIp(peer.ip || "");
      const peerLabel = getDisplayPeerName(peer.name || "", peerIp);
      return `
        <div class="peer-card" style="border-left-color:${escapeHtml(peer.color || "#14b8a6")}">
          <div class="peer-name">${escapeHtml(peerLabel || "Unknown")}</div>
          <div class="peer-meta">${escapeHtml(peerIp || "n/a")} | seen ${escapeHtml(formatAgo(peer.lastSeen))}</div>
          <div class="peer-actions">
            <button class="ping-btn" data-ip="${escapeHtml(peerIp)}" data-name="${escapeHtml(peerLabel)}">Ping</button>
            <button class="chat-btn" data-chat-ip="${escapeHtml(peerIp)}" data-chat-name="${escapeHtml(peerLabel)}">Message</button>
          </div>
        </div>
      `;
    })
    .join("");

  peersList.querySelectorAll(".ping-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const ip = btn.getAttribute("data-ip") || "";
      if (!ip) return;
      setPingButtonState(btn, "sending");
      try {
        const message = currentSettings.customMessage || "";
        const sound = currentSettings.sound || "light";
        const shape = currentSettings.pingShape || "circle";
        const wireSound = sound === "light" ? "chime" : sound;

        // Native UDP is the one true delivery path. The legacy socket.io bridge
        // is only for reaching v1 (Electron) peers, which have no peerId — so we
        // fire it *only* when the target isn't a known v3 peer. Sending both to a
        // v3 peer is what caused the double overlay/sound/feed entry.
        const targetPeer = (Array.isArray(peers) ? peers : []).find(
          (p) => normalizeIp(p?.ip || "") === ip,
        );
        const targetIsV3 = Boolean(targetPeer && String(targetPeer.peerId || "").trim());

        const sent = await sendPing(ip, message, wireSound, shape);
        let legacyState = "direct";
        if (!targetIsV3) {
          const legacyOk = await sendLegacyPing(ip, message, wireSound, shape);
          legacyState = legacyOk ? "v1 bridge ok" : "v1 bridge n/a";
        }

        pingFeed.unshift({
          type: "outgoing",
          peerIp: ip,
          peerName: btn.getAttribute("data-name") || "",
          message: sent?.message || "",
          timestamp: sent?.timestamp || Date.now(),
          title: `Ping sent to ${btn.getAttribute("data-name") || ip}`,
          meta: `${sent?.fromIp || "n/a"} | ${sent?.message || "(no message)"} | ${legacyState} | ${formatAgo(sent?.timestamp)}`,
        });
        renderPingFeed();
        setPingButtonState(btn, "sent");
      } catch (error) {
        pingFeed.unshift({
          type: "failed",
          peerIp: ip,
          peerName: btn.getAttribute("data-name") || "",
          timestamp: Date.now(),
          title: `Ping failed for ${btn.getAttribute("data-name") || ip}`,
          meta: String(error),
        });
        renderPingFeed();
        setPingButtonState(btn, "failed");
      } finally {
        setTimeout(() => {
          setPingButtonState(btn, "idle");
        }, 800);
      }
    });
  });

  peersList.querySelectorAll(".chat-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const ip = btn.getAttribute("data-chat-ip") || "";
      const name = btn.getAttribute("data-chat-name") || "";
      if (!ip) return;
      await openDirectChatWindow(ip, name || null);
    });
  });
}

function renderPingFeed() {
  const feed = document.getElementById("ping-feed");
  if (!feed) return;
  if (!pingFeed.length) {
    feed.innerHTML = '<div class="empty-state">No pings yet</div>';
    return;
  }
  const rows = pingFeed.slice(0, 20);
  feed.innerHTML = rows
    .map((item, index) => {
      const peerIp = normalizeIp(item.peerIp || "");
      const peerLabel = getDisplayPeerName(item.peerName || "", peerIp);
      const title =
        item.title ||
        (item.type === "incoming" ? `Ping from ${peerLabel || "Unknown"}` : "Ping update");
      const meta =
        item.meta ||
        `${peerIp || "n/a"} | ${item.message || "(no message)"} | ${formatAgo(item.timestamp)}`;
      const showNameCta = item.type === "incoming" && Boolean(peerIp);
      const editing = showNameCta && activeAliasEditIp === peerIp;
      const hasAlias = Boolean(getPeerAlias(peerIp));
      const seed = guessAliasSeed(item.peerName || "", peerIp);

      return `
        <div class="ping-item ${item.type}">
          <div class="ping-title">${escapeHtml(title)}</div>
          <div class="ping-meta">${escapeHtml(meta)}</div>
          ${
            showNameCta
              ? `
            <div class="ping-actions">
              ${
                editing
                  ? `
                <div class="ping-alias-editor">
                  <input class="ping-alias-input" data-ip="${escapeHtml(peerIp)}" type="text" value="${escapeHtml(hasAlias ? getPeerAlias(peerIp) : seed)}" placeholder="Enter name" />
                  <button class="ping-alias-save" data-ip="${escapeHtml(peerIp)}">Save</button>
                  <button class="ping-alias-cancel" data-ip="${escapeHtml(peerIp)}">Cancel</button>
                </div>
              `
                  : `
                <button class="ping-name-btn" data-ip="${escapeHtml(peerIp)}" data-seed="${escapeHtml(seed)}">
                  ${hasAlias ? "Edit Name" : "Add Name"}
                </button>
              `
              }
            </div>
          `
              : ""
          }
        </div>
      `;
    })
    .join("");

  feed.querySelectorAll(".ping-name-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeAliasEditIp = normalizeIp(btn.getAttribute("data-ip") || "");
      renderPingFeed();
      const input = feed.querySelector(`.ping-alias-input[data-ip="${CSS.escape(activeAliasEditIp)}"]`);
      if (input) {
        input.focus();
        input.select();
      }
    });
  });

  feed.querySelectorAll(".ping-alias-cancel").forEach((btn) => {
    btn.addEventListener("click", () => {
      const ip = normalizeIp(btn.getAttribute("data-ip") || "");
      if (ip === activeAliasEditIp) {
        activeAliasEditIp = "";
        renderPingFeed();
      }
    });
  });

  feed.querySelectorAll(".ping-alias-save").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const ip = normalizeIp(btn.getAttribute("data-ip") || "");
      const input = feed.querySelector(`.ping-alias-input[data-ip="${CSS.escape(ip)}"]`);
      const next = (input?.value || "").trim();
      activeAliasEditIp = "";
      await savePeerAlias(ip, next);
    });
  });

  feed.querySelectorAll(".ping-alias-input").forEach((input) => {
    input.addEventListener("keydown", async (event) => {
      const ip = normalizeIp(input.getAttribute("data-ip") || "");
      if (event.key === "Escape") {
        activeAliasEditIp = "";
        renderPingFeed();
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        activeAliasEditIp = "";
        await savePeerAlias(ip, input.value || "");
      }
    });
  });
}

function renderTeamChat() {
  const el = document.getElementById("team-chat-messages");
  if (!el) return;
  if (!teamMessages.length) {
    el.innerHTML = '<div class="empty-state">No team messages yet</div>';
    return;
  }
  el.innerHTML = teamMessages
    .slice(-80)
    .map((msg) => {
      const peerLabel = getDisplayPeerName(msg.from || "", msg.fromIp || "");
      return `
      <div class="chat-bubble ${msg.mine ? "mine" : ""}">
        <div><strong>${escapeHtml(peerLabel || "Unknown")}</strong>: ${escapeHtml(msg.message || "")}</div>
        <div class="chat-meta">${escapeHtml(msg.fromIp || "n/a")} | ${escapeHtml(formatAgo(msg.timestamp))}</div>
      </div>
    `;
    })
    .join("");
  el.scrollTop = el.scrollHeight;
}

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
        from: latestNetworkStatus?.hostname || "Pings v2",
        message: message || "",
        sound: sound || "chime",
        shape: shape || "circle",
      });
      setTimeout(() => finish(true), 180);
    });
    socket.on("connect_error", () => finish(false));
  });
}

async function wireChatControls() {
  const sendTeamBtn = document.getElementById("send-team-chat");
  const teamInput = document.getElementById("team-chat-input");

  const sendTeam = async () => {
    const message = (teamInput.value || "").trim();
    if (!message) return;
    teamInput.value = "";
    const sent = await sendTeamChat(message);
    teamMessages.push({ ...sent, mine: true });
    renderTeamChat();
    maybePlayChatSound("send");
  };

  sendTeamBtn.addEventListener("click", () => void sendTeam());
  teamInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void sendTeam();
  });
}

async function wireNetworkControls() {
  const preferredIpSelect = document.getElementById("preferred-ip");
  const discoveryNodeInput = document.getElementById("discovery-node-ip");
  const setNodeBtn = document.getElementById("set-node-ip");

  const [interfaces, status] = await Promise.all([getNetworkInterfaces(), getNetworkStatus()]);
  renderInterfaceOptions(interfaces, status.preferredIp || "");
  discoveryNodeInput.value = status.discoveryNodeIp || "";
  renderNetworkStatus(status);

  preferredIpSelect.addEventListener("change", async () => {
    const updated = await setPreferredIp(preferredIpSelect.value || "");
    renderNetworkStatus(updated);
    const refreshed = await getNetworkInterfaces();
    renderInterfaceOptions(refreshed, updated.preferredIp || "");
    await updateSetting("preferredIp", updated.preferredIp || "");
  });

  setNodeBtn.addEventListener("click", async () => {
    const value = discoveryNodeInput.value.trim();
    const updated = await setDiscoveryNodeIp(value);
    renderNetworkStatus(updated);
    await updateSetting("discoveryNodeIp", value);
  });

  await onNetworkStatus((payload) => {
    renderNetworkStatus(payload);
  });
}

async function wirePersistenceControls() {
  const profileNameInput = document.getElementById("profile-name");
  const saveProfileBtn = document.getElementById("save-profile");
  const customMessageInput = document.getElementById("custom-message");
  const saveCustomMessageBtn = document.getElementById("save-custom-message");
  const pingSoundSelect = document.getElementById("ping-sound");
  const pingShapeSelect = document.getElementById("ping-shape");

  const [profile, settings] = await Promise.all([getProfile(), getSettings()]);
  applyUiSettings(settings);
  profileNameInput.value = profile.displayName || "";
  customMessageInput.value = settings.customMessage || "";
  pingSoundSelect.value = currentSettings.sound || "light";
  pingShapeSelect.value = currentSettings.pingShape || "circle";
  renderPersistenceStatus({ profile, settings });

  saveProfileBtn.addEventListener("click", async () => {
    const next = {
      ...profile,
      displayName: profileNameInput.value.trim(),
    };
    const saved = await setProfile(next);
    renderPersistenceStatus({ profile: saved, settings: await getSettings() });
    renderStatusPill(await getNetworkStatus());
  });

  saveCustomMessageBtn.addEventListener("click", async () => {
    const nextSettings = await updateSetting("customMessage", customMessageInput.value.trim());
    applyUiSettings(nextSettings);
    renderPersistenceStatus({ profile: await getProfile(), settings: nextSettings });
  });

  pingSoundSelect.addEventListener("change", async () => {
    const next = pingSoundSelect.value || "light";
    const nextSettings = await updateSetting("sound", next);
    applyUiSettings({ ...nextSettings, sound: next });
    renderPersistenceStatus({ profile: await getProfile(), settings: nextSettings });
    playSound(next);
  });

  pingShapeSelect.addEventListener("change", async () => {
    const next = pingShapeSelect.value || "circle";
    const nextSettings = await updateSetting("pingShape", next);
    applyUiSettings({ ...nextSettings, pingShape: next });
    renderPersistenceStatus({ profile: await getProfile(), settings: nextSettings });
  });
}

function wireTopbarActions() {
  const openOptionsBtn = document.getElementById("open-options");
  openOptionsBtn.addEventListener("click", async () => {
    await openOptionsWindow();
  });
}

window.addEventListener("DOMContentLoaded", async () => {
  try {
    wireTabs();
    await onPeersUpdated((payload) => {
      peers = Array.isArray(payload) ? payload : [];
      renderPeers();
    });

    await onIncomingPing((payload) => {
      const peerIp = normalizeIp(payload?.fromIp || "");
      const peerName = String(payload?.from || "").trim();
      const peerLabel = getDisplayPeerName(peerName, peerIp);
      pingFeed.unshift({
        type: "incoming",
        peerIp,
        peerName,
        message: payload?.message || "",
        timestamp: payload?.timestamp || Date.now(),
        title: `Ping from ${peerLabel || "Unknown"}`,
        meta: `${peerIp || "n/a"} | ${payload?.message || "(no message)"} | ${formatAgo(payload?.timestamp)}`,
      });
      renderPingFeed();
      playSound(payload?.sound || currentSettings.sound || "light");
    });

    await onIncomingTeamChat((payload) => {
      teamMessages.push({ ...payload, mine: false });
      renderTeamChat();
      maybePlayChatSound("receive");
    });

    await onIncomingPrivateChat(async (payload) => {
      const peerIp = payload?.fromIp || "";
      if (!peerIp) return;
      maybePlayChatSound("receive");
      const peerLabel = getDisplayPeerName(payload?.from || "", peerIp);
      await openDirectChatWindow(peerIp, peerLabel || null);
    });

    await onSettingsUpdated((settings) => {
      applyUiSettings(settings || {});
      renderPeers();
      renderPingFeed();
      renderTeamChat();
    });

    const [healthPayload, modules] = await Promise.all([health(), migrationModules()]);
    renderHealth(healthPayload);
    renderModules(modules);
    wireTopbarActions();
    await wireNetworkControls();
    await wirePersistenceControls();
    await wireChatControls();
    peers = await getPeers();
    renderPeers();
    renderPingFeed();
    renderTeamChat();
    switchTab("people");
  } catch (error) {
    const healthEl = document.getElementById("health");
    if (healthEl) {
      healthEl.textContent = `UI init failed: ${String(error)}`;
    }
  }
});

import {
  getPeers,
  getSettings,
  onPeersUpdated,
  sendPing,
  openDirectChatWindow,
  hidePalette,
} from "./pings-api.js";
import { normalizeIp, escapeHtml, initials, displayName, presenceState } from "./core/format.js";
import { revealWindow } from "./core/enter.js";

const { listen } = window.__TAURI__.event;

let peers = [];
let settings = { sound: "light", pingShape: "circle", customMessage: "", darkMode: false };
let filtered = [];
let selected = 0;

const el = {};

function applyTheme() {
  document.documentElement.setAttribute("data-theme", settings.darkMode ? "dark" : "light");
}

function wireSound() {
  const s = settings.sound || "light";
  return s === "light" ? "chime" : s;
}

function computeFiltered() {
  const q = (el.input.value || "").trim().toLowerCase();
  const byKey = new Map();
  for (const p of Array.isArray(peers) ? peers : []) {
    const key = p?.peerId || p?.ip || p?.name;
    if (!key) continue;
    const prev = byKey.get(key);
    if (!prev || (p?.lastSeen || 0) > (prev?.lastSeen || 0)) byKey.set(key, p);
  }
  let list = [...byKey.values()];
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
  filtered = list;
  if (selected >= filtered.length) selected = Math.max(0, filtered.length - 1);
}

function render() {
  if (!filtered.length) {
    el.results.innerHTML = `<div class="empty">${peers.length ? "No matches" : "No one on your network yet"}</div>`;
    return;
  }
  el.results.innerHTML = filtered
    .map((peer, i) => {
      const label = displayName(peer);
      return `
        <div class="result ${i === selected ? "selected" : ""}" data-i="${i}">
          <span class="avatar">${escapeHtml(initials(label))}</span>
          <span class="r-name">${escapeHtml(label)}</span>
          <span class="r-ip">${escapeHtml(normalizeIp(peer.ip) || "n/a")}</span>
        </div>`;
    })
    .join("");

  el.results.querySelectorAll(".result").forEach((row) => {
    row.addEventListener("mousemove", () => {
      const i = Number(row.dataset.i);
      if (i !== selected) {
        selected = i;
        render();
      }
    });
    row.addEventListener("click", () => {
      selected = Number(row.dataset.i);
      void pingSelected();
    });
  });

  const selectedEl = el.results.querySelector(".result.selected");
  if (selectedEl) selectedEl.scrollIntoView({ block: "nearest" });
}

async function pingSelected() {
  const peer = filtered[selected];
  if (!peer) return;
  const ip = normalizeIp(peer.ip);
  if (!ip) return;
  await sendPing(ip, settings.customMessage || "", wireSound(), settings.pingShape || "circle");
  await dismiss();
}

async function messageSelected() {
  const peer = filtered[selected];
  if (!peer) return;
  const ip = normalizeIp(peer.ip);
  if (!ip) return;
  await openDirectChatWindow(ip, displayName(peer) || null);
  await dismiss();
}

async function dismiss() {
  el.input.value = "";
  computeFiltered();
  render();
  try {
    await hidePalette();
  } catch {
    // ignore
  }
}

async function reload() {
  const [loadedPeers, loadedSettings] = await Promise.all([getPeers(), getSettings()]);
  peers = Array.isArray(loadedPeers) ? loadedPeers : [];
  settings = { ...settings, ...(loadedSettings || {}) };
  applyTheme();
  computeFiltered();
  render();
}

window.addEventListener("DOMContentLoaded", async () => {
  el.input = document.getElementById("q");
  el.results = document.getElementById("results");

  el.input.addEventListener("input", () => {
    selected = 0;
    computeFiltered();
    render();
  });

  el.input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (selected < filtered.length - 1) {
        selected += 1;
        render();
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (selected > 0) {
        selected -= 1;
        render();
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) void messageSelected();
      else void pingSelected();
    } else if (e.key === "Escape") {
      e.preventDefault();
      void dismiss();
    }
  });

  await reload();
  await revealWindow();
  el.input.focus();

  await onPeersUpdated((payload) => {
    peers = Array.isArray(payload) ? payload : [];
    computeFiltered();
    render();
  });

  // Re-armed each time the shortcut summons the palette.
  await listen("palette-shown", async () => {
    el.input.value = "";
    selected = 0;
    await reload();
    el.input.focus();
    el.input.select();
  });
});

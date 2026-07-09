import { getSettings, sendPrivateChat, hideToast } from "./pings-api.js";
import { normalizeIp, escapeHtml, initials } from "./core/format.js";

const { listen } = window.__TAURI__.event;

const DEFAULT_REPLIES = ["On my way!", "Be there in 5", "Thanks!", "👍"];
const DISMISS_MS = 7000;

let current = { ip: "", name: "" };
let dismissTimer = null;
const el = {};

function applyTheme(settings) {
  document.documentElement.setAttribute("data-theme", settings?.darkMode ? "dark" : "light");
}

function quickReplies(settings) {
  const list = Array.isArray(settings?.quickReplies) ? settings.quickReplies : [];
  const cleaned = list.map((s) => String(s || "").trim()).filter(Boolean);
  return (cleaned.length ? cleaned : DEFAULT_REPLIES).slice(0, 4);
}

async function dismiss() {
  if (dismissTimer) clearTimeout(dismissTimer);
  dismissTimer = null;
  try {
    await hideToast();
  } catch {
    // ignore
  }
}

async function sendReply(text) {
  if (dismissTimer) clearTimeout(dismissTimer);
  if (current.ip) {
    try {
      await sendPrivateChat(current.ip, text);
    } catch {
      // ignore send failure; dismiss anyway
    }
  }
  await dismiss();
}

function render(settings) {
  const name = current.name || current.ip || "Someone";
  el.avatar.textContent = initials(name);
  el.title.textContent = `${name} pinged you`;
  el.msg.textContent = current.message || "";
  el.msg.style.display = current.message ? "" : "none";

  el.chips.innerHTML = "";
  for (const reply of quickReplies(settings)) {
    const chip = document.createElement("button");
    chip.className = "chip";
    chip.textContent = reply;
    chip.addEventListener("click", () => void sendReply(reply));
    el.chips.append(chip);
  }
  document.querySelector(".win-enter")?.classList.add("win-ready");
}

window.addEventListener("DOMContentLoaded", () => {
  el.avatar = document.getElementById("avatar");
  el.title = document.getElementById("title");
  el.msg = document.getElementById("msg");
  el.chips = document.getElementById("chips");
  el.close = document.getElementById("close");

  el.close.addEventListener("click", () => void dismiss());
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") void dismiss();
  });

  void listen("toast-ping", async (event) => {
    const payload = event.payload || {};
    current = {
      ip: normalizeIp(payload.fromIp || ""),
      name: String(payload.from || "").trim(),
      message: payload.message || "",
    };
    let settings = {};
    try {
      settings = (await getSettings()) || {};
    } catch {
      settings = {};
    }
    applyTheme(settings);
    render(settings);

    if (dismissTimer) clearTimeout(dismissTimer);
    dismissTimer = setTimeout(() => void dismiss(), DISMISS_MS);
  });
});

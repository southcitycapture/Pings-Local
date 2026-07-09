import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const fields = {
  effectColor: document.getElementById("effect-color"),
  effectOpacity: document.getElementById("effect-opacity"),
  borderThickness: document.getElementById("border-thickness"),
  effectFeather: document.getElementById("effect-feather"),
  effectDurationMs: document.getElementById("effect-duration-ms"),
  reduceMotion: document.getElementById("reduce-motion"),
  sound: document.getElementById("sound"),
  pingShape: document.getElementById("ping-shape"),
  dnd: document.getElementById("dnd"),
  darkMode: document.getElementById("dark-mode"),
  chatSoundsEnabled: document.getElementById("chat-sounds-enabled"),
  chatSendSound: document.getElementById("chat-send-sound"),
  chatReceiveSound: document.getElementById("chat-receive-sound"),
  customMessage: document.getElementById("custom-message"),
  profileName: document.getElementById("profile-name"),
  avatarInput: document.getElementById("profile-avatar-input"),
  avatarPreview: document.getElementById("profile-avatar-preview"),
  clearAvatar: document.getElementById("clear-profile-avatar"),
  checkUpdates: document.getElementById("check-updates"),
  updateStatus: document.getElementById("update-status"),
};

const RANGE_LABELS = {
  effectOpacity: (v) => `${Math.round(Number(v) * 100)}%`,
  borderThickness: (v) => `${v}px`,
  effectFeather: (v) => `${v}px`,
  effectDurationMs: (v) => `${(Number(v) / 1000).toFixed(2)}s`,
};

function updateRangeLabel(key) {
  const el = document.getElementById(`${fields[key].id}-value`);
  if (el) el.textContent = RANGE_LABELS[key](fields[key].value);
}

const statusEl = document.getElementById("status");
let profileCache = null;
const updateButtonLabel = fields.checkUpdates?.textContent || "Check for updates";

function applyTheme(settings) {
  document.documentElement.setAttribute("data-theme", settings?.darkMode ? "dark" : "light");
}

function renderStatus(payload) {
  statusEl.textContent = JSON.stringify(payload, null, 2);
}

function setUpdateStatus(text, tone = "muted") {
  if (!fields.updateStatus) return;
  fields.updateStatus.textContent = text;
  fields.updateStatus.dataset.tone = tone;
}

function setUpdateBusy(busy, label = "Checking...") {
  if (!fields.checkUpdates) return;
  fields.checkUpdates.disabled = busy;
  fields.checkUpdates.textContent = busy ? label : updateButtonLabel;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function getUpdaterErrorMessage(error) {
  const raw = String(error?.message || error || "Unknown updater error");
  const message = raw.toLowerCase();
  if (
    (message.includes("updater") && message.includes("configured")) ||
    message.includes("endpoint") ||
    message.includes("pubkey") ||
    message.includes("plugin:updater")
  ) {
    return "Updates are not configured in this build yet.";
  }
  if (message.includes("signature")) {
    return "Update signature verification failed.";
  }
  if (message.includes("network") || message.includes("timeout") || message.includes("dns")) {
    return "Update check failed due to a network error.";
  }
  return `Update check failed: ${raw}`;
}

async function checkForUpdates() {
  setUpdateBusy(true, "Checking...");
  setUpdateStatus("Checking for updates...", "info");
  try {
    const update = await check();
    if (!update) {
      setUpdateStatus("You are up to date.", "success");
      return;
    }

    let totalBytes = 0;
    let downloadedBytes = 0;
    setUpdateBusy(true, "Installing...");
    setUpdateStatus(`Update ${update.version} found. Downloading...`, "info");

    await update.downloadAndInstall((event) => {
      if (event?.event === "Started") {
        totalBytes = Number(event?.data?.contentLength || 0);
        downloadedBytes = 0;
        const totalText = totalBytes > 0 ? ` (${formatBytes(totalBytes)})` : "";
        setUpdateStatus(`Downloading update${totalText}...`, "info");
        return;
      }
      if (event?.event === "Progress") {
        downloadedBytes += Number(event?.data?.chunkLength || 0);
        if (totalBytes > 0) {
          const pct = Math.min(100, Math.round((downloadedBytes / totalBytes) * 100));
          setUpdateStatus(
            `Downloading... ${pct}% (${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)})`,
            "info",
          );
        } else {
          setUpdateStatus(`Downloading... ${formatBytes(downloadedBytes)}`, "info");
        }
        return;
      }
      if (event?.event === "Finished") {
        setUpdateStatus("Installing update...", "info");
      }
    });

    setUpdateStatus("Update installed. Restarting Pings...", "success");
    await relaunch();
  } catch (error) {
    console.error("[options] updater failed", error);
    setUpdateStatus(getUpdaterErrorMessage(error), "error");
  } finally {
    setUpdateBusy(false);
  }
}

function applyToInputs(settings) {
  fields.effectColor.value = settings.effectColor || "#14b8a6";
  fields.effectOpacity.value = String(settings.effectOpacity ?? 0.9);
  fields.borderThickness.value = String(settings.borderThickness ?? 28);
  fields.effectFeather.value = String(settings.effectFeather ?? 42);
  fields.effectDurationMs.value = String(settings.effectDurationMs ?? 1150);
  fields.reduceMotion.checked = Boolean(settings.reduceMotion);
  fields.sound.value = settings.sound || "light";
  fields.pingShape.value = settings.pingShape || "circle";
  fields.dnd.checked = Boolean(settings.dnd);
  fields.darkMode.checked = Boolean(settings.darkMode);
  fields.chatSoundsEnabled.checked = settings.chatSoundsEnabled !== false;
  fields.chatSendSound.value = settings.chatSendSound || "tap";
  fields.chatReceiveSound.value = settings.chatReceiveSound || "bubble";
  fields.customMessage.value = settings.customMessage || "";
  ["effectOpacity", "borderThickness", "effectFeather", "effectDurationMs"].forEach(updateRangeLabel);
  applyTheme(settings);
}

function renderAvatar(profile) {
  const avatar = profile?.avatar || "";
  if (avatar) {
    fields.avatarPreview.src = avatar;
    fields.avatarPreview.classList.add("has-avatar");
    return;
  }
  fields.avatarPreview.removeAttribute("src");
  fields.avatarPreview.classList.remove("has-avatar");
}

async function saveSetting(key, value) {
  const settings = await invoke("update_setting", { key, value });
  applyToInputs(settings);
  renderStatus({ settings, profile: profileCache });
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("file-read-failed"));
    reader.readAsDataURL(file);
  });
}

function resizeDataUrlImage(dataUrl, maxSize = 256, quality = 0.85) {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      const ratio = Math.min(maxSize / image.width, maxSize / image.height, 1);
      const width = Math.max(1, Math.round(image.width * ratio));
      const height = Math.max(1, Math.round(image.height * ratio));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(dataUrl);
        return;
      }
      ctx.drawImage(image, 0, 0, width, height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    image.onerror = () => resolve(dataUrl);
    image.src = dataUrl;
  });
}

async function saveProfile(nextProfile) {
  profileCache = await invoke("set_profile", { profile: nextProfile });
  renderAvatar(profileCache);
  renderStatus({ settings: await invoke("get_settings"), profile: profileCache });
}

window.addEventListener("DOMContentLoaded", async () => {
  const [settings, profile] = await Promise.all([invoke("get_settings"), invoke("get_profile")]);
  profileCache = profile;
  applyToInputs(settings);
  fields.profileName.value = profile?.displayName || "";
  renderAvatar(profile);
  renderStatus({ settings, profile });

  fields.customMessage.addEventListener("change", () =>
    saveSetting("customMessage", fields.customMessage.value.trim()),
  );
  fields.profileName.addEventListener("change", async () => {
    await saveProfile({ ...(profileCache || {}), displayName: fields.profileName.value.trim() });
  });

  fields.effectColor.addEventListener("change", () => saveSetting("effectColor", fields.effectColor.value));
  fields.effectOpacity.addEventListener("input", () => {
    updateRangeLabel("effectOpacity");
    saveSetting("effectOpacity", Number(fields.effectOpacity.value));
  });
  fields.borderThickness.addEventListener("input", () => {
    updateRangeLabel("borderThickness");
    saveSetting("borderThickness", Number(fields.borderThickness.value));
  });
  fields.effectFeather.addEventListener("input", () => {
    updateRangeLabel("effectFeather");
    saveSetting("effectFeather", Number(fields.effectFeather.value));
  });
  fields.effectDurationMs.addEventListener("input", () => {
    updateRangeLabel("effectDurationMs");
    saveSetting("effectDurationMs", Number(fields.effectDurationMs.value));
  });
  fields.reduceMotion.addEventListener("change", () => saveSetting("reduceMotion", fields.reduceMotion.checked));
  fields.sound.addEventListener("change", () => saveSetting("sound", fields.sound.value));
  fields.pingShape.addEventListener("change", () => saveSetting("pingShape", fields.pingShape.value));
  fields.dnd.addEventListener("change", () => saveSetting("dnd", fields.dnd.checked));
  fields.darkMode.addEventListener("change", () => saveSetting("darkMode", fields.darkMode.checked));
  fields.chatSoundsEnabled.addEventListener("change", () =>
    saveSetting("chatSoundsEnabled", fields.chatSoundsEnabled.checked),
  );
  fields.chatSendSound.addEventListener("change", () => saveSetting("chatSendSound", fields.chatSendSound.value));
  fields.chatReceiveSound.addEventListener("change", () =>
    saveSetting("chatReceiveSound", fields.chatReceiveSound.value),
  );

  fields.avatarInput.addEventListener("change", async () => {
    const file = fields.avatarInput.files?.[0];
    if (!file || !profileCache) return;
    const raw = await fileToDataUrl(file);
    const resized = await resizeDataUrlImage(raw, 256, 0.82);
    await saveProfile({ ...profileCache, avatar: resized });
    fields.avatarInput.value = "";
  });

  fields.clearAvatar.addEventListener("click", async () => {
    if (!profileCache) return;
    await saveProfile({ ...profileCache, avatar: null });
  });

  fields.checkUpdates?.addEventListener("click", () => {
    checkForUpdates();
  });

  await listen("settings-updated", (event) => {
    const payload = event.payload || {};
    applyToInputs(payload);
    renderStatus({ settings: payload, profile: profileCache });
  });

  document.querySelector(".win-enter")?.classList.add("win-ready");
});

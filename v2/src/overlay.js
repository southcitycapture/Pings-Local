const { listen } = window.__TAURI__.event;
const { invoke } = window.__TAURI__.core;

let audioContext = null;
let resetTimer = null;
let cachedSettings = null;
let lastSettingsFetch = 0;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function hexToRgb(hex) {
  const normalized = String(hex || "").replace("#", "").trim();
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
    return "20, 184, 166";
  }
  const intValue = parseInt(normalized, 16);
  const r = (intValue >> 16) & 255;
  const g = (intValue >> 8) & 255;
  const b = intValue & 255;
  return `${r}, ${g}, ${b}`;
}

async function getOverlaySettings() {
  if (cachedSettings && Date.now() - lastSettingsFetch < 1500) {
    return cachedSettings;
  }
  try {
    cachedSettings = await invoke("get_settings");
    lastSettingsFetch = Date.now();
  } catch {
    cachedSettings = cachedSettings || {};
  }
  return cachedSettings;
}

function applyStyleFromSettings(settings) {
  const root = document.documentElement;
  const opacity = clamp(Number(settings?.effectOpacity ?? 0.9), 0.15, 1);
  const thickness = clamp(Number(settings?.borderThickness ?? 28), 4, 96);
  const feather = clamp(Number(settings?.effectFeather ?? 42), 6, 96);
  const duration = clamp(Number(settings?.effectDurationMs ?? 1150), 350, 4000);
  const reduceMotion = Boolean(settings?.reduceMotion);
  root.style.setProperty("--effect-rgb", hexToRgb(settings?.effectColor || "#14b8a6"));
  root.style.setProperty("--effect-opacity", String(opacity));
  root.style.setProperty("--border-thickness", `${thickness}px`);
  root.style.setProperty("--effect-feather", `${feather}px`);
  root.style.setProperty("--effect-duration", `${duration}ms`);
  root.style.setProperty("--effect-scale", reduceMotion ? "1.25" : "2.0");
  return duration;
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

async function trigger(payload) {
  const shape = payload?.shape === "border" ? "border" : "circle";
  const sound = payload?.sound || "light";
  const circle = document.getElementById("circle");
  const border = document.getElementById("border");
  if (!circle || !border) return;
  const settings = await getOverlaySettings();
  const duration = applyStyleFromSettings(settings);

  if (resetTimer) {
    clearTimeout(resetTimer);
    resetTimer = null;
  }

  circle.classList.remove("active");
  border.classList.remove("active");
  if (shape === "border") {
    border.classList.add("active");
  } else {
    circle.classList.add("active");
  }
  playSound(sound);

  resetTimer = setTimeout(() => {
    circle.classList.remove("active");
    border.classList.remove("active");
    resetTimer = null;
  }, duration + 50);
}

window.addEventListener("DOMContentLoaded", async () => {
  await listen("overlay-ping", (event) => {
    void trigger(event.payload || {});
  });
});

// Shared sound player. Still WebAudio tones for now — the plan swaps these for
// bundled samples in v3.2 — but centralized so every window plays the same set.

let audioContext = null;

function getAudioContext() {
  if (!audioContext) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) audioContext = new Ctx();
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

const TONES = {
  light: [980, "sine", 0.1, 0.14],
  bubble: [720, "sine", 0.11, 0.18],
  tap: [1350, "square", 0.05, 0.16],
  bell: [620, "triangle", 0.22, 0.2],
  drop: [340, "sine", 0.13, 0.2],
  chime: [1140, "sine", 0.14, 0.24],
};

export function playSound(rawSound) {
  const sound = String(rawSound || "light").toLowerCase();
  if (sound === "off") return;
  playTone(...(TONES[sound] || TONES.chime));
}

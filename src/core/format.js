// Formatting + identity helpers shared across every window. Previously these
// were copy-pasted into main.js, direct-chat.js and overlay.js; this is the one
// copy.

export function normalizeIp(value) {
  return String(value || "")
    .replace("::ffff:", "")
    .trim();
}

export function escapeHtml(text = "") {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

export function formatAgo(ts) {
  if (!ts) return "never";
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 10) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export function initials(nameOrIp) {
  const text = String(nameOrIp || "").trim();
  if (!text) return "?";
  // An IP or other dotted/numeric label has no useful initials — show the
  // first two digits/chars instead of "1." style noise.
  if (/^[\d.]+$/.test(text)) return text.replace(/\D/g, "").slice(0, 2) || "?";
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0] || ""}${parts[1][0] || ""}`.toUpperCase();
  }
  return text.slice(0, 2).toUpperCase();
}

// A stable key for a peer: identity first, address only as a fallback for
// legacy/subnet peers that never announced a peerId.
export function peerKey(peer) {
  const id = String(peer?.peerId || "").trim();
  if (id) return `id:${id}`;
  const ip = normalizeIp(peer?.ip || "");
  return ip ? `ip:${ip}` : "";
}

export function displayName(peer) {
  const name = String(peer?.name || "").trim();
  const ip = normalizeIp(peer?.ip || "");
  if (name && normalizeIp(name) !== ip) return name;
  return ip || name || "Unknown";
}

// A peer is "online" if we've heard from it recently, otherwise "away". The
// status publisher drops peers entirely after 15 minutes, so this only ever
// distinguishes fresh from fading.
export function presenceState(lastSeen, nowMs = Date.now()) {
  if (!lastSeen) return "away";
  return nowMs - lastSeen <= 120_000 ? "online" : "away";
}

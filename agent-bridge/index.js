// Pings reference agent bridge.
//
// Announces itself as a Pings peer with kind=agent, listens for private (1:1)
// messages, and answers each one with a local LLM (Ollama) — or a canned echo
// if no LLM is reachable. This is the whole contract from ../docs/PROTOCOL.md in
// ~150 lines; write your own agent in any language the same way.
//
// Run it on a machine *other* than the one running the Pings app (they'd both
// want UDP 43211). Config via env — see README.md.

import dgram from "node:dgram";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createWeekly } from "./weekly.js";

const CHAT_PORT = 43211;
const PING_PORT = 43210;
const NAME = process.env.PINGS_AGENT_NAME || "Hermes";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.2";
const FORCE_ECHO = process.env.PINGS_ECHO === "1";
const SYSTEM_PROMPT =
  process.env.PINGS_SYSTEM ||
  "You are a helpful teammate reachable over a local-network chat app called Pings. Keep replies short, friendly, and to the point.";

function loadPeerId() {
  const file = path.join(os.homedir(), ".pings-agent-id");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch {
    // not created yet
  }
  const id = crypto.randomUUID();
  try {
    fs.writeFileSync(file, id);
  } catch {
    // fall back to an ephemeral id if we can't persist
  }
  return id;
}

function localIpv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list || []) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return "127.0.0.1";
}

const PEER_ID = loadPeerId();
const LOCAL_IP = localIpv4();
const sock = dgram.createSocket("udp4");
const weekly = createWeekly();

// Peers we know about — from mDNS browsing and from whoever messages us.
// Identity is the peer id; the ip is just its latest known address.
const PEER_STALE_MS = 15 * 60 * 1000;
const peers = new Map(); // peerId -> { ip, name, kind, lastSeen, viaMdns }

function rememberPeer(id, ip, name, kind, viaMdns = false) {
  if (!id || id === PEER_ID) return;
  const prev = peers.get(id);
  peers.set(id, {
    ip: ip || prev?.ip,
    name: name || prev?.name || ip,
    kind: kind || prev?.kind || "human",
    lastSeen: Date.now(),
    viaMdns: viaMdns || prev?.viaMdns || false,
  });
}

function livePeers() {
  return [...peers.values()].filter(
    (p) => p.ip && (p.viaMdns || Date.now() - p.lastSeen < PEER_STALE_MS),
  );
}

function send(ip, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  sock.send(buf, CHAT_PORT, ip);
}

function sendAck(ip, id) {
  send(ip, {
    id,
    kind: "ack",
    from: NAME,
    fromIp: LOCAL_IP,
    fromPeerId: PEER_ID,
    toIp: ip,
    message: "",
    timestamp: Date.now(),
  });
}

function sendPrivate(ip, message) {
  send(ip, {
    id: crypto.randomUUID(),
    kind: "private",
    from: NAME,
    fromIp: LOCAL_IP,
    fromPeerId: PEER_ID,
    toIp: ip,
    message,
    timestamp: Date.now(),
  });
}

// Team broadcast: a copy to every known peer (protocol has no real multicast).
function sendTeam(message) {
  for (const p of livePeers()) {
    send(p.ip, {
      id: "",
      kind: "team",
      from: NAME,
      fromIp: LOCAL_IP,
      fromPeerId: PEER_ID,
      toIp: "",
      message,
      timestamp: Date.now(),
    });
  }
}

// Attention flash (udp/43210) to every human peer — reserved for rush events.
function sendFlash(message) {
  for (const p of livePeers()) {
    if (p.kind === "agent") continue;
    const buf = Buffer.from(
      JSON.stringify({
        from: NAME,
        fromIp: LOCAL_IP,
        fromPeerId: PEER_ID,
        message,
        sound: "bell",
        shape: "border",
        timestamp: Date.now(),
      }),
    );
    sock.send(buf, PING_PORT, p.ip);
  }
}

function echo(text) {
  return `🤖 (echo) You said: ${text}`;
}

async function reply(text) {
  if (FORCE_ECHO) return echo(text);
  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: text },
        ],
      }),
    });
    if (!res.ok) throw new Error(`ollama http ${res.status}`);
    const data = await res.json();
    const out = data?.message?.content?.trim();
    if (out) return out;
    throw new Error("empty response");
  } catch (err) {
    console.warn(`[agent] LLM unavailable (${err.message}); echoing instead`);
    return echo(text);
  }
}

sock.on("message", async (buf, rinfo) => {
  let msg;
  try {
    msg = JSON.parse(buf.toString());
  } catch {
    return; // not JSON we understand
  }
  // Never reply to ourselves (our own reply / ack echoes back on loopback).
  if (msg.fromPeerId && msg.fromPeerId === PEER_ID) return;

  // Presence heartbeat: ack it so the app keeps us in its buddy list during
  // quiet stretches. We don't browse for peers, so we can't heartbeat first —
  // we just ack whatever the app sends us.
  if (msg.kind === "heartbeat") {
    rememberPeer(msg.fromPeerId, rinfo.address, msg.from);
    send(rinfo.address, {
      id: "",
      kind: "heartbeat-ack",
      from: NAME,
      fromIp: LOCAL_IP,
      fromPeerId: PEER_ID,
      toIp: rinfo.address,
      message: "",
      timestamp: Date.now(),
    });
    return;
  }
  if (msg.kind === "heartbeat-ack") return;

  if (msg.kind !== "private" || !msg.message) return;

  const from = rinfo.address; // the datagram source is authoritative
  rememberPeer(msg.fromPeerId, from, msg.from);
  sendAck(from, msg.id);
  console.log(`[agent] <- ${msg.from || from}: ${msg.message}`);

  // Weekly commands (rush / status / note / …) take precedence over the LLM.
  if (weekly) {
    const handled = await weekly.handleMessage(msg.message, {
      senderKey: msg.fromPeerId || from,
      senderName: msg.from || from,
      listPeers: livePeers,
    });
    if (handled != null) {
      console.log(`[agent] -> ${from}: ${handled}`);
      sendPrivate(from, handled);
      return;
    }
  }

  const out = await reply(msg.message);
  console.log(`[agent] -> ${from}: ${out}`);
  sendPrivate(from, out);
});

sock.bind(CHAT_PORT, () => {
  console.log(`[agent] "${NAME}" (${PEER_ID}) listening on udp/${CHAT_PORT} at ${LOCAL_IP}`);
  console.log(`[agent] replies via ${FORCE_ECHO ? "echo" : `${OLLAMA_URL} (${OLLAMA_MODEL})`}`);
  if (weekly) {
    console.log(`[agent] Weekly connected: ${weekly.base} (say "help" for commands)`);
    weekly.startEvents({ broadcast: sendTeam, flash: sendFlash, log: console.log });
  } else {
    console.log(`[agent] Weekly not configured (set WEEKLY_URL + WEEKLY_AGENT_KEY to enable)`);
  }
});

// Advertise over mDNS so the agent shows up in the Pings buddy list with an AI
// badge, and browse the same service type to learn who else is out there (that
// peer table is what team broadcasts and rush flashes are addressed to).
// Optional — you can also be reached directly once someone messages you.
let bonjour = null;
try {
  const { Bonjour } = await import("bonjour-service");
  bonjour = new Bonjour();
  bonjour.publish({
    name: NAME,
    type: "pings",
    protocol: "tcp",
    port: 43210,
    txt: { name: NAME, id: PEER_ID, kind: "agent" },
  });
  console.log(`[agent] advertising _pings._tcp.local as "${NAME}" (kind=agent)`);

  const browser = bonjour.find({ type: "pings" });
  browser.on("up", (svc) => {
    const txt = svc.txt ?? {};
    const ip = (svc.addresses ?? []).find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
    rememberPeer(txt.id, ip, txt.name || svc.name, txt.kind, true);
  });
  browser.on("down", (svc) => {
    const id = svc.txt?.id;
    if (id) peers.delete(id);
  });
} catch (err) {
  console.warn(
    `[agent] mDNS advertising unavailable (${err.message}). The agent still ` +
      `works — message it directly, or add it by IP once that lands.`,
  );
}

process.on("SIGINT", () => {
  console.log("\n[agent] shutting down");
  try {
    bonjour?.destroy();
  } catch {
    // ignore
  }
  try {
    sock.close();
  } catch {
    // ignore
  }
  process.exit(0);
});

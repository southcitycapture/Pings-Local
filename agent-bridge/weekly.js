// Weekly connection for the Pings agent bridge.
//
// Gives the agent hands on the team's Weekly board (the workflow app): a set
// of deterministic chat commands over Weekly's Agent API, plus a poller for
// its /api/agent/events feed so board changes get announced on the LAN as
// team messages (and rush jobs can flash screens).
//
// Configure with WEEKLY_URL + WEEKLY_AGENT_KEY (a wk_live_ key from Weekly's
// Dashboard → Agent access). No key → createWeekly() returns null and the
// bridge behaves exactly as before. Zero dependencies — plain fetch.

import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const CURSOR_FILE = path.join(os.homedir(), ".pings-agent-weekly-cursor");
const CONFIRM_TTL_MS = 2 * 60 * 1000;

const HELP = [
  "Weekly commands:",
  "• rush — open rush items",
  "• today — items dated today",
  "• find <text> — search the boards",
  "• boards — list boards",
  "• board <name> — one board's status summary",
  "• status <item>: <label> — set an item's status (asks to confirm)",
  "• note <item>: <text> — leave a note on an item (asks to confirm)",
  "• add <board>: <item name> — add an item (asks to confirm)",
  "• who — who's on the Pings network",
  "Anything else goes to the model.",
].join("\n");

export function createWeekly() {
  const base = (process.env.WEEKLY_URL || "").replace(/\/+$/, "");
  const key = process.env.WEEKLY_AGENT_KEY || "";
  if (!base || !key) return null;

  const announce = (process.env.WEEKLY_ANNOUNCE || "important").toLowerCase(); // important | all | off
  const pollMs = Math.max(10, Number(process.env.WEEKLY_POLL_SECONDS) || 30) * 1000;
  const rushFlash = process.env.WEEKLY_RUSH_FLASH === "1";

  async function api(method, pathname, body) {
    const res = await fetch(`${base}/api/agent${pathname}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Weekly HTTP ${res.status}`);
    return data;
  }

  const listBoards = () => api("GET", "/boards");
  const getBoard = (id) => api("GET", `/boards/${encodeURIComponent(id)}`);
  const searchItems = (q, limit = 25) =>
    api("GET", `/items?q=${encodeURIComponent(q)}&limit=${limit}`);
  const setCell = (id, column, value) => api("PATCH", `/items/${encodeURIComponent(id)}`, { column, value });
  const addNote = (id, text) => api("POST", `/items/${encodeURIComponent(id)}`, { text });
  const addItem = (board, name) => api("POST", "/items", { board, name });
  const getEvents = (since, limit = 200) =>
    api("GET", `/events?limit=${limit}${since ? `&since=${encodeURIComponent(since)}` : ""}`);

  // ---- rendering helpers ----------------------------------------------------

  function itemLine(it) {
    const status = Object.entries(it.cells ?? {}).find(([k]) => /status/i.test(k))?.[1];
    return `• ${it.name} [${it.board}]${status ? ` — ${status}` : ""}`;
  }

  function itemList(items, none) {
    if (!items.length) return none;
    const lines = items.slice(0, 10).map(itemLine);
    if (items.length > 10) lines.push(`…and ${items.length - 10} more`);
    return lines.join("\n");
  }

  async function findBoard(name) {
    const { boards } = await listBoards();
    const wanted = name.trim().toLowerCase();
    return (
      boards.find((b) => b.name.toLowerCase() === wanted) ||
      boards.find((b) => b.name.toLowerCase().includes(wanted)) ||
      null
    );
  }

  /** Resolve an item by name fragment. Returns {item} | {ambiguous} | {}. */
  async function findItem(fragment) {
    const { items } = await searchItems(fragment, 10);
    if (!items.length) return {};
    const exact = items.filter((i) => i.name.toLowerCase() === fragment.trim().toLowerCase());
    if (exact.length === 1) return { item: exact[0] };
    if (items.length === 1) return { item: items[0] };
    return { ambiguous: items };
  }

  /** Name of the status-type column on the item's board (falls back to "Status"). */
  async function statusColumnFor(item) {
    try {
      const board = await findBoard(item.board);
      if (!board) return "Status";
      const flat = await getBoard(board.id);
      return flat.columns.find((c) => c.type === "status")?.name ?? "Status";
    } catch {
      return "Status";
    }
  }

  // ---- chat commands ---------------------------------------------------------

  // Pending write confirmations, keyed by sender (peer id or ip).
  const pending = new Map();

  function askToConfirm(senderKey, describe, run) {
    pending.set(senderKey, { run, expires: Date.now() + CONFIRM_TTL_MS });
    return `${describe} — reply "yes" to confirm or "no" to cancel.`;
  }

  /** Split "item<sep>rest" on the first ":" or "=", falling back to last " to ". */
  function splitTarget(text) {
    const m = text.match(/^(.+?)\s*[:=]\s*(.+)$/);
    if (m) return [m[1].trim(), m[2].trim()];
    const i = text.toLowerCase().lastIndexOf(" to ");
    if (i > 0) return [text.slice(0, i).trim(), text.slice(i + 4).trim()];
    return [text.trim(), ""];
  }

  /**
   * Handle one incoming private message. Returns the reply string when this was
   * a Weekly command (or a confirmation), or null to fall through to the LLM.
   */
  async function handleMessage(text, ctx) {
    const t = text.trim();
    const lower = t.toLowerCase();

    // Outstanding confirmation?
    const p = pending.get(ctx.senderKey);
    if (p && Date.now() > p.expires) pending.delete(ctx.senderKey);
    if (pending.has(ctx.senderKey)) {
      if (["yes", "y", "confirm", "ok"].includes(lower)) {
        pending.delete(ctx.senderKey);
        try {
          return await p.run();
        } catch (err) {
          return `Weekly said no: ${err.message}`;
        }
      }
      if (["no", "n", "cancel", "stop"].includes(lower)) {
        pending.delete(ctx.senderKey);
        return "Cancelled — nothing changed.";
      }
      // Any other message drops the pending action and is handled normally.
      pending.delete(ctx.senderKey);
    }

    try {
      if (lower === "help" || lower === "commands") return HELP;

      if (lower === "who") {
        const peers = ctx.listPeers();
        if (!peers.length) return "I haven't seen anyone on the network yet.";
        return (
          "On the network:\n" +
          peers.map((p) => `• ${p.name}${p.kind === "agent" ? " 🤖" : ""}`).join("\n")
        );
      }

      if (lower === "rush") {
        const { items } = await searchItems("rush", 25);
        return itemList(items, "No rush items right now. 🎉");
      }

      if (lower === "today") {
        const iso = new Date().toISOString().slice(0, 10);
        const { items } = await searchItems(iso, 25);
        return itemList(items, "Nothing on the board dated today.");
      }

      if (lower === "boards") {
        const { boards } = await listBoards();
        if (!boards.length) return "No boards in this workspace.";
        return "Boards:\n" + boards.map((b) => `• ${b.name}`).join("\n");
      }

      const boardCmd = t.match(/^board\s+(.+)$/i);
      if (boardCmd) {
        const board = await findBoard(boardCmd[1]);
        if (!board) return `No board matching "${boardCmd[1]}".`;
        const flat = await getBoard(board.id);
        const lines = [`${flat.board.name} — ${flat.item_count} item(s)`];
        for (const [col, counts] of Object.entries(flat.status_summary ?? {})) {
          const parts = Object.entries(counts).map(([label, n]) => `${label} ${n}`);
          lines.push(`${col}: ${parts.join(" · ")}`);
        }
        return lines.join("\n");
      }

      const findCmd = t.match(/^(?:find|search)\s+(.+)$/i);
      if (findCmd) {
        const { items } = await searchItems(findCmd[1], 25);
        return itemList(items, `Nothing matching "${findCmd[1]}".`);
      }

      const addCmd = t.match(/^add\s+(.+)$/i);
      if (addCmd) {
        const [boardName, name] = splitTarget(addCmd[1]);
        if (!name) return 'Use: add <board>: <item name>';
        const board = await findBoard(boardName);
        if (!board) return `No board matching "${boardName}".`;
        return askToConfirm(ctx.senderKey, `Add "${name}" to ${board.name}?`, async () => {
          const { item } = await addItem(board.id, name);
          return `Done — added "${item.name}" to ${item.board} (${item.group}).`;
        });
      }

      const statusCmd = t.match(/^status\s+(.+)$/i);
      if (statusCmd) {
        const [fragment, label] = splitTarget(statusCmd[1]);
        if (!label) return 'Use: status <item>: <label> (e.g. status 123 Main: Delivered)';
        const found = await findItem(fragment);
        if (found.ambiguous)
          return `Which one?\n${itemList(found.ambiguous, "")}\nSay it again with the full name.`;
        if (!found.item) return `Couldn't find an item matching "${fragment}".`;
        const column = await statusColumnFor(found.item);
        return askToConfirm(
          ctx.senderKey,
          `Set ${column} to "${label}" on "${found.item.name}" [${found.item.board}]?`,
          async () => {
            const r = await setCell(found.item.id, column, label);
            return `Done — ${r.column} is now "${r.value}" on "${r.item}".`;
          },
        );
      }

      const noteCmd = t.match(/^note\s+(.+)$/i);
      if (noteCmd) {
        const [fragment, note] = splitTarget(noteCmd[1]);
        if (!note) return 'Use: note <item>: <text>';
        const found = await findItem(fragment);
        if (found.ambiguous)
          return `Which one?\n${itemList(found.ambiguous, "")}\nSay it again with the full name.`;
        if (!found.item) return `Couldn't find an item matching "${fragment}".`;
        return askToConfirm(
          ctx.senderKey,
          `Leave a note on "${found.item.name}" [${found.item.board}]: "${note}"?`,
          async () => {
            await addNote(found.item.id, `via Pings — ${ctx.senderName}: ${note}`);
            return `Done — note left on "${found.item.name}".`;
          },
        );
      }
    } catch (err) {
      return `Weekly said no: ${err.message}`;
    }

    return null; // not a Weekly command — let the LLM have it
  }

  // ---- event feed → LAN announcements ---------------------------------------

  function loadCursor() {
    try {
      return fs.readFileSync(CURSOR_FILE, "utf8").trim() || null;
    } catch {
      return null;
    }
  }

  function saveCursor(cursor) {
    if (!cursor) return;
    try {
      fs.writeFileSync(CURSOR_FILE, cursor);
    } catch {
      // ephemeral cursor is survivable — worst case we re-drain on restart
    }
  }

  const isRush = (e) => /rush/i.test(`${e.item ?? ""} ${e.summary}`);

  function interesting(e) {
    if (announce === "off") return false;
    if (announce === "all") return true;
    if (isRush(e)) return true;
    if (e.type === "item_created") return true;
    if (e.type === "value_changed" && /\bstatus\b/i.test(e.summary)) return true;
    return false;
  }

  function fmt(e) {
    const who = e.actor || "Someone";
    const on = e.item && !e.summary.includes(e.item) ? ` on "${e.item}"` : "";
    const board = e.board ? ` [${e.board}]` : "";
    return `${isRush(e) ? "🚨" : "📋"} Weekly${board}: ${who} ${e.summary}${on}`;
  }

  /**
   * Start polling the event feed. On the first ever run (no saved cursor) the
   * backlog is drained silently so a fresh install doesn't replay history at
   * the whole office. `broadcast(text)` sends a team message; `flash(text)`
   * sends an attention ping to human peers.
   */
  function startEvents({ broadcast, flash, log }) {
    let cursor = loadCursor();
    let busy = false;

    async function drainBacklog() {
      for (;;) {
        const { count, cursor: next } = await getEvents(cursor, 200);
        if (next) cursor = next;
        if (count < 200) break;
      }
      saveCursor(cursor);
      log(`[weekly] event cursor primed (${cursor ?? "empty feed"})`);
    }

    async function poll() {
      if (busy) return;
      busy = true;
      try {
        if (!cursor) {
          await drainBacklog();
          return;
        }
        const { events, cursor: next } = await getEvents(cursor, 200);
        if (next && next !== cursor) {
          cursor = next;
          saveCursor(cursor);
        }
        const worth = events.filter(interesting);
        if (worth.length) {
          const lines = worth.map(fmt);
          if (lines.length > 4) {
            broadcast(
              `📋 Weekly — ${lines.length} updates:\n` +
                lines.slice(0, 8).join("\n") +
                (lines.length > 8 ? `\n…and ${lines.length - 8} more` : ""),
            );
          } else {
            for (const line of lines) broadcast(line);
          }
          const rush = worth.find(isRush);
          if (rush && rushFlash) flash(`RUSH: ${rush.item ?? rush.summary}`);
        }
      } catch (err) {
        log(`[weekly] event poll failed: ${err.message}`);
      } finally {
        busy = false;
      }
    }

    poll();
    setInterval(poll, pollMs);
    log(
      `[weekly] watching ${base} for board events every ${pollMs / 1000}s ` +
        `(announce=${announce}${rushFlash ? ", rush flash on" : ""})`,
    );
  }

  return { base, handleMessage, startEvents };
}

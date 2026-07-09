//! Durable activity history.
//!
//! v2 shipped `history.json`, a `HistoryEntry` type, and `get_history` /
//! `clear_history` commands — but nothing ever wrote a record, so every ping
//! and message vanished on restart. This backs that surface with SQLite so
//! activity actually survives, and the redesigned activity drawer / DM windows
//! can load from it.
//!
//! Connections are opened per call. SQLite is a local file and event volume is
//! human-paced (a handful of pings), so the open cost is irrelevant; WAL mode
//! plus a busy timeout keeps the listener threads and command handlers from
//! stepping on each other.

use rusqlite::{params, Connection};
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// A single recorded ping or chat message.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEvent {
    /// One of: `ping`, `chat`, `team-chat`.
    pub kind: String,
    /// `in` for received, `out` for sent.
    pub direction: String,
    pub peer_id: String,
    pub peer_ip: String,
    pub peer_name: String,
    pub message: String,
    pub timestamp: u64,
}

impl HistoryEvent {
    pub fn new(
        kind: impl Into<String>,
        direction: impl Into<String>,
        peer_id: impl Into<String>,
        peer_ip: impl Into<String>,
        peer_name: impl Into<String>,
        message: impl Into<String>,
        timestamp: u64,
    ) -> Self {
        Self {
            kind: kind.into(),
            direction: direction.into(),
            peer_id: peer_id.into(),
            peer_ip: peer_ip.into(),
            peer_name: peer_name.into(),
            message: message.into(),
            timestamp,
        }
    }
}

fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("failed to create app data dir: {e}"))?;
    Ok(dir.join("history.db"))
}

fn init(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA busy_timeout = 3000;
         CREATE TABLE IF NOT EXISTS events (
             id         INTEGER PRIMARY KEY AUTOINCREMENT,
             kind       TEXT    NOT NULL,
             direction  TEXT    NOT NULL,
             peer_id    TEXT    NOT NULL DEFAULT '',
             peer_ip    TEXT    NOT NULL DEFAULT '',
             peer_name  TEXT    NOT NULL DEFAULT '',
             message    TEXT    NOT NULL DEFAULT '',
             ts         INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_events_peer_ts ON events (peer_id, ts);
         CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts);",
    )
}

fn open(app: &AppHandle) -> Result<Connection, String> {
    let conn = Connection::open(db_path(app)?).map_err(|e| format!("history-open:{e}"))?;
    init(&conn).map_err(|e| format!("history-migrate:{e}"))?;
    Ok(conn)
}

fn insert(conn: &Connection, event: &HistoryEvent) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO events (kind, direction, peer_id, peer_ip, peer_name, message, ts)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            event.kind,
            event.direction,
            event.peer_id,
            event.peer_ip,
            event.peer_name,
            event.message,
            event.timestamp as i64,
        ],
    )?;
    Ok(())
}

/// Read the most recent `limit` events, returned oldest-first so a timeline can
/// append them in order.
fn select(conn: &Connection, limit: u32) -> rusqlite::Result<Vec<HistoryEvent>> {
    let mut stmt = conn.prepare(
        "SELECT kind, direction, peer_id, peer_ip, peer_name, message, ts
         FROM events ORDER BY ts DESC, id DESC LIMIT ?1",
    )?;
    let mut events = stmt
        .query_map(params![limit], |row| {
            Ok(HistoryEvent {
                kind: row.get(0)?,
                direction: row.get(1)?,
                peer_id: row.get(2)?,
                peer_ip: row.get(3)?,
                peer_name: row.get(4)?,
                message: row.get(5)?,
                timestamp: row.get::<_, i64>(6)? as u64,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    events.reverse();
    Ok(events)
}

/// Persist one event. Failures are returned to the caller, which logs rather
/// than aborts — a dropped history row must never break message delivery.
pub fn record(app: &AppHandle, event: &HistoryEvent) -> Result<(), String> {
    let conn = open(app)?;
    insert(&conn, event).map_err(|e| format!("history-insert:{e}"))
}

pub fn history(app: &AppHandle, limit: u32) -> Result<Vec<HistoryEvent>, String> {
    let conn = open(app)?;
    select(&conn, limit).map_err(|e| format!("history-query:{e}"))
}

pub fn clear(app: &AppHandle) -> Result<(), String> {
    let conn = open(app)?;
    conn.execute("DELETE FROM events", [])
        .map_err(|e| format!("history-clear:{e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(kind: &str, dir: &str, msg: &str, ts: u64) -> HistoryEvent {
        HistoryEvent::new(kind, dir, "peer-1", "10.0.1.5", "Marcus", msg, ts)
    }

    #[test]
    fn records_and_reads_back_oldest_first() {
        let conn = Connection::open_in_memory().unwrap();
        init(&conn).unwrap();

        // Inserted out of chronological order on purpose.
        insert(&conn, &ev("chat", "out", "second", 2000)).unwrap();
        insert(&conn, &ev("ping", "in", "first", 1000)).unwrap();
        insert(&conn, &ev("team-chat", "out", "third", 3000)).unwrap();

        let all = select(&conn, 200).unwrap();
        let messages: Vec<_> = all.iter().map(|e| e.message.as_str()).collect();
        assert_eq!(messages, ["first", "second", "third"], "returned oldest-first");

        // limit keeps the newest N, still oldest-first within the window.
        let recent = select(&conn, 2).unwrap();
        let recent_msgs: Vec<_> = recent.iter().map(|e| e.message.as_str()).collect();
        assert_eq!(recent_msgs, ["second", "third"]);
    }

    #[test]
    fn clear_empties_the_table() {
        let conn = Connection::open_in_memory().unwrap();
        init(&conn).unwrap();
        insert(&conn, &ev("ping", "in", "x", 1)).unwrap();
        conn.execute("DELETE FROM events", []).unwrap();
        assert!(select(&conn, 200).unwrap().is_empty());
    }
}

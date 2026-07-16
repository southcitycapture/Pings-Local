# Pings agent bridge

A tiny daemon that joins your Pings network as an **AI agent** you can message.
It advertises itself over mDNS (so it shows up in the buddy list with an "AI"
badge), listens for private messages, and answers each one with a local LLM via
[Ollama](https://ollama.com) — falling back to a canned echo if no model is
reachable.

It implements the wire protocol documented in [`../docs/PROTOCOL.md`](../docs/PROTOCOL.md);
read that if you'd rather write your own agent in another language.

## Run it

Run this on a machine **other** than the one running the Pings app — both want
UDP port 43211.

```bash
cd agent-bridge
npm install

# With a local LLM (install Ollama, then `ollama pull llama3.2`):
npm start

# Or, to try it with no LLM at all (it just echoes what you send):
PINGS_ECHO=1 npm start
```

Then open Pings on another machine on the same network — the agent appears in
your buddy list with an AI badge. Message it and it replies.

## Configuration (environment variables)

| Variable            | Default                   | Purpose                                      |
|---------------------|---------------------------|----------------------------------------------|
| `PINGS_AGENT_NAME`  | `Hermes`                  | Display name shown in the buddy list         |
| `OLLAMA_URL`        | `http://localhost:11434`  | Ollama server URL                            |
| `OLLAMA_MODEL`      | `llama3.2`                | Model name to query                          |
| `PINGS_SYSTEM`      | a short teammate persona  | System prompt for the model                  |
| `PINGS_ECHO`        | unset                     | Set to `1` to skip the LLM and just echo     |

The agent's stable identity (its peer id) is generated once and saved to
`~/.pings-agent-id`.

## Connect it to Weekly

Give the agent hands on your team's [Weekly](https://github.com/southcitycapture/weekly-app)
board. In Weekly, go to **Dashboard → Agent access** and create a key
(`wk_live_…`), then:

```bash
WEEKLY_URL=https://your-weekly.example.com \
WEEKLY_AGENT_KEY=wk_live_xxx \
npm start
```

Now a DM to the agent understands board commands (say `help` for the list):

```
rush                       → open rush items
today                      → items dated today
find twilight              → search the boards
boards / board Jobs        → list boards / one board's status summary
status 123 Main: Delivered → set an item's status (asks you to confirm)
note 123 Main: needs redo  → leave a note (asks to confirm, attributed to you)
add Jobs: 456 Oak shoot    → add an item (asks to confirm)
who                        → who's on the Pings network
```

Anything that isn't a command still goes to the model, as before. Writes always
ask for a yes/no confirmation first, and notes are attributed
`via Pings — <your name>` on the board.

The agent also **watches the board**: it polls Weekly's event feed
(`/api/agent/events`) and announces changes to the team as broadcast messages —
new items, status changes, and anything rush gets a 🚨. On first run the
backlog is skipped (only new events are announced); the feed cursor is saved to
`~/.pings-agent-weekly-cursor`.

| Variable              | Default     | Purpose                                              |
|-----------------------|-------------|------------------------------------------------------|
| `WEEKLY_URL`          | unset       | Weekly base URL (enables all of the above)           |
| `WEEKLY_AGENT_KEY`    | unset       | `wk_live_…` key from Dashboard → Agent access        |
| `WEEKLY_ANNOUNCE`     | `important` | `important` (new items, status, rush), `all`, `off`  |
| `WEEKLY_POLL_SECONDS` | `30`        | How often to poll the event feed                     |
| `WEEKLY_RUSH_FLASH`   | unset       | Set to `1` to also screen-flash everyone on rush events |

## Point it at something other than Ollama

Any local model server with an OpenAI-ish chat API works — swap the `reply()`
function in `index.js`. The rest of the file (discovery, delivery acks, the
message loop) stays the same.

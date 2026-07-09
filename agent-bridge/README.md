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

## Point it at something other than Ollama

Any local model server with an OpenAI-ish chat API works — swap the `reply()`
function in `index.js`. The rest of the file (discovery, delivery acks, the
message loop) stays the same.

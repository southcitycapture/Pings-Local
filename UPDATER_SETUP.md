# Pings v2 Local Updater (Fast Testing)

This is a local-network testing updater flow. It is intentionally simple.

## One-time setup status (already done)
- In-app button is wired in Options: `Check for Updates`.
- Updater plugin is enabled.
- Config points to local HTTP endpoints:
  - `http://ZachBook-Pro.local:8123/latest.json`
  - `http://localhost:8123/latest.json`
- HTTP updater is allowed for testing (`dangerousInsecureTransportProtocol: true`).

## Per-release workflow (quick)
1. Build app update bundles:
   - `npm run build:mac:arm64`
   - `npm run build:mac:x64`
2. Prepare local updater artifacts and `latest.json`:
   - `npm run updates:prepare`
3. Start local update server:
   - `npm run updates:serve`
4. On test machines, open Pings -> Options -> `Check for Updates`.

## What `updates:prepare` does
- Copies built updater bundles into update directory.
- Writes `latest.json` with the correct signatures and URLs.
- Default output directory:
  - `/Volumes/ModelX/Apps/Pings-v2/artifacts`

## What `updates:serve` does
- Serves files from update directory on port `8123`.
- Endpoints:
  - `http://localhost:8123/latest.json`
  - `http://<your-hostname>.local:8123/latest.json`

## Required env vars during build
Build commands need signing env vars so `.sig` files are generated:

```bash
export PATH="/opt/homebrew/opt/rustup/bin:$PATH"
export TAURI_SIGNING_PRIVATE_KEY="$(cat src-tauri/tauri-update.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
```

## Optional overrides
- `PINGS_UPDATE_DIR` to change where updater files are written/served.
- `PINGS_UPDATE_BASE_URL` to force URL generation in `latest.json`.
- `PINGS_UPDATE_PORT` and `PINGS_UPDATE_HOST` for server binding.

## Security note
This local updater config uses plain HTTP for LAN testing only.
Do not use this mode for production distribution.

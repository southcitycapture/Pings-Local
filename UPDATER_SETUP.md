# Pings updater & release

Pings ships a signed, HTTPS auto-updater. The app checks GitHub Releases for a
newer signed build and installs it in place.

## How it's wired

- **Endpoint** (`src-tauri/tauri.conf.json` → `plugins.updater.endpoints`):
  `https://github.com/southcitycapture/Pings-Local/releases/latest/download/latest.json`
  Every release publishes a `latest.json` as a release asset; the app fetches
  the latest one over HTTPS. No `dangerousInsecureTransportProtocol`, no
  dev-machine hostnames.
- **Signature** (`plugins.updater.pubkey`): update bundles are verified against
  this minisign public key before installing. The matching **private** key
  (`src-tauri/tauri-update.key`, git-ignored) is only used at build time.
- **In-app**: Options → `Check for Updates`.

## Releasing (CI — the real path)

Releases are built and published by GitHub Actions
(`.github/workflows/release.yml`) on a version tag:

1. Bump the version in **both** `package.json` and
   `src-tauri/tauri.conf.json` (they must match the tag, e.g. `0.2.0`).
2. Commit, then push a matching tag:
   ```bash
   git tag v0.2.0 && git push origin v0.2.0
   ```
3. The workflow builds a **universal** macOS app, signs the updater artifacts,
   and creates a **draft** GitHub Release with the `.dmg`, the signed update
   bundle, and `latest.json`.
4. Review the draft release and publish it. Existing installs will then see the
   update via `Check for Updates`.

### Required repository secrets

Set these in GitHub → Settings → Secrets and variables → Actions:

| Secret | Value |
|--------|-------|
| `TAURI_SIGNING_PRIVATE_KEY` | contents of `src-tauri/tauri-update.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the key's password (`""` if none) |

`GITHUB_TOKEN` is provided automatically.

## Not yet wired

- **Apple Developer ID signing + notarization.** Until an Apple account exists,
  the `.app` is ad-hoc signed and Gatekeeper warns on first launch
  (right-click → Open, or `xattr -dr com.apple.quarantine Pings.app`). When an
  account is available, add `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`,
  `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID`
  secrets — `tauri-action` will sign and notarize automatically. That's why the
  release is created as a draft for now.
- **Linux/Windows targets.** The workflow is macOS-only; add runners to the job
  matrix when those platforms are in scope.

---

## Appendix: local LAN updater (dev testing only)

For iterating on the update flow over the LAN without cutting a release, there
are helper scripts (`npm run updates:prepare`, `npm run updates:serve`) that
serve `latest.json` over plain HTTP on port 8123. **This is dev-only** — it
needs the production `endpoints`/`dangerousInsecureTransportProtocol` config
temporarily pointed back at `http://localhost:8123`, and must never ship. Build
with the signing env vars so `.sig` files are produced:

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat src-tauri/tauri-update.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
npm run build:mac:arm64        # and/or build:mac:x64
npm run updates:prepare        # copies bundles + writes latest.json
npm run updates:serve          # serves on :8123
```

Overrides: `PINGS_UPDATE_DIR`, `PINGS_UPDATE_BASE_URL`, `PINGS_UPDATE_PORT`,
`PINGS_UPDATE_HOST`.

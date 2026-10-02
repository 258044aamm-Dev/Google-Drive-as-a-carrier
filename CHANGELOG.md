# Changelog

All notable changes to this fork of [YAOS](https://github.com/kavinsood/yaos) (plugin id `yaos`). The fork starts from upstream **2.1.1** and adds one optional thing: a **Google Drive carrier**, so a vault can sync through a folder in your own Google Drive instead of a Cloudflare Worker. Cloudflare stays the default and behaves as before; nothing changes unless you choose Google Drive.

Releases: https://github.com/258044aamm-Dev/Google-Drive-as-a-carrier/releases

Version numbers like `2.1.1-drive.3` exist only in each release's `manifest.json`. The repository itself still says `2.1.1`.

This file is specific to this fork. It is not part of upstream YAOS.

## 2.1.1-drive.4 - 2026-10-02

### Added
- **Google Drive setup wizard** for people who have never set up anything like this. It opens when you choose Google Drive for the first time, from a **Set up Google Drive** button in the Google Drive section, and from the command **YAOS: Set up Google Drive**. Two paths: *Start a new vault* and *Join my existing vault*.
  - Guides you through Google Cloud step by step (project, Drive API, consent screen, client of type "TVs and Limited Input devices", Publish app) with a button for each Google page, then pastes and checks the client details.
  - Signs in with Google by itself (code shown in the wizard), then asks about encryption (on by default, with a clear warning that a lost passphrase cannot be recovered).
  - Creates the vault only after a test: it makes, reads and deletes a small file in the new `YAOS <vault id>` folder, then writes `meta.json`. Settings are saved at the very end; cancelling earlier changes nothing.
  - Ends with a **setup code** (`YAOS-DRIVE1:...`) for the second device. It holds the vault ID, the client details and optionally the passphrase, never the sign-in token. The wizard warns to keep it private.
  - Joining checks the vault first: not found, wrong or missing passphrase, a passphrase for an unencrypted vault, or a different layout are each explained, and nothing is saved until the check passes.
  - A device that is already set up gets a warning before it makes a new vault.
  - Syncing starts straight away after setup when nothing was running (otherwise a Reload button is shown).
  - The built-in shared Google client is **not included yet** (placeholder is empty), so this build offers the "own client" path only.
- Tests: `drive-carrier-wizard-code` (50 checks) and `drive-carrier-wizard-flow` (132 checks) plus 10 new checks in `drive-carrier-settings`, all against the fake Drive.

### Changed
- The Drive group's Status row, when signed out, says to press "Set up Google Drive". The older manual rows still work.
- The notice shown when Google Drive is chosen but not set up points to the wizard.

### Notes
- Cloudflare users see no difference: the wizard is only reachable once Google Drive is chosen, and the new row appears only in the Google Drive section.
- Not tested against real Google yet: the wording of Google Cloud's console may differ from the guide.

## 2.1.1-drive.3 - 2026-10-02

### Changed
- **The "Sync carrier (experimental)" choice is now in Settings > YAOS > Setup**, directly above "Deploy your server". Before, it was the first row under Advanced and easy to miss. Once a Cloudflare server is set up, the row stays as the first row under Advanced. With Google Drive chosen, it is at the top of the Google Drive section so you can switch back.
- **Choosing Google Drive hides everything that belongs to Cloudflare:** "Setup required", "Deploy your server", Server, Sync token, "Pair another device", "Back up connection details", the Updates section, "Refresh attachment capability", "Set up attachment storage", the deployment repository rows in Advanced, and the server wording in the "Reload required" hint. The screen refreshes as soon as you pick the carrier.
- Docs now say where to find the choice (README, `docs/drive-carrier.md`, the device checklist).

### Notes
- After copying the files, restart Obsidian completely. The plugin list shows the version from `manifest.json`, even if an older `main.js` is still loaded.
- `2.1.1-drive.2` was on GitHub for a few minutes with an older layout (carrier row below "Deploy your server"). It was withdrawn; `drive.3` replaces it.
- For a Cloudflare user the only visible difference from upstream is that one extra dropdown row. The original upstream test suites still pass against this code (95 passed; the one failure needs `miniflare`, which was not installed here, and fails the same way on untouched upstream).

## 2.1.1-drive.1 - 2026-10-02

First test build with the Google Drive carrier. Meant for real-device testing in a scratch vault. Everything so far was tested against a fake Drive only.

### Added
- **Google Drive as a sync carrier (optional, off by default).** Devices exchange the same updates the YAOS engine already produces, as small files in a Drive folder named `YAOS <vault id>`. Updates are written once and never edited, and are compacted into snapshots from time to time. Every file carries a SHA-256 check, and a damaged file is skipped. Devices poll Drive, so a change arrives in a few seconds rather than instantly.
- **Sign in with Google** using the device-code flow (enter a short code at google.com/device) with the narrow `drive.file` scope, so YAOS only sees files it created. You use your own Google OAuth client ("TVs and limited-input devices"); there is no relay and no server of ours.
- **Attachments on Drive** (folder `YAOS <vault id> blobs`, named by their SHA-256), with the same size and parallel-transfer settings as before.
- **Snapshots and restore points on Drive** (folder `YAOS <vault id> snapshots`): a daily snapshot, "snapshot now", list, compare and restore, and pruning that keeps pinned snapshots plus the newest 14.
- **Optional passphrase encryption** of everything stored on Drive (AES-256-GCM, key derived with PBKDF2 and HKDF). It can only be chosen when a vault is first created on Drive. A lost passphrase cannot be recovered. A missing or wrong passphrase stops sync with a notice and writes nothing.
- **Adaptive polling to save requests and battery:** every 3 seconds while you are using the app, every 30 seconds after a minute of inactivity, every 2 minutes with the window hidden on a desktop, and paused while hidden on a phone, with an immediate check when the app comes back or the network returns. About 38 requests in 10 idle minutes instead of 200.
- "Saved to Drive" status, so the usual "sent to the server" indicators keep working.
- Settings: a **Sync carrier** choice, a Google Drive section (folder, vault ID, client ID and secret, passphrase, sign in and sign out).
- Docs: `docs/drive-carrier.md`, a real-device checklist (`docs/drive-carrier-device-checklist.md`), a README section and notes in the architecture and sync-contract docs.

### Changed
- **Inside the sync engine, the carrier now sits behind a small `SyncTransport` interface** (`src/sync/transport.ts`). The Cloudflare provider is the default and is built exactly as before. Attachments and snapshots likewise go through two small optional interfaces, with the Worker code as the default. Users of Cloudflare see no difference.
- Two existing test fixtures use a different placeholder field (`wsconnected: false` instead of `roomname`) because the provider type is now narrower. No assertion changed.

### Known limits
- Polling only: changes arrive in a few seconds, and there are no live cursors from other devices.
- A second device must type the same Vault ID by hand. The Cloudflare pairing link and recovery kit do not apply.
- Reload the plugin after signing in or changing the passphrase.
- Encryption can only be turned on when the vault is created on Drive.
- A damaged attachment on Drive is not repaired automatically; deleted-file markers are not cleaned up yet.
- Google may expire sign-in tokens after 7 days for an OAuth client left in "Testing" mode. Publish the client.
- The passphrase is stored in plain text in the plugin's data file.
- Real Google Drive, quotas and phone background behaviour are not yet verified.

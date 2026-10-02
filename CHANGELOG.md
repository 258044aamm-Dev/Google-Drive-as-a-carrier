# Changelog

All notable changes to this fork of [YAOS](https://github.com/kavinsood/yaos) (plugin id `yaos`). The fork starts from upstream **2.1.1** and adds one optional thing: a **Google Drive carrier**, so a vault can sync through a folder in your own Google Drive instead of a Cloudflare Worker. Cloudflare stays the default and behaves as before; nothing changes unless you choose Google Drive.

Releases: https://github.com/258044aamm-Dev/Google-Drive-as-a-carrier/releases

Version numbers like `2.1.1-drive.3` exist only in each release's `manifest.json`. The repository itself still says `2.1.1`.

This file is specific to this fork. It is not part of upstream YAOS.

## Unreleased - 2.1.1-drive.11 (committed locally, not published)

### Fixed (snapshots; server and Google Drive)
- **Snapshot lists said "0 notes".** The note count of a snapshot was read from `pathToId`, a map that current vaults no longer fill. A vault with thousands of notes showed `markdownFileCount: 0` (upstream issue #78 reported it for the Cloudflare server). The count now comes from the active entries of `meta`; documents without a schema version or with schema v1 keep the old count. Same fix in the Google Drive snapshot backend, which had copied the bug. Only the number in the snapshot list changes; snapshot content and restore are untouched.
  - Code: new `server/src/activeFiles.ts`; `server/src/snapshot.ts`; `src/drive-carrier/driveSnapshotBackend.ts`; `isTombstone` is now exported from `server/src/tombstoneReaper.ts` (no behaviour change).

### Added (server diagnostics)
- **The tombstone reaper's trace now explains an idle pass.** Two new fields, `oldestTombstoneAgeMs` and `nextEligibleAt`, say how old the oldest deleted note is and when the first one becomes eligible. A report like "reaped: 0, every tombstone within the grace window" (upstream issue #78) can now be told from a real fault: if even the oldest is younger than 30 days, nothing is wrong. Nothing is reaped differently.

### Tests
- `tombstone-reaper` gains Test 17 for the two new fields. New `active-files-count` (6 checks, one fails without the change); `drive-carrier-snapshots` gains a current-model check (fails without the change).

## Unreleased - 2.1.1-drive.10 (committed locally, not published)

### Fixed (engine, every carrier including Cloudflare)
- **Engine step 3 (upstream SYNC-02): an edit on one side of an open note is no longer discarded without a trace.** When an open (editor-bound) note had changed on BOTH sides since the last synced text, one side was overwritten silently: the editor/disk text over the shared document ("local only" branch), or an external disk edit over it ("idle" branch). With the remembered baseline hash it is now known when both sides differ from the baseline and from each other; then the side about to be overwritten is first kept as a `(YAOS conflict - crdt ...)` note. Which side wins is unchanged. Normal typing lag (the document still at the baseline), a missing baseline, equal texts and repeated events make no copy (same cap and dedupe as the existing conflict notes).
  - Code: `src/runtime/reconcile/boundDivergencePolicy.ts`; `ReconciliationController.preserveCrdtIfBothSidesChanged` called before the two overwrites.
  - Found but NOT changed: if an open note's disk file lags behind a remote edit and still equals the old baseline, the "idle" branch can write that old text back over the shared document unless the user typed recently. That needs the real editor to judge, so it is only recorded here.

### Tests
- New `engine-bound-both-changed` (13 checks): the policy, both branches, the ordinary cases (no copy), no baseline, a repeated event. Three fail without the change.

## Unreleased - 2.1.1-drive.9 (committed locally, not published)

### Fixed (engine, every carrier including Cloudflare)
- **Engine step 2 (upstream SYNC-01): a note you deleted while YAOS was off, or before the first sync finished, no longer comes back.** At the next full reconcile a note that is in the shared document but missing on disk was always written back. Now one content rule decides: the device remembers a hash of the text it last had in sync (the disk index). If that hash still equals the document's text, nothing changed since the file was there, so its absence is a delete made on this device; it is recorded as deleted and the other devices follow. Everything else is as before and the note is written back: no remembered hash (a note this device never had), the document text changed meanwhile (someone edited it, so the edit is not lost), an ignored path, or a file the file system still has.
  - A brake keeps a vault that looks emptied (the file list not loaded) from being mass-deleted: more than 20 notes and more than 25 % of tracked notes, or several notes with no markdown file found at all, are written back instead and the block is traced (`reconcile-offline-delete-blocked`).
  - Only in full (authoritative) reconciles. Code: new `src/runtime/reconcile/offlineDeletePolicy.ts`; `ReconciliationController` calls it before writing the "missing on disk" notes.
  - Not covered: a delete whose event was lost after a reconcile already dropped the file's remembered hash, and notes edited on this device and never re-synced to a settled hash; both are written back as before.

### Tests
- New `engine-offline-delete` (24 checks): the policy and the brake, and the real `VaultSync` + `ReconciliationController` for delete, edited-meanwhile, never-had, ignored, vault list incomplete, conservative mode, mass delete, and delete propagation. Five of them fail without the change.

## Unreleased - 2.1.1-drive.8 (committed locally, not published)

### Changed (engine, now for every carrier including Cloudflare)
- **Engine step 1: the two delete fixes are no longer limited to Google Drive.** Both were Drive-only in `2.1.1-drive.7`; they now apply to Cloudflare too. A remote delete is applied when the disk file still equals the last synced content, even if an edit arrived in the same batch; a delete removes every active id for the path. A file you really edited is still kept. Chosen on purpose: the same symptom is reported upstream (kavinsood/yaos #78).
- Code: `src/main.ts` always wires the baseline provider; `VaultSync.handleDelete` always removes duplicate ids (the `_tombstoneDuplicateIds` flag is gone).

### Tests
- `drive-carrier-engine` grows to 20 checks: duplicate-id delete with the Cloudflare constructor, and the provider is not gated on the carrier.

## Unreleased - 2.1.1-drive.7 (committed locally, not published)

### Fixed (Google Drive carrier)
- **Encrypted vaults could upload plaintext after one failed start-up call.** If reading or writing `meta.json` failed once when connecting, later cycles skipped the key check and uploaded unencrypted files into the encrypted vault; other devices then rejected them and marked their own files "damaged". The folder now counts as ready only after the key check succeeds, and uploads refuse to run while the key is not ready.
- **A device whose clock was wrong could make Drive lose data.** Old snapshots were pruned by file name, which carries the creating device's clock, so a device could delete its own newest snapshot. Pruning now orders by Drive's own creation time and never deletes the snapshot it just wrote. The device's picture of what Drive holds is rebuilt after it deletes files, so the repair pass and the "saved" status stay correct.
- **"Synced" was reported with an incomplete document** (a file vanishing during the first read, a missing or hand-deleted file). The carrier now looks again up to three times and does not report synced while an update cannot be applied; it stays connected so edits still upload, and says why (`lastError`, `unreadableFiles`).
- **One request that never answered froze syncing until restart.** Each cycle now has a five-minute limit; after that it counts as a failure and the normal retry back-off takes over.
- A lagging file listing no longer causes duplicate uploads and a false "not saved" status (own fresh uploads are kept for 60 s).
- Closing the app now sends edits still waiting for the 2-second batch.
- A comment promised that a duplicate empty vault folder is removed; it is not, and the comment now says so.

### Fixed (Google Drive carrier, engine interaction)
- **A deleted note came back, with an OLD copy of its text.** If a note was edited and then deleted on one device, another device often received both in one poll. It compared its disk file (not yet updated with the edit) to the already updated document, took the file for "locally modified", kept it and revived the note. It now compares the disk file with the last content known to be in sync (the stored content hash); a file that matches is untouched and the delete is applied. A file the user really edited is still kept. Only wired when Google Drive is the carrier.
- **A deleted note came back after a reopen when two devices had created the same path.** Two ids for one path meant a delete removed only one of them. With Google Drive, a delete now removes every active id for that path.

### Tests
- `drive-carrier-hardening` (23 checks): one regression per carrier fix, each reproduced against the earlier code.
- `drive-carrier-fuzz` (about 6 s, fixed seeds): 155 random runs across five configurations (three and four devices, interleaved calls, clocks that disagree, compaction every segment, encrypted). The earlier code fails 46 of them.
- `drive-carrier-engine` (18 checks): real `VaultSync` and `DiskMirror` over the fake Drive for the two deletion fixes, the user-edit case, and the unchanged default behaviour.

## 2.1.1-drive.6 - 2026-10-02

### Changed
- **A shorter Google Drive settings screen.** With Google Drive chosen, the main section now holds only Status, Sync carrier, Set up Google Drive and Sign out (when signed in). Everything the setup guide fills in moved to one new page, **Manual setup (advanced)**, placed just before Advanced: Vault ID, Google client ID and secret, Sign in with Google, the easy sign-in code and the encryption passphrase. The page shows a warning mark while you are not signed in, and the Status text points to it.
  - The "Folder on Drive" row is gone; the Vault ID description names the folder instead.
  - The "This device" group (device name, used only for live cursors) is hidden.
  - Advanced no longer repeats the Vault ID and no longer talks about deployment.
  - No setting was removed or renamed; every control is still reachable and stores the same keys.
- **Command palette names for Google Drive.** *Reconnect to sync server* becomes *Retry syncing with Google Drive*, *Clear local server-receipt state* becomes *Clear local save-confirmation state*, and *Reset local cache (re-sync from server)* becomes *(re-sync from Google Drive)*. The confirmation texts of *Reset local cache* and *Nuclear reset* say Google Drive too. The command ids and what they do are unchanged.
- Cloudflare screens, command names and texts are unchanged.

### Tests
- `drive-carrier-settings` grows to 155 checks: the layout, each moved row, the manual page for each sign-in kind, every control still reachable, the Cloudflare screens unchanged, and the command names for both carriers.

## 2.1.1-drive.5 - 2026-10-02

### Added
- **Easy sign-in for Google Drive**, the new recommended first choice in the setup wizard. No Google Cloud project: you open a sign-in page, sign in with Google, copy the code it shows and paste it into the wizard. The wizard goes from 14 steps to 9.
  - The page and the token service are the ones used by the Obsidian Google Drive plugin (`ogd.richardxiong.com`, run by that plugin's author, not by YAOS). Your device sends the pasted code to the service to get short-lived access tokens; the Drive requests, and your notes, go straight to Google. The wizard says this on the screens, and recommends encryption.
  - The "How do you want to sign in?" screen offers Easy sign-in (recommended), Private sign-in (shown as "coming soon" until a built-in Google client is added) and Use my own Google client (the earlier guided path, unchanged).
  - A vault made with the easy sign-in gets a `YAOS-DRIVE2:` setup code (vault ID and optional passphrase, no client details, never the sign-in code). The second device is asked for its own sign-in code. `YAOS-DRIVE1:` codes still work as before.
  - Joining by hand has an "easy sign-in" box.
  - New settings keys, written only by the easy path: `driveAuthMode: "hosted"` (and an optional `driveHostedUrl` for self-hosters). They do not exist in anyone's settings until the easy path is used.
  - Settings: with the easy sign-in the client ID/secret and "Sign in with Google" rows are hidden, and a "Sign-in code (easy sign-in)" row lets you paste a new code if access is lost. Signing out returns the screen to the normal rows.
  - If the service says the code is no longer accepted (HTTP 400, 401 or 403, as the Obsidian Google Drive plugin also treats them), a notice asks you to sign in again; temporary errors and being offline just retry.
- New suite `drive-carrier-hosted` (56 checks): the token service client, which token source the carrier uses, both setup code kinds, pasted-code checks. More checks in `drive-carrier-wizard-flow` (now 197) and `drive-carrier-settings` (107).

### Changed
- The wizard's new-vault path now always shows the sign-in choice screen (before, it appeared only when a built-in client existed).
- Going back from the encryption screen skips the automatic sign-in step.

### Fixed
- Reading a setup code on the join path now happens before the next steps are worked out, so a code can switch the sign-in method correctly.
- The `no-any` guard failed on two lines from `2.1.1-drive.4` (a double cast in `main.ts` for the optional reload command, and one in the wizard test); both are rewritten without the cast.

### Notes
- Cloudflare users and existing Drive users are unaffected. The original upstream test suites still pass against this code (95 passed; the same one environment failure as before).
- Not tested against a real Google account: the live sign-in page and the service were only probed read-only (a made-up token gets HTTP 400 `invalid_grant`, as the code expects). What the page shows after sign-in needs a check on a real device.
- The sign-in service is run by someone else. If it stops, easy-sign-in vaults pause until you switch sign-in method.

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

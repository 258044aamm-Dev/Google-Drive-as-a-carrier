# Changelog

All notable changes to this fork of [YAOS](https://github.com/kavinsood/yaos) (plugin id `yaos`). The fork starts from upstream **2.1.1** and adds one optional thing: a **Google Drive carrier**, so a vault can sync through a folder in your own Google Drive instead of a Cloudflare Worker. Cloudflare stays the default and behaves as before; nothing changes unless you choose Google Drive.

Releases: https://github.com/258044aamm-Dev/Google-Drive-as-a-carrier/releases

Version numbers like `2.1.1-drive.3` exist only in each release's `manifest.json`. The repository itself still says `2.1.1`.

This file is specific to this fork. It is not part of upstream YAOS.

## Unreleased - 2.1.1-drive.9 (committed locally, not published)

### Changed (setup guide, Google Drive only)
- **"Private sign-in (coming soon)" is gone.** The disabled placeholder is removed. The guide now offers two ways to sign in: Easy sign-in, and **Private sign-in (your own Google client)**, which is the old "Use my own Google client (advanced)" path under a clearer name. The screen says that the user creates the Google project and enters its client ID and secret, that the details stay theirs, and that nothing goes through anyone else's service. The steps themselves are unchanged. The built-in-client code stays in place and unused: if a build ever contains one, the guide shows the old three-choice layout again.
- Code: `src/drive-carrier/wizard/screens.ts` only (plus `docs/drive-carrier.md`).
- Existing test changed on purpose: the one `drive-carrier-wizard-flow` check that asserted the "coming soon" placeholder now asserts its absence and the new wording. Nothing else in the wizard flow tests changed (200 checks pass).

## 2.1.1-drive.8 - 2026-10-03

### Fixed (engine, every carrier including Cloudflare)
- **A deleted "(YAOS conflict ...)" note no longer comes back after reopening, on both devices.** Conflict notes are meant to stay on one device, but a vault can still hold some as active shared entries (they synced in 2.1.0 and an older device can still send them; upstream issue #78's log shows the same notes being written back). Two things made the delete fail: the delete event ignored them because they are not syncable paths, so nothing was recorded and the other device never heard of it; and the full reconcile wrote every active shared entry that was not found on disk back to disk, which for these notes was always. Now (1) deleting a conflict note that is an active shared entry is recorded like any note's delete, so both devices drop it and it stays gone; (2) the full reconcile never writes a conflict note from the shared document to disk. A conflict note that is not a shared entry (the normal case) is still ignored, and every other note is handled exactly as before.
  - Code: new `src/runtime/reconcile/conflictNotePolicy.ts` (`shouldRecordMarkdownDelete`, `withoutConflictNotes`); the delete handler in `src/main.ts` and the "missing on disk" list in `ReconciliationController`.
  - Not changed: existing synced conflict notes are not deleted automatically (they can hold the only copy of some text). If a conflict note returns with a NEW timestamp, it is a fresh copy and a different cause; that was not reproduced and is not covered here.

### Tests
- New `engine-conflict-note-delete` (15 checks): the policy, the reconcile with a shared conflict-note entry missing from or present on disk, the delete reaching a second document and staying after a reconcile, and the delete handler using the policy. Four fail without the change. Controls: an ordinary shared note missing on disk is still written; a conflict note that is not shared and an ignored note are still ignored.

## 2.1.1-drive.7 - 2026-10-03

One test build that gathers everything done since `2.1.1-drive.6`. **Some of it changes behaviour for every carrier, Cloudflare included** (the engine fixes and the upstream issue fixes below); each change is narrow, has its own tests that fail without it, and leaves the existing suites unchanged. The Drive-only items change nothing unless Google Drive is the carrier.

**Part: Google Drive carrier hardening**

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

### Tests (Google Drive carrier hardening)
- `drive-carrier-hardening` (23 checks): one regression per carrier fix, each reproduced against the earlier code.
- `drive-carrier-fuzz` (about 6 s, fixed seeds): 155 random runs across five configurations (three and four devices, interleaved calls, clocks that disagree, compaction every segment, encrypted). The earlier code fails 46 of them.
- `drive-carrier-engine` (18 checks): real `VaultSync` and `DiskMirror` over the fake Drive for the two deletion fixes, the user-edit case, and the unchanged default behaviour.

**Part: Engine step 1**

### Changed (engine, now for every carrier including Cloudflare)
- **Engine step 1: the two delete fixes are no longer limited to Google Drive.** Both were Drive-only in `2.1.1-drive.7`; they now apply to Cloudflare too. A remote delete is applied when the disk file still equals the last synced content, even if an edit arrived in the same batch; a delete removes every active id for the path. A file you really edited is still kept. Chosen on purpose: the same symptom is reported upstream (kavinsood/yaos #78).
- Code: `src/main.ts` always wires the baseline provider; `VaultSync.handleDelete` always removes duplicate ids (the `_tombstoneDuplicateIds` flag is gone).

### Tests (Engine step 1)
- `drive-carrier-engine` grows to 20 checks: duplicate-id delete with the Cloudflare constructor, and the provider is not gated on the carrier.

**Part: Engine step 2**

### Fixed (engine, every carrier including Cloudflare)
- **Engine step 2 (upstream SYNC-01): a note you deleted while YAOS was off, or before the first sync finished, no longer comes back.** At the next full reconcile a note that is in the shared document but missing on disk was always written back. Now one content rule decides: the device remembers a hash of the text it last had in sync (the disk index). If that hash still equals the document's text, nothing changed since the file was there, so its absence is a delete made on this device; it is recorded as deleted and the other devices follow. Everything else is as before and the note is written back: no remembered hash (a note this device never had), the document text changed meanwhile (someone edited it, so the edit is not lost), an ignored path, or a file the file system still has.
  - A brake keeps a vault that looks emptied (the file list not loaded) from being mass-deleted: more than 20 notes and more than 25 % of tracked notes, or several notes with no markdown file found at all, are written back instead and the block is traced (`reconcile-offline-delete-blocked`).
  - Only in full (authoritative) reconciles. Code: new `src/runtime/reconcile/offlineDeletePolicy.ts`; `ReconciliationController` calls it before writing the "missing on disk" notes.
  - Not covered: a delete whose event was lost after a reconcile already dropped the file's remembered hash, and notes edited on this device and never re-synced to a settled hash; both are written back as before.

### Tests (Engine step 2)
- New `engine-offline-delete` (24 checks): the policy and the brake, and the real `VaultSync` + `ReconciliationController` for delete, edited-meanwhile, never-had, ignored, vault list incomplete, conservative mode, mass delete, and delete propagation. Five of them fail without the change.

**Part: Engine step 3**

### Fixed (engine, every carrier including Cloudflare)
- **Engine step 3 (upstream SYNC-02): an edit on one side of an open note is no longer discarded without a trace.** When an open (editor-bound) note had changed on BOTH sides since the last synced text, one side was overwritten silently: the editor/disk text over the shared document ("local only" branch), or an external disk edit over it ("idle" branch). With the remembered baseline hash it is now known when both sides differ from the baseline and from each other; then the side about to be overwritten is first kept as a `(YAOS conflict - crdt ...)` note. Which side wins is unchanged. Normal typing lag (the document still at the baseline), a missing baseline, equal texts and repeated events make no copy (same cap and dedupe as the existing conflict notes).
  - Code: `src/runtime/reconcile/boundDivergencePolicy.ts`; `ReconciliationController.preserveCrdtIfBothSidesChanged` called before the two overwrites.
  - Found but NOT changed: if an open note's disk file lags behind a remote edit and still equals the old baseline, the "idle" branch can write that old text back over the shared document unless the user typed recently. That needs the real editor to judge, so it is only recorded here.

### Tests (Engine step 3)
- New `engine-bound-both-changed` (13 checks): the policy, both branches, the ordinary cases (no copy), no baseline, a repeated event. Three fail without the change.

**Part: Server, startup, attachments and status bar**

### Fixed (snapshots; server and Google Drive)
- **Snapshot lists said "0 notes".** The note count of a snapshot was read from `pathToId`, a map that current vaults no longer fill. A vault with thousands of notes showed `markdownFileCount: 0` (upstream issue #78 reported it for the Cloudflare server). The count now comes from the active entries of `meta`; documents without a schema version or with schema v1 keep the old count. Same fix in the Google Drive snapshot backend, which had copied the bug. Only the number in the snapshot list changes; snapshot content and restore are untouched.
  - Code: new `server/src/activeFiles.ts`; `server/src/snapshot.ts`; `src/drive-carrier/driveSnapshotBackend.ts`; `isTombstone` is now exported from `server/src/tombstoneReaper.ts` (no behaviour change).

### Added (server diagnostics)
- **The tombstone reaper's trace now explains an idle pass.** Two new fields, `oldestTombstoneAgeMs` and `nextEligibleAt`, say how old the oldest deleted note is and when the first one becomes eligible. A report like "reaped: 0, every tombstone within the grace window" (upstream issue #78) can now be told from a real fault: if even the oldest is younger than 30 days, nothing is wrong. Nothing is reaped differently.

### Checked, no code change (re-deleting does not refresh a tombstone)
- A question from upstream issue #78 was whether deleting a note again keeps pushing its deletion time forward, so the 30-day grace never ends. It does not: a second delete finds no active note for the path and does nothing, a reconcile does not touch the time, and only a delete after a re-create counts as a new deletion. Pinned by the new `engine-tombstone-age` test so a future change cannot break it silently.

### Changed (server)
- **A load now clears more than 500 old deleted bodies.** The reaper still caps one pass at 500 bodies (so no single update grows), but after a pass that left some behind, the server runs further passes within a 50 ms budget instead of waiting for the next cold load. Vaults with 500 or fewer eligible bodies run exactly one pass, as before. New function `reapTombstonedBodiesUntilDone` in `server/src/tombstoneReaper.ts`; `server.ts` calls it in place of the single pass. Durable Object behaviour itself could not be run here; the function is tested on documents.

### Fixed (startup)
- **The first reconcile after startup now waits for Obsidian to restore its workspace layout** (upstream issue #77). Until the layout is restored, the notes you had open are placeholder tabs, so the first reconcile treated them as closed. For a note typed in just before the last shutdown, with no stored baseline, that kept your text as a "(YAOS conflict - disk …)" copy next to the note. New `src/runtime/waitForLayoutReady.ts`; `initSync` in `main.ts` waits once, right before the startup reconcile, for at most 20 seconds, then carries on exactly as before. Reconnect reconciles and the Drive carrier's own sync are not gated; the Drive carrier shares `initSync`, so it gets the same wait.
- **Second rule from the plan not built.** A note that is open with identical text is already a no-op in the planner (`disk-equals-crdt`), and a loaded editor view is already skipped, so a second content rule would only stack on the first.

### Fixed (attachments)
- **A local attachment that grew past the size limit is no longer overwritten by the older synced copy** (upstream issue #75). Such a file is left out of upload and reconcile, but it stayed in the synced list, so the download path replaced it without a word. `processDownload` in `src/sync/blobSync.ts` now leaves a local file that is over this device's limit alone, counts it (`oversizedLocalSkips`), traces `skip-local-over-limit`, and shows one Notice per path per session saying that the limit is the reason. With no limit set (0), or for a file within the limit, nothing changes. The same code serves Cloudflare and Drive attachments.
- **Not changed:** the silent clamp of the limit by the server capability update (`capabilityUpdateService.ts`) still happens; only its effect on local files is closed.

### Changed (status bar wording)
- **"Receipt: local state not yet received by server" no longer shows while only the newest edit is waiting** (upstream issue #68). When the server has already confirmed an earlier state (`lastKnownServerReceiptEchoAt` is set) and the newest edit is not confirmed yet, a connected device now reads "Receipt: latest edit awaiting server confirmation". Before any confirmation, and when offline, the old wording stays. Only the text changes: the tracker, the confirmation rule and the stored data are untouched.
- **Why it is not a deeper fix:** the maintainer called the label non-breaking, and the reported state vectors could not be reproduced as a fault in the tracker, so the confirmation rule is left alone.

### Tests (Server, startup, attachments and status bar)
- `tombstone-reaper` gains Test 17 for the two new fields and Test 18 for the multi-pass loop (1154 tombstones, budget 0, expiring clock, clean document). New `engine-tombstone-age` (6 checks). New `engine-startup-layout` (9 checks): the wait helper, the reconcile with an open versus a not-yet-open note (shows the copy appearing only in the second case), and the position of the wait in `initSync`. `server-ack-tracker` gains Test 13 (the issue's sequence: confirmed, more typing, an echo behind it, then a dominating echo; label checked at each step). New `blob-oversize-local` (12 checks, 8 fail without the change): oversize file kept, no fetch, one notice, controls for small, missing and unlimited, and the same through a reconcile. New `active-files-count` (6 checks, one fails without the change); `drive-carrier-snapshots` gains a current-model check (fails without the change).

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

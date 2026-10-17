# Google Drive carrier (experimental)

YAOS normally syncs through a Cloudflare Worker. The Drive carrier is an
alternative that needs **no server**: devices exchange the same Yjs updates by
writing small immutable files into a folder in the user's own Google Drive.

It is **off by default**. Nothing changes for existing setups; the carrier is
only used when you pick it in *Settings > YAOS > Setup > Sync carrier* (if a Cloudflare server is already set up, it is the first row under *Advanced*).

## How it behaves

- Changes travel as files in a Drive folder named `YAOS <vault id>`.
- Other devices notice new files by polling, so edits arrive after a few
  seconds, not instantly (see "Request budget" below).
- Cursors and presence of other devices are not shared (local only).
- Attachments and snapshots are stored in Drive too (see below).
- The status bar's "saved" state means "stored on Drive".
- Only the `drive.file` scope is requested, so YAOS can only see files it
  created itself, never the rest of the Drive.

## Attachments and snapshots

Both live in their own Drive folders, separate from the folder that is polled
for changes:

- **Attachments**: folder `YAOS <vault id> blobs`. One file per attachment,
  named by its SHA-256. Every upload is checked (hash of the content and the
  size Drive stored), and every download is checked against its hash, so a
  damaged file is never written into your vault. Identical attachments are
  stored once. Whether an attachment already exists is answered from one
  folder listing that is reused for 30 seconds, to stay within Drive's
  request limits. The command **YAOS: Find unused attachments on Google
  Drive (dry run)** counts and lists attachment files that neither the live document nor
  any retained restore point mentions. It only lists them: nothing is deleted,
  and no delete path exists behind it.
- **Snapshots** (restore points): folder `YAOS <vault id> snapshots`. Each
  snapshot is a data file (`snapdat-<id>.bin`, the whole document, compressed,
  with a checksum) plus a small index file (`snapidx-<id>.json`) that is
  written last, so a snapshot only appears once it is complete. The daily
  snapshot is taken once per UTC day across all devices. *Take a snapshot now*
  makes a pinned one. The existing "browse snapshots" and restore screens work
  unchanged.
- **Cleanup** keeps every pinned (manual) snapshot plus the **newest 14**
  daily ones and removes the rest, together with leftovers of interrupted
  snapshot writes (older than 10 minutes). A restore point is only removed
  while a *newer readable* one stays, so the newest complete snapshot is never
  deleted. This is a Drive-carrier choice; it is not the Worker's retention
  policy.
- The attachment size limit and concurrency settings apply as before.

Limits: a damaged attachment on Drive keeps failing and is not repaired
automatically. Delete that file in the `... blobs` folder on drive.google.com,
then rename (or change) the attachment on a device that still has the original so
that it is uploaded again. Drive's own storage quota applies.

## Encryption (optional)

Enter an **Encryption passphrase** (in the Google Drive settings group, below the
Google client fields) **before the first sync of a new vault**, and use the same
passphrase on every device. Everything YAOS stores on Drive is then sealed:
note updates, snapshots (including their index), and attachments (whose file
names become keyed hashes, so even the content hash is not visible).

- Algorithm: AES-256-GCM. The key comes from the passphrase with PBKDF2-SHA256
  (600,000 iterations, random salt kept in the vault folder's `meta.json`) and
  HKDF. GCM detects any change to a file, and each file is bound to its vault
  and purpose, so files cannot be swapped between vaults or kinds.
- What stays readable on Drive: file names (time stamps, device ids), file
  sizes, the salt, and the fact that the vault is encrypted.
- Encryption can only be chosen when a vault is first created on Drive. A
  passphrase on an existing unencrypted vault is refused with a clear message
  (use a new Vault ID). A device without the passphrase, or with a wrong one,
  stops with a clear message and writes nothing.
- The passphrase is stored in the plugin's `data.json` on each device, like the
  Google sign-in. It protects your data on Google's servers, not against someone
  who can read your vault's plugin folder. **A lost passphrase cannot be
  recovered**; the data on Drive is then unreadable.
- Reload the plugin after changing the passphrase.
- Notes on your devices are not encrypted by YAOS (they are your normal files).
- **The easy sign-in requires a passphrase (F4, 2.1.23).** That path is the one
  case where a service run by someone else takes part in signing in, so the
  wizard will not create a vault through it without encryption, and will not
  finish joining a vault that has none: a third party would otherwise hold a
  token while the files sat readable in the Drive web app. The private path
  (your own Google client) keeps encryption optional, and a vault without a
  passphrase can still be created and joined there; only the easy sign-in
  refuses it, with a message saying so.

## Request budget, background and phones

Drive has no push channel, so each device asks Drive for news. To keep this
cheap:

| State | Poll every |
|---|---|
| Window in use (an edit, a received change or the window coming to the front in the last minute) | 3 s |
| Idle for a minute | 30 s |
| Window hidden, desktop | 2 min |
| Window hidden, phone/tablet | paused |
| After failures | 1 s doubling up to 60 s |

Coming back to the front or regaining the network polls immediately, and edits
waiting to upload are sent when the window goes away. A flat 3-second poll would
be 200 requests in ten idle minutes; this takes about 38 (about 5 hidden on
desktop, none on a phone). A request counter is built in (`requestStats()`), and
the tests assert these budgets. It counts payload bytes as well as calls:
`bytesWritten` (what the carrier stored on Drive) and `bytesRead` (what it
downloaded), each also per operation, so the cost of a vault can be read off
instead of guessed.

Because phones suspend apps, changes made on another device while the phone app
is in the background arrive when you open it again.

### Sync speed (if Google reports too many requests)

The table above is the **Normal** speed, and it is what you get unless you
change it. In the settings, under "Sync speed (Google Drive)", you can choose a
slower speed. Nothing else changes: the same data is synced, it just arrives a
little later.

| Speed | While working | Idle | Hidden (desktop) | Edits grouped for | Full check |
|---|---|---|---|---|---|
| Normal (default) | 3 s | 30 s | 2 min | 2 s | 5 min |
| Gentle | 10 s | 60 s | 5 min | 5 s | 10 min |
| Minimal | 30 s | 2 min | 15 min | 10 s | 30 min |
| Custom | you choose | you choose | you choose, or 0 = pause | you choose | you choose |

Phones still pause while the app is in the background, whatever the speed.
Custom values are never allowed to be faster than Normal (each field shows its
allowed range). The change applies immediately, without a restart. Nothing is
stored until you pick a different speed, so vaults that never touch it behave
exactly as before.

Cloudflare vaults have the same setting (Advanced, once a server is set up). A
live connection has nothing to poll, so there it only controls how long your
edits are gathered before being sent together: Normal sends each edit at once
(default), Gentle 2 s, Minimal 5 s, Custom 0 to 30 s.

### What tidying the sync folder costs (2.1.23)

Every device writes its edits as small `seg-*.ydu` files and reads the ones the
others wrote. When the folder has gathered many of them, the carrier tidies up.
Until 2.1.22 that meant uploading a copy of the **whole document** as soon as the
change files passed 1 MB, so an 8 MB vault wrote 8 MB again after a few lines of
typing (measured: 28× the bytes you changed). Since 2.1.23 it works in two tiers:

- **Merge (the common case).** The *smallest* change files are merged into one
  with `Y.mergeUpdates`, and only enough of them to bring the file count back to
  its cap. The bytes written are about the bytes those files held, so a normal
  vault writes about what you changed, plus the copy of it that gets merged. A
  file that is already large stays out of the way: rewriting it would store the
  same bytes again for nothing.
- **A full copy only when it pays.** A full snapshot is written only when it is
  at most 60% of the live change files (and at most 64 MB, so one huge vault
  cannot start a giant upload). That is the case worth a copy: a lot of text was
  typed and then deleted, so the change files hold far more than the document
  does.

Measured on the probe that found the problem: 8.29 MB document with 0.30 MB of
edits wrote ×1.0 (was ×28.2), the same with 3.00 MB of edits wrote ×1.0 (was
×10.5), and 250 edits past the tidy-up cap wrote ×1.41. A "Compact changes"
setting on the Drive settings screen restores the old behaviour exactly
(*Take full copies*, i.e. 2.1.22) for anyone who prefers it.

Memory is bounded the same way: the carrier keeps the payload of a change file
only while it is needed to rebuild what Drive holds (a later full copy drops the
ones it covers, and the oldest are dropped past 32 MB). A payload it dropped is
simply read back from Drive if a rebuild ever needs it, so nothing is lost.

## Setup wizard (recommended)

Choose **Google Drive (experimental)** under Settings > YAOS > Setup > Sync
carrier, or press **Set up Google Drive** in the Google Drive section, or run
the command **YAOS: Set up Google Drive**. A short wizard walks you through:

1. **Start a new vault** or **Join my existing vault** (a second device).
2. **How to sign in.** Two choices (three if a built-in Google client is ever added to a build):
   - **Easy sign-in (recommended).** You open a sign-in page, sign in with
     Google, copy the code it shows and paste it into the wizard. No Google
     Cloud project is needed. The page and a small token service are run by the
     author of the Obsidian Google Drive plugin (`https://ogd.richardxiong.com`,
     source: github.com/RichardX366/Obsidian-Google-Drive-website), not by YAOS.
     This device sends the code to that service each time it needs a short-lived
     access token, because only the service holds the Google client secret.
     Your notes never pass through it: Drive requests go from your device
     straight to Google. Because the service takes part in signing in,
     **encryption is required on this path**.
   - **Private sign-in (your own Google client).** The wizard shows each
     Google Cloud page with a button and asks for the client ID and secret you
     create (the same five steps as "Setup" below). You make the Google project
     and keep its details; nothing goes through anyone else's service. If a
     build ever contains a built-in client, a separate "built-in connection"
     choice appears next to it.
3. **Sign in with Google** (private and own-client paths): a code appears;
   open google.com/device on any device and enter it. On the easy path this
   step only checks the pasted code with the service.
4. **Encryption** (new vault only; on by default, and required on the easy
   sign-in path — see below). The passphrase cannot be recovered; without it
   nobody, including you, can read the notes on Drive.
5. **Create.** The wizard checks that it can create, read and delete a file in
   a new `YAOS <vault id>` folder, writes `meta.json`, and only then saves your
   settings. Nothing is saved or written to Drive if you cancel earlier.
6. **Setup code.** A `YAOS-DRIVE1:...` code holds the vault ID, the client
   details and (if you tick the box) the passphrase. An easy-sign-in vault gives
   a `YAOS-DRIVE2:` code with only the vault ID and passphrase. No code ever
   contains your sign-in token. Paste it on the second device under **Join my existing
   vault**. Treat it like a password and never put it in a note inside the vault.

On a device that is already set up, the wizard first warns that a new vault
leaves the old Drive folder untouched, and asks you to confirm.

The wizard starts syncing straight away when nothing was running; if sync was
already running in the session it offers a Reload button instead. The manual
steps below still work and are unchanged.

### Easy sign-in notes

- A vault is visible only to the Google client that made it (a `drive.file`
  rule). A vault made with the easy sign-in cannot be opened with your own
  client, and the other way round. Choose one and keep it.
- If the service is down, sync pauses and retries; your notes stay in Drive and
  on your devices. If it is shut down for good, make a new vault with another
  sign-in method and copy your notes across.
- If sync says your sign-in was lost, sign in again on the page and paste the new
  code in Settings > YAOS > Manual setup (advanced) > "Sign-in code (easy sign-in)", then
  reload. Self-hosters can set `driveHostedUrl` in the plugin's `data.json`.
- **The address that receives your sign-in code must be a full `https://` address.**
  A custom `driveHostedUrl` that is plain `http`, a bare host name, or a relative
  path is refused before anything is sent: the wizard shows the reason under the
  code box and will not continue, and the running carrier stops with the same
  message (traced as `drive-carrier: sign-in address refused`). Nothing falls back
  to the default service.
- A custom address is always named where you can see it: the wizard's token screen
  and the settings row both show the exact host the code is sent to. When the
  configured address differs from the one that last issued a token for this
  device, the carrier traces the change (`sign-in address changed from ... to ...`)
  and re-checks your saved sign-in against the new address before using it; an
  address is recorded only after the service has actually issued a token, so a
  failure never counts as "used".
- Signing out of an easy sign-in returns the manual page to the normal rows.

### The Drive settings screen

With Google Drive chosen the settings screen is kept short: **Status**, **Sync
carrier**, **Set up Google Drive** and **Sign out** (when signed in), plus the
generic groups (What syncs, Attachments, Advanced). Everything the wizard fills in
lives on one page, **Manual setup (advanced)**: Vault ID (its description names
the `YAOS <vault id>` folder on Drive), Google client ID and secret, Sign in with
Google, the easy sign-in code, and the encryption passphrase. It shows a warning
mark while you are not signed in. The "This device" group (device name, used only
for live cursors) is hidden. In the command palette three names say Google Drive
instead of "server": *Retry syncing with Google Drive*, *Clear local
save-confirmation state* and *Reset local cache (re-sync from Google Drive)*; the
two confirmation texts of *Reset local cache* and *Nuclear reset* do the same.
Cloudflare screens and names are unchanged.

## Hardening (limits and what is guarded)

- **Key check before any upload.** The folder is used only after the key check (`meta.json`) succeeded; an encrypted vault never receives plaintext, even after a failed start-up call.
- **A restore point is read back before anything is deleted.** After a compaction writes the full snapshot, the carrier downloads it, checks its checksum and compares the document state it holds with the state that was encoded; only then are the sync files it covers removed. The uploaded file's size is still verified as before. If the read-back fails or the file cannot be read, *every* file is kept, the reason is logged once, and the next compaction (at least 30 s later) tries again. **Restore points kept** (in the Google Drive settings page, 2 to 10, default 4) decides how many full copies one compaction keeps; 2 is exactly what 2.1.22 kept. **Check a restore point before deleting** turns the read-back off for metered connections, which restores 2.1.22's behaviour exactly.
- **Snapshots are pruned by Drive's creation time**, not by file name, so a wrong device clock cannot delete the newest data.
- **Tidying the folder is bounded (F1).** Compaction merges the smallest change files instead of re-uploading the document; a full copy is only written when it is at most 60% of the live change files and at most 64 MB. Measured cost of the old behaviour was ×28 the bytes you changed; the new default is about ×1. "Compact changes → Take full copies" restores 2.1.22 exactly. The request meter reports bytes as well as calls (`requestStats()`: `bytesWritten`, `bytesRead`).
- **Memory is bounded (F7).** A change file's payload is kept only while it is needed to rebuild the picture of what Drive holds, and never more than 32 MB in total (oldest dropped first). Evicted payloads are re-read from Drive when a rebuild needs them, so convergence is unchanged. Wrong clocks still affect the note-collision tie-break and snapshot day names (same as with Cloudflare).
- **Not "synced" while incomplete.** If a file is missing or an update cannot be applied, the carrier stays connected, keeps uploading your edits and does not claim to be synced. Check `unreadableFiles` in diagnostics for damaged files.
- **Time limit.** One sync cycle may take five minutes; a stuck request then counts as a failure and is retried with back-off.
- **Deletes (all carriers).** A remote delete is applied when the disk file still matches the last synced content, even if an edit arrived in the same poll. A file you really edited is kept (and the note is revived with your text). A delete removes every active id for the path. A note you deleted while YAOS was off is recorded as deleted at the next full reconcile when its remembered content hash equals the shared text (otherwise it is written back as before).
- **Not covered:** no automatic garbage collection of attachment files on Drive (the dry-run command above lists candidates and never deletes); a plaintext and an encrypted vault started at the same moment in one folder end up split; a stray empty duplicate vault folder is not removed; no real-device or real-account run yet (see the F8 bullet above).
- **The completeness check does not pin Yjs internals (F9).** `pendingStructs`/`pendingDs` are read through one guarded module; if a Yjs upgrade stops exposing them, the carrier falls back to comparing the state vectors of the payloads it applied against the document's own, so a waiting document is never reported as synced. `drive-carrier-hardening` asserts both paths agree.
- **File names carry a per-run tag (F9).** `seg-<13-digit ms>-<device>-<counter>-<tag>.ydu`; two runs starting inside the same millisecond can no longer mint the same name. The 13-digit stamp still leads, so name order is unchanged and an untagged name is what 2.1.22 wrote.
- **Timers come from the host (F9).** `DriveTransportOptions.scheduler` (default `window`) is where every timeout is set and cleared, so a fake clock can drive a whole cycle and the carrier is not bound to a browser global.
- **The formats say what they do and do not protect (F9).** A change file's kind and flags sit outside its checksum by design, and each consequence fails closed (kind flip: the same bytes apply; flag flip: the vault's key refuses the file; another vault: the associated data refuses it). An attachment is named by its hash and verified on download, so a second checksum there would protect the same bytes twice.
- **The sign-in address must be a full https address (F4).** A `driveHostedUrl` that is not `https://…` (plain http, another scheme, a bare host, a relative path) is refused with a message naming the address and saying nothing was sent — in the wizard, in the join check and in the running carrier, which stops instead of posting the token anywhere. A custom address is always named where the user can see it (wizard screen and the easy-sign-in settings row), and one that differs from the address that last issued a token is traced before the first token request of the session; the address is recorded as used only after a token was actually issued.
- **The easy sign-in requires a passphrase (F4, decision 4).** That path hands the sign-in to a service run by someone else, so the wizard refuses to create a vault through it without encryption and refuses to finish joining one, with a message saying so; the encryption tick box cannot be turned off there. The private path (own Google client) keeps encryption optional, and plain vaults still join there.
- **Not verified against a real account yet (F8).** Every Drive suite runs against `FakeDrive`; the opt-in gate `tests/live/drive-real.ts` (registered under `skip`) measures listing latency, duplicate names, the multipart ceiling, error bodies, a 6 MB resumable round trip and the `drive.file` invisibility rule. Its results belong in `docs/drive-carrier-device-results.md`, which records the run as **accepted unrun for 2.1.23** (deferred at the release gate on 2026-10-11): treat the Drive data path as fake-verified only.
- **Simulation suite.** `drive-carrier-fuzz` (about 6 s, fixed seeds) must stay green; rerun one configuration with `FUZZ_ONLY=<part of the name> FUZZ_SEEDS=<n>`.

## Setup (once per Google account)

Google's device sign-in needs an OAuth client of type **TVs and limited-input
devices**. YAOS cannot ship one for you, so you create your own (free):

1. In the Google Cloud console, create a project and enable the **Google Drive API**.
2. Configure the OAuth consent screen (user type *External*). Add the scope
   `.../auth/drive.file`.
3. Create credentials > OAuth client ID > application type **TVs and limited-input devices**.
4. Keep the client **published** ("In production"). In "Testing" mode Google
   expires refresh tokens after 7 days. (`drive.file` is not a sensitive scope;
   confirm in the console what your project requires.)

Then, on each device:

1. Settings > YAOS > Setup > **Sync carrier** > *Google Drive (experimental)* (under *Advanced* if a server is already set up), then reload the plugin.
2. Open **Manual setup (advanced)** and paste the **client ID** and **client secret**.
3. In the same page, press **Sign in with Google**, open the shown address on any device and enter the code.
4. Reload the plugin. Syncing starts.
5. On the second and later devices, set the **same Vault ID** (Manual setup (advanced) > Vault ID)
   and, if you chose one, the same encryption passphrase.

The refresh token is stored in the plugin's `data.json` next to the other
settings, exactly like the Cloudflare sync token. It never leaves the device
except to talk to Google.

Once a device is signed in, the **Set up Google Drive** row disappears from the
settings screen: there is nothing left to set up on it. Signing out brings the
row back. The guided setup itself stays available from the command palette
(*Set up Google Drive*) and from **Manual setup (advanced)**, so a device can
always be pointed at another vault.

## Switching back

Choosing *Cloudflare Worker* again restores the previous behaviour; the
Cloudflare settings are never removed. Only one carrier is active at a time.

## Testing this on real devices

The automated tests use an in-memory fake of Drive. Real Drive behaviour (latency,
listing under the `drive.file` scope, quotas) and real phones are not covered by
them; use [drive-carrier-device-checklist.md](drive-carrier-device-checklist.md).

## 2.1.21 safety notes

- Restoring historical `A.md` when its identity now lives at `B.md` creates a
  separate `A.md`; the current `B.md` is not renamed or overwritten. A genuine
  deleted note can still reuse its tombstoned identity. This is shared restore
  behavior, including Cloudflare and Local network.
- An unreadable/corrupt Drive update keeps completeness false, even if a newer
  snapshot exists: unknown corrupt bytes are not assumed to be covered. Local
  edits and additive repair uploads still work, but complete receipts and
  compaction wait. The same file is retried on later polls. Prefer restoring the
  damaged file from a trusted backup; do not delete unknown data just to clear
  the warning. If an owner deliberately removes it after recovery, the next
  listing can clear the block. `unreadableFiles` and `lastError` report the state.
- Poll, flush and reconcile are bounded by the operation timeout. Disconnect,
  timeout and teardown fence their continuations and synchronously requeue a
  detached pending batch. The HTTP implementation may not abort a request
  already sent; it can still arrive at Drive, but its late result cannot change
  the local document, send receipts or launch follow-on cleanup. Duplicate Yjs
  update uploads are safe. Teardown's separate best-effort final upload uses
  captured bytes only and never updates the ended transport. Local persistence
  and next-start reconciliation remain the fallback if shutdown cannot send it.
- Restore-point downloads validate vault, sizes and the raw update's SHA-256
  against the selected index before applying data. Both Drive/LAN writers have
  always emitted these integrity fields; missing/invalid hashes are now refused.
  The gzip length declaration must agree with the index before allocating the
  output buffer; invalid sizes or sizes beyond its 32-bit length representation
  are refused. No smaller arbitrary vault-size cap is imposed. Live sync,
  attachment limits and the encryption format are unchanged.
- Hosted token refresh errors keep their safe configuration/network/rate-limit/
  service classification throughout vault access. No raw response body or
  credential is included in the new hosted error diagnostics.

## Configuration staging preview (2.1.22)

The default-off [configuration safety preview](config-sync-preview.md) uses the
shared coordinator across all three carriers. It exchanges only reviewed JSON
projections and does **not** apply them to live configuration, including after
restart. The ordinary configuration-directory exclusion remains unchanged.

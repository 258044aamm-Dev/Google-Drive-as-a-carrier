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
  request limits.
- **Snapshots** (restore points): folder `YAOS <vault id> snapshots`. Each
  snapshot is a data file (`snapdat-<id>.bin`, the whole document, compressed,
  with a checksum) plus a small index file (`snapidx-<id>.json`) that is
  written last, so a snapshot only appears once it is complete. The daily
  snapshot is taken once per UTC day across all devices. *Take a snapshot now*
  makes a pinned one. The existing "browse snapshots" and restore screens work
  unchanged.
- **Cleanup** keeps every pinned (manual) snapshot plus the **newest 14**
  daily ones and removes the rest, together with leftovers of interrupted
  snapshot writes (older than 10 minutes). This is a Drive-carrier choice;
  it is not the Worker's retention policy.
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
the tests assert these budgets.

Because phones suspend apps, changes made on another device while the phone app
is in the background arrive when you open it again.

## Setup wizard (recommended)

Choose **Google Drive (experimental)** under Settings > YAOS > Setup > Sync
carrier, or press **Set up Google Drive** in the Google Drive section, or run
the command **YAOS: Set up Google Drive**. A short wizard walks you through:

1. **Start a new vault** or **Join my existing vault** (a second device).
2. **How to sign in.** Three choices:
   - **Easy sign-in (recommended).** You open a sign-in page, sign in with
     Google, copy the code it shows and paste it into the wizard. No Google
     Cloud project is needed. The page and a small token service are run by the
     author of the Obsidian Google Drive plugin (`https://ogd.richardxiong.com`,
     source: github.com/RichardX366/Obsidian-Google-Drive-website), not by YAOS.
     This device sends the code to that service each time it needs a short-lived
     access token, because only the service holds the Google client secret.
     Your notes never pass through it: Drive requests go from your device
     straight to Google. Because the service takes part in signing in,
     **turn encryption on**.
   - **Private sign-in.** The Google client built into the plugin; nothing goes
     through anyone else's service. Shown as "coming soon" until a built-in
     client is added to this build.
   - **My own Google client (advanced).** The wizard shows each Google Cloud
     page with a button and asks for the client ID and secret (the same five
     steps as "Setup" below).
3. **Sign in with Google** (private and own-client paths): a code appears;
   open google.com/device on any device and enter it. On the easy path this
   step only checks the pasted code with the service.
4. **Encryption** (new vault only; on by default). The passphrase cannot be
   recovered; without it nobody, including you, can read the notes on Drive.
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
- **Snapshots are pruned by Drive's creation time**, not by file name, so a wrong device clock cannot delete the newest data. Wrong clocks still affect the note-collision tie-break and snapshot day names (same as with Cloudflare).
- **Not "synced" while incomplete.** If a file is missing or an update cannot be applied, the carrier stays connected, keeps uploading your edits and does not claim to be synced. Check `unreadableFiles` in diagnostics for damaged files.
- **Time limit.** One sync cycle may take five minutes; a stuck request then counts as a failure and is retried with back-off.
- **Deletes.** A remote delete is applied when the disk file still matches the last synced content, even if an edit arrived in the same poll. A file you really edited is kept (and the note is revived with your text). A delete removes every active id for the path.
- **Not covered:** no garbage collection of attachment files on Drive; memory use grows with vault size (every applied update payload and two snapshots are kept in memory); a plaintext and an encrypted vault started at the same moment in one folder end up split; a stray empty duplicate vault folder is not removed.
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

## Switching back

Choosing *Cloudflare Worker* again restores the previous behaviour; the
Cloudflare settings are never removed. Only one carrier is active at a time.

## Testing this on real devices

The automated tests use an in-memory fake of Drive. Real Drive behaviour (latency,
listing under the `drive.file` scope, quotas) and real phones are not covered by
them; use [drive-carrier-device-checklist.md](drive-carrier-device-checklist.md).

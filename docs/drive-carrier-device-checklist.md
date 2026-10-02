# Drive carrier: device checklist

The automated suites run against an in-memory fake of Google Drive. These steps
check what a fake cannot: real Drive, real Obsidian, real phones. Use a scratch
vault and a scratch Google account first. Tick each line and note the date,
device and plugin build.

## 0. Preparation

- [ ] Google Cloud project with the Drive API enabled and an OAuth client of type
      "TVs and limited-input devices" (see `drive-carrier.md`). Client is **published**.
- [ ] Two devices at minimum: one desktop and one phone (ideally also a tablet).
- [ ] Desktop: Settings > YAOS > Setup > Sync carrier > Google Drive (on a vault with a Cloudflare server already set up it is the first row under Advanced). Reload.
- [ ] Note the vault ID. Set the same one on the second device.

## 1. Sign-in

- [ ] Desktop: enter client ID and secret, press Sign in. The code appears; open
      google.com/device on the phone, enter it, approve. The modal closes by itself.
- [ ] The consent screen only asks for access to files YAOS creates (not "all Drive files").
- [ ] Reload. Status shows connected. The folder `YAOS <vault id>` exists in Drive.
- [ ] Phone: same sign-in. Typing the code on the phone is acceptable (note how it feels).
- [ ] Sign out, then in again.
- [ ] Revoke access at myaccount.google.com/permissions. Within a minute YAOS shows
      "Google access was lost"; nothing is deleted locally.
- [ ] Leave a test-mode (unpublished) client for 8 days: does sign-in still work? (Google may expire it after 7 days.)

## 2. Text sync

- [ ] Type in a note on desktop; it appears on the phone within ~6 s (phone in front).
- [ ] Edit the same note on both at once; both converge, no text lost.
- [ ] Create, rename, move and delete a note on one device; the other follows.
- [ ] Go offline on one device, edit, come back: edits merge.
- [ ] Paste a very large note (a few hundred KB). It arrives.
- [ ] Status bar says saved/connected; turn off Wi-Fi: it shows offline and recovers by itself.

## 3. Background and phones

- [ ] Phone: put Obsidian in the background for 5 minutes. Edit on desktop. Open the phone app: the change arrives within a few seconds of opening.
- [ ] Edit on the phone and switch to another app right away. The edit reaches desktop within a minute (it is sent when the window goes away).
- [ ] Desktop: minimise the window for 5 minutes; edit on the phone; restore the window: the change arrives at once.
- [ ] Battery: an hour with Obsidian open and idle on the phone does not drain noticeably more than before.

## 4. Request budget (real quota)

- [ ] Google Cloud console > APIs > Drive API > Metrics: during 10 idle minutes with the window in front, expect roughly 40 requests per device (not ~200).
- [ ] No 403/429 errors during normal use. If there are, note the rate.

## 5. Attachments

- [ ] Paste an image into a note on desktop; it appears on the phone.
- [ ] Add a 20 MB PDF (check the size limit setting). It syncs; a second copy of it under another name does not add a second Drive file.
- [ ] Folder `YAOS <vault id> blobs` exists in Drive.
- [ ] Delete one file there by hand. Expected (known limit): other devices cannot download that attachment and the log shows "404"; it is not repaired automatically. Renaming the attachment on the device that has it uploads it again.

## 6. Snapshots

- [ ] Command palette: take a snapshot. Folder `YAOS <vault id> snapshots` has two files for it.
- [ ] Browse snapshots; diff; restore one note.
- [ ] Wait for the next day: one daily snapshot appears (only one even with two devices).
- [ ] Cleanup keeps the newest 14 daily ones and all pinned ones.

## 7. Encryption (new scratch vault)

- [ ] Set a passphrase before the first sync. Sync a note and an image.
- [ ] In Drive, open files in all three folders: nothing readable, attachment names are not their hash.
- [ ] Second device with the same passphrase: everything arrives.
- [ ] Second device with a wrong passphrase: a notice explains; nothing is written to Drive.
- [ ] Second device without a passphrase: a notice says the vault is encrypted.
- [ ] Setting a passphrase on a vault that already exists unencrypted is refused with a clear notice.

## 8. Regression: Cloudflare users

- [ ] A device left on the default carrier (Cloudflare) still syncs, shows the old settings screens (plus the one carrier row), and attachments/snapshots go to R2.
- [ ] Switching to Drive and back to Cloudflare restores the old behaviour.

## 10. Setup wizard (scratch vault, new install)

- [ ] Fresh vault, Cloudflare not set up: Setup > Sync carrier > Google Drive. The wizard opens by itself.
- [ ] Every Google Cloud button opens the right page; the wording matches what you see (the console changes; note any step that is out of date).
- [ ] Paste client ID/secret; the sign-in code appears; approve it on the phone. The wizard moves on by itself.
- [ ] Encryption: leave the passphrase empty (Next blocked), mismatch (blocked), then valid.
- [ ] After "Create": folder `YAOS <vault id>` in Drive holds only `meta.json`; no test file is left.
- [ ] Copy the setup code. Second device: Join my existing vault > paste > sign in. Notes appear.
- [ ] Join with a code made without the passphrase: you are asked for it; a wrong one is refused and nothing is saved.
- [ ] Cancel in the middle (before "Create"): nothing in Drive, settings unchanged.
- [ ] Turn airplane mode on at "Create": a clear message and Try again works.
- [ ] A Cloudflare vault: the settings screen shows no wizard row.

## 12. Beginner view of the Drive settings (scratch vault, any sign-in)

- [ ] Choose Google Drive: the Drive section shows only Status, Sync carrier, Set up Google Drive (and Sign out once signed in). No "This device" group.
- [ ] Signed out: Status points to "Manual setup (advanced)", which is just above Advanced and shows a warning mark.
- [ ] Open it: Vault ID (its text names the `YAOS <id>` folder), client ID/secret, Sign in with Google, passphrase. Change a value and reload: it sticks.
- [ ] Signed in with the easy sign-in: only Vault ID, the sign-in code and the passphrase are listed.
- [ ] Advanced no longer lists Vault ID and no longer mentions deployment.
- [ ] Command palette: "Retry syncing with Google Drive", "Clear local save-confirmation state" and "Reset local cache (re-sync from Google Drive)" exist; its confirmation text says Google Drive. Retry syncing really reconnects.
- [ ] Switch to Cloudflare and reload: the old screen and command names are back, nothing missing.

## 9. Things to report

Latency from edit to arrival (median, worst), any error text shown, Drive request
counts, device model and OS version, plugin build.

## 11. Easy sign-in (scratch vault)

- [ ] Wizard > Start a new vault > "Easy sign-in (recommended)": the page for the code opens from the button.
- [ ] Sign in on the page (note anything confusing: warnings, the shape of the code). Copy the code, paste it: the wizard moves on by itself. A wrong or cut-off code gives a clear message.
- [ ] Encryption, create, setup code (`YAOS-DRIVE2:`). The folder `YAOS <vault id>` appears in Drive.
- [ ] Notes sync both ways with a second device that joined with the code and signed in on the page itself.
- [ ] Settings shows no client ID/secret rows; "Sign-in code (easy sign-in)" shows the code. Pasting nonsense is refused.
- [ ] Leave Obsidian open for over an hour: sync continues (the access token renews through the service).
- [ ] Revoke access at myaccount.google.com/permissions: within a minute a notice says the sign-in was lost; paste a new code in settings and reload: sync resumes.
- [ ] Turn the network off during sign-in-code check: "No connection to the sign-in service" and Try again works.
- [ ] A vault made with your own client still opens with the old way only; nothing about it changed.

## 13. Deleted notes that come back (trace test, scratch vault, two devices)

Purpose: find out which cause is real on your devices. Takes about 10 minutes.

1. On BOTH devices: Settings > YAOS > Advanced > turn on **Debug mode**, then reload Obsidian. Wait until sync is idle.
2. Create a new note `Delete test A` on device 1, type a line, wait 30 s until it appears on device 2. Do not touch it again.
3. On device 1, delete it from the file explorer (note closed). Write down the time.
4. Wait 30 s. Check device 2: is it gone? Then fully close and reopen Obsidian on BOTH devices. Is it back, and on which device first?
5. Repeat with `Delete test B`, but this time create it on both devices before the first sync (turn the network off on both, create a note with the same name on each, turn the network on), then delete it on one device.
6. Repeat with `Delete test C`: type a line on device 1 and delete it within 5 seconds.
7. On each device run the command **Export debug trace** and note where the file is written (`.obsidian/plugins/yaos/` folder; the trace is also kept in `flight-logs/`).
8. Send the two trace files (or just the lines around the delete) with the times you wrote down.

What the trace shows for a note `X`:
- `disk.delete.observed` for `X` on the deleting device and `markdown-tombstoned`: the delete was recorded. If these are missing, the delete was never recorded (it happened before start-up finished, or the event was dropped).
- `delete.remote.observed` then `delete.disk.applied` on the other device: normal. `delete.preserved` (`local-dirty-wins-over-remote-delete`): the other device thought the file was edited.
- A `reconcile.file.decision` / created-on-disk entry for `X` after a reopen: the engine wrote the note back because the document still had it active.

## 14. Delete while YAOS is off (scratch vault, two devices)

- [ ] Both devices have `Offline test A` (created, synced, not edited since). On device 1 turn the YAOS plugin off (Settings > Community plugins), delete the note, turn the plugin on. Within a minute the note is gone on device 2 too and does not return after a restart of both.
- [ ] Same, but before turning the plugin back on, edit the note on device 2. After syncing, the note exists again with device 2's text (an edit wins over an offline delete).
- [ ] Turn the plugin off, create `Offline test B` on device 1 only and never sync it; nothing is deleted. A brand new third device that joins gets every note.
- [ ] With debug mode on, the trace shows `reconcile.file.decision` with `treat-as-local-delete` for the deleted note.


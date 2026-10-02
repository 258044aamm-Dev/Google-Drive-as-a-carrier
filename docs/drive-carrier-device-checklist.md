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

## 9. Things to report

Latency from edit to arrival (median, worst), any error text shown, Drive request
counts, device model and OS version, plugin build.

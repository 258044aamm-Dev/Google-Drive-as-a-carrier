# Drive carrier — device and live-account results (F8)

Every Drive suite in this repo runs against `FakeDrive`, and the repo's own QA
docs say that is not a substitute for a real account. This file is where the
runs that *did* touch real hardware or a real Google account are recorded: one
section per run, with the device, the OS, the plugin version, the date, what was
done, what passed, and what stayed unproven.

Two kinds of run belong here:

1. **Live-account run** — `node --import jiti/register tests/live/drive-real.ts`
   (opt-in, see below). Paste its evidence block into a section.
2. **Device run** — the manual checklist from `docs/qa.md`, executed on a real
   device (desktop, phone, tablet), per the 18 sections listed there.

Nothing in this file is generated: a section exists only after somebody ran it.

---

## How to run the live-account gate

```bash
YAOS_DRIVE_LIVE=1 \
YAOS_DRIVE_CLIENT_ID=… YAOS_DRIVE_CLIENT_SECRET=… YAOS_DRIVE_REFRESH_TOKEN=… \
node --import jiti/register tests/live/drive-real.ts
```

Easy-sign-in token instead of your own client:

```bash
YAOS_DRIVE_LIVE=1 YAOS_DRIVE_REFRESH_TOKEN=<the sign-in code> \
[YAOS_DRIVE_HOSTED_URL=https://…/api/access] \
node --import jiti/register tests/live/drive-real.ts
```

Optional, for the visibility half of the `drive.file` rule:

```bash
YAOS_DRIVE_ALT_REFRESH_TOKEN=<a second account's token> \
[YAOS_DRIVE_ALT_CLIENT_ID / YAOS_DRIVE_ALT_CLIENT_SECRET / YAOS_DRIVE_ALT_HOSTED_URL]
```

The script works in its own folder, `YAOS <vaultId> live-probe`, never in a real
vault folder, and deletes everything it creates. It prints a line per measured
fact and a summary at the end; paste those lines into the section below.

The suite is registered in `tests/suites.json` under `skip` on purpose: it needs
a real token, so the regression run must never pick it up. It is *not* run by
`npm run test:ci`.

---

## What the live script covers (and what it cannot)

| Probe | Why it matters | Modelled today by |
| -- | -- | -- |
| create → listed latency | the transport's 60 s `listingGraceMs` assumes a write can be missing from a listing for a while | `FakeDrive.hideFromListing`, `FakeDrive.listingLagTicks` |
| delete → gone latency | a vanished file sets `remoteDirty`; the repair path must not thrash | same |
| two files with one name | the folder is addressed by name, not id | `FakeDrive` allows duplicates |
| `size` echo from Drive | progress and "already stored" decisions read it | `FakeDrive` |
| multipart ceiling (4 MB / 5 MB) | F11's resumable threshold must sit below Drive's real limit | scripted HTTP double in `drive-carrier-large-transfer.ts` |
| 6 MB resumable round trip | the resume path against real Google | same suite, scripted double |
| error bodies (404 / 401 / dead token) | the retry and re-auth classification | `failNext(op, status)` |
| 403 rate-limit body | backoff behaviour | **not covered** — provoking Google's rate limiter would abuse the account; the shape stays unverified until it happens in the field |
| `drive.file` invisibility between two clients | why a vault cannot be opened with a different sign-in | not modelled; needs the alt token |
| attachment round trip through `DriveBlobStore` | one layer above the raw API | `drive-carrier-blobs.ts` |

---

## Run 1 — (not yet recorded)

Status: **not run — accepted for 2.1.23.** The live-account probe was deferred by
the maintainer on 2026-10-11 ("skip for now") and, asked again at the release
gate, deliberately left unrun so that 2.1.23 can ship: the fake-Drive suites stay
the only automated evidence for the Drive data path, and the release notes must
say so. Nothing here counts as observed. When the gate is finally run — by anyone
with a Google account and the client id/secret — its printed numbers (listing
latency, the multipart ceiling, byte totals) get pinned into
`FakeDrive.listingLagTicks` and the tables above, and this section stops saying
"accepted".

---

## Device checklist sections (from `docs/qa.md`)

Each device run records these, with the plugin version and the date:

| # | Section | What a pass means |
| -- | -- | -- |
| 1 | Fresh install, easy sign-in | wizard completes, first folder appears in Drive |
| 2 | Fresh install, own Google client | device sign-in works, folder appears |
| 3 | Second device joins with the setup code | vault appears without a second sign-in for the same client |
| 4 | Encrypted vault, two devices | a wrong passphrase stops cleanly; the right one syncs |
| 5 | Rename the vault folder in Drive | the same folder keeps being used (F5) |
| 6 | Duplicate folders in Drive | one is named, the newest is used, none deleted (F5) |
| 7 | Empty vault folder + big local document | warned before uploading (F5) |
| 8 | Delete a file on one device | the deletion propagates, offline-delete policy intact |
| 9 | Edit the same line on two devices | both converge, no lost edit (SYNC-01/02 suites) |
| 10 | Attachments: add, sync, delete the note | attachment syncs; audit command lists, never deletes (F6) |
| 11 | Restore points: take one, restore it | snapshot round trip on the device |
| 12 | Compaction on a large vault | the changes list stays short; bytes written match the meter (F1) |
| 13 | Airplane mode for a day | edits queue, then upload once; no duplicate folders |
| 14 | Revoke access in Google | sync stops cleanly with an action, re-sign-in recovers |
| 15 | Phone: background the app | polling pauses, edits still reach Drive when it returns |
| 16 | Two windows on one computer | one transport per vault, no double uploads |
| 17 | Quit with edits in flight | nothing is lost (F6 "closing the app sends what is still waiting") |
| 18 | Uninstall / reinstall | the vault is found again by id (F5) |

A device run may cover any subset; record which sections were covered and which
were not, so the gaps stay visible instead of implied.

> **Status at 2.1.23 (2026-10-11).** This is the plan the review produced, committed for
> the record. Findings F1, F2, F5, F6, F7, F9 and F11 are implemented and covered by
> suites; F4 is implemented fully, including the passphrase rule (decision 1:
> mandatory); F3 and F10 are done in this release. F8's gate
> (`tests/live/drive-real.ts`) and its run record exist, but the real-account run was
> **deferred and accepted unrun for 2.1.23** — see
> [drive-carrier-device-results.md](drive-carrier-device-results.md). Decisions 2, 3,
> 5 and 6 were taken as the plan recommends; decision 4 is carried by the plugin
> description shipped in this release.

# Fix plan — YAOS Drive carrier hardening, target release **2.1.23**

**Source of findings:** `yaos-drive-carrier-deep-analysis.md` (deep review of `258044aamm-Dev/Google-Drive-as-a-carrier` @ `16140ff`, branch `google-drive-carrier`, plugin 2.1.22)
**Plan status:** PLAN ONLY — no source file has been modified. `git status` in the clone is clean apart from build output.
**Linear:** project *YAOS Drive carrier — hardening & 2.1.23* → tracking issue → 4 phase issues (Code_Bro / `COD`).

---

## 0. Decisions taken (from your answers + the one you delegated)

| Question | Decision |
|---|---|
| Scope | **All 10 findings (F1–F10)** plus **F11**, discovered while writing this plan |
| Linear structure | **Tracking issue + 4 phase issues** (one per phase, parented to the tracking issue) |
| Where fixes land | **This fork only**, released as **2.1.23** on `google-drive-carrier`. No upstream PRs in this plan |
| Behaviour-change policy | **Split by kind** (my recommendation): *safety/correctness* fixes default-on; *cost/behaviour-changing* fixes default-on **only where provably no worse than 2.1.22 for writes**, otherwise behind a setting that restores 2.1.22 exactly |

**Why "split by kind" and not "conservative — opt-in only":** the repo's own changelog shows the maintainer already moves defaults when the change is confined and verifiable ("Engine step 1/2/3 … applies to Cloudflare too. Chosen on purpose"), and the two worst findings (F2, F6) lose most of their value if they are opt-in — nobody turns on a schema guard. Conversely the pure-cost items (F1 thresholds, F6 retention count) stay switchable so a metered user can restore exact 2.1.22 byte behaviour. Every item below is tagged **DEFAULT-ON** or **OPT-IN**, so you can flip any individual decision without re-planning.

---

## 1. Scope

**In:** the Drive carrier (`src/drive-carrier/`), the shared engine deltas the carrier depends on (`src/sync/transport.ts`, `src/runtime/reconcile/*`, `src/main.ts` wiring), the LAN carrier **only** where it shares the same gap (F2), the Drive test suites and `FakeDrive`, the real-Drive evidence script, and the docs the findings name.

**Out (deliberately):**
- no `server/` behaviour change (Cloudflare stays byte-identical except where the shared engine change is a pure addition);
- no P2P work (`p2p-implementation` branch untouched);
- no config-sync preview feature work (419 LOC feature stays as shipped, default off);
- no encryption-format, CRDT-schema, or Drive file-format version bump (all fixes are additive; see §7);
- no attempt to make Drive a real-time carrier (polling model unchanged).

---

## 2. Phase map, dependencies, sequencing

```
Phase 1  Safety blockers            (F2, F5, F6, F11)         ← release gate 2.1.23
   │
   ├──► Phase 2  Cost & memory      (F1, F7)                 ← F1 changes the compaction
   │                                                            engine F7 evicts from
   │
   ├──► Phase 3  Trust, evidence,   (F4, F8, F9)             ← F8's probe is the instrument
   │        hardening                                          that confirms F11 (Phase 1)
   │
   └──► Phase 4  Docs, positioning, (F3, F10, onboarding,     ← blocked by 1, 2, 3
            release 2.1.23           release runbook)
```

| Phase | Theme | Findings | Linear priority | Why this order |
|---|---|---|---|---|
| **1** | Data-safety blockers | F2, F5, F6, **F11** | Urgent (1) | F2 can silently mix schemas; F6 has an unrecoverable tail; F11 can block sync entirely for vaults >5 MB. All are release gates. |
| **2** | Cost & memory | F1, F7 | High (2) | Same subsystem, same measurement instrument. F1's tiered compaction *reduces* file count, which makes F7's eviction simpler — do F1 first. |
| **3** | Trust, evidence, code hardening | F4, F8, F9 | Medium (3) | F8's real-Drive script is genuinely useful earlier (it validates F11), so start it in parallel with Phase 1 and finish it here alongside F4/F9. |
| **4** | Docs, positioning, release | F3, F10, onboarding, runbook | Low (4) | F3 can start any time (docs only). The release runbook must be last. |

**Parallelisation:** F3 (docs truth) and F8's script have no dependency on Phase 1 code and can begin immediately. Everything else in Phase 2+ assumes Phase 1 has landed (the compaction engine F1 rewrites is the same code F6 adds verification to).

**Effort:** ≈ 15–18 engineering days + 2 manual device sessions. Suggested calendar: Phase 1 → 2 weeks, Phase 2 → 1 week, Phase 3 (with manual runs) → 1 week, Phase 4 → 2 days. Project target date 2026-11-08.

---

## 3. Phase 1 — Data-safety blockers

### F2 — CRDT schema admission on the Drive and LAN paths
**Severity: high (silent mixed-schema sync at the next schema bump).**

**Evidence.** `checkSchemaVersion()` is called exactly once, at `src/main.ts:1119`, *before* `waitForProviderSync()` at `:1148`. On Cloudflare the Worker rejects a schema mismatch at socket admission and the client reacts to the fatal frame immediately after that wait. The Drive transport polls *inside* `connect()`, so the first remote update is applied after the one and only check. `DRIVE_LAYOUT_SCHEMA` (`driveKeyring.ts`) guards the *file layout*, not the CRDT schema, and nothing re-checks after the first poll.

**Approach (three layers, all additive).**
1. **Re-check after the first sync** — in `main.ts`, immediately after `waitForProviderSync()` resolves, call `checkSchemaVersion()` again; on failure route to the existing `showFatalSyncNotice()` + `updateStatusBar("error")` path and return *before* reconciliation. Covers all three carriers.
2. **Carrier-level guard (stops writing, not just warns)** — add an optional `guardSchema?: () => string | null` to `DriveTransportOptions` (and the LAN transport's equivalent). Called (a) in `markOnline()` before `synced: true` is emitted and (b) once at the start of `pollLocked()` before the first `applyDownloaded()`. A non-null result follows the existing `FatalCarrierError` route: `fatalError` set, timers cleared, `markOffline()`, `onFatal(message)`, **no further uploads**.
3. **Engine assistant** — `VaultSync` exposes `schemaAdmissionError(): string | null` (thin wrapper over `checkSchemaVersion()` plus the stored/supported numbers) so carriers and `main.ts` share one source of truth.

**Files:** `src/main.ts` (≈15 lines), `src/sync/vaultSync.ts` (+1 getter), `src/drive-carrier/driveTransport.ts` (~20 lines), `src/drive-carrier/driveCarrierRuntime.ts` (wire the guard), `src/lan-carrier/lanTransport.ts` + runtime (same 20 lines), `src/sync/transport.ts` (doc comment only if the option lives on the carrier, **not** on `SyncTransport`).

**Tests (new suite `tests/client/schema-admission-carriers.ts`):**
- FakeDrive pre-seeded with `sys.schemaVersion = SCHEMA_VERSION + 1` → the connecting device must set `fatalError`, never emit `synced: true`, and **write zero files** (assert `drive.calls.createFile === 0` after connect + two `syncNow()` cycles).
- LAN rig equivalent (reuse `tests/mocks/lanRig.ts`).
- No false positive: a schema-2 document and a schema-3 document must both connect normally.
- Regression: the existing Cloudflare admission suites (`ws-admission-protocol`, `schema-guard`) stay green.

**Acceptance.** With a newer schema present remotely: zero writes, `synced` never true, user-visible notice naming both version numbers, and the plugin does not reconcile. **DEFAULT-ON.**

**Risk/rollback.** No format change, no migration. Reverting the commit restores today's behaviour exactly.

---

### F5 — Split-brain detection and folder identity
**Severity: medium (silent divergence or expensive surprise re-upload; no data loss).**

**Evidence.** `prepareFolder()` resolves the vault folder **by name only** (`findFolders(this.opts.folderName)`), and the resolved id is never persisted (`carrierSettings.ts` has no folder field). Consequences: (a) renaming `YAOS <id>` on drive.google.com makes `findFolders` return nothing → a **new empty folder is created**, and repair then uploads the whole local document into it; (b) two devices active in one folder are only handled for the *creation race*, not for a genuine duplicate. Separately, because the easy sign-in and a private client see disjoint file sets under the `drive.file` rule, two devices set up with different clients create *two same-named folders* and both report "synced".

**Approach.**
- **F5a — persist folder identity.** Add `driveFolderId` to settings; write it after `prepareFolder()` resolves. On start, validate it with a new `DriveApi.getFile(id)` (REST `files/{id}?fields=id,name,trashed`) and use that folder directly. Drive file ids survive rename and move, so a renamed folder is simply found again — no second folder, no re-upload.
- **F5b — duplicate detection.** When `findFolders` returns more than one candidate (or the stored id vanished while a same-name folder exists), read up to 5 candidates' `meta.json` and compare the new `installId` (F5d) plus `vaultId`. Deterministic choice stays "oldest, then lowest id"; the difference is that a **notice + trace** now says "another YAOS folder for this vault exists — using the oldest one".
- **F5c — join-time and first-poll mismatch guards.** (i) Wizard: refuse to finish a join when the pasted code's sign-in mode (`YAOS-DRIVE2:` = easy) differs from the device's chosen mode, explaining the `drive.file` visibility rule — today the wizard silently adopts the code's mode, which only works on the code path, not for a manually typed vault id. (ii) First poll: if the resolved folder is **empty** and the local IndexedDB document is large (> 1 MB), surface a one-time warning *before* the first upload ("this device found an empty vault folder; local state is about to be uploaded"), which is exactly the signature of the client-mismatch split-brain.
- **F5d — `installId` in `meta.json`.** Random id written once when the vault folder is created; distinguishes "same vault, duplicate folder" from "same name, different vault". Additive: readers that do not know the field ignore it.

**Files:** `src/drive-carrier/carrierSettings.ts`, `driveFolders.ts`, `driveTransport.ts` (`prepareFolder`), `driveKeyring.ts` (`meta.json` shape), `driveApi.ts` + `googleDriveRest.ts` (`getFile`), `wizard/wizardController.ts` (+ screens text), `src/main.ts` (settings row for the folder id, read-only).

**Tests (new suite `tests/client/drive-carrier-folder-identity.ts`):**
- `FakeDrive` gains `rename(name, newName)`, `trash(name)` and `getFile(id)` — small, and it makes these scenarios testable at all.
- Rename the folder on the fake Drive → transport keeps using it (stored id), creates no second folder, uploads nothing new.
- Two folders, same name, same `installId` → deterministic choice + warning trace; nothing deleted.
- Stored folder trashed, local state present → new folder created, warning emitted, repair uploads only the missing state.
- Empty folder + 2 MB local document → warning, then normal behaviour.
- Wizard: hosted code + own-client mode → refusal with the explanation (extend `drive-carrier-wizard-flow`).

**Acceptance.** Renaming the folder never creates a second one and never re-uploads the vault. Duplicates are detected, reported and never deleted. A client-mode mismatch is refused at join time when detectable, and announced at first poll when it is not. **DEFAULT-ON** (detection and id persistence are both non-destructive).

---

### F6 — Snapshot retention and verify-before-delete
**Severity: medium (the only unrecoverable tail risk in the carrier).**

**Evidence.** `KEEP_SNAPSHOTS = 2` (`driveTransport.ts:91`) — of which one is the snapshot just written, so exactly **one** spare is retained. `compactLocked()` deletes covered segments *immediately* after `createFile` returns, with only a size comparison performed at upload time. `files.delete` in Drive v3 is **permanent** (no trash). Two unreadable files (the just-written snapshot and the spare) therefore leave the pre-compaction history only on the devices. Attachment blobs are never garbage-collected (documented).

**Approach.**
1. **Verify before prune** — after the compaction snapshot is uploaded, read it back, `decodeFile()` it, verify the payload SHA-256 and that `Y.encodeStateVector(decoded)` equals `Y.encodeStateVector(doc)`; only then delete the covered segments. On failure: keep every segment, log/trace, retry on the next compaction cycle (bounded by `MIN_COMPACT_GAP_MS`). Cost: one download per compaction — compaction is already gated by ≥1 MB of segments and a 30 s minimum gap.
2. **Retention count** — `KEEP_SNAPSHOTS` becomes configurable, **default 4** (range 2–10) via `syncPaceCustom.driveKeepSnapshots`. Four is chosen because it costs one extra doc-sized upload per compaction while removing the "one spare" cliff; 2 restores 2.1.22 exactly.
3. **Restore-point pruning safety** — `driveSnapshotBackend.prune()` must not remove an unpinned snapshot unless at least one *newer* retained snapshot has a readable index (cheap check, index only) — i.e. never prune down to a set whose newest readable snapshot is the one being deleted. Retention count (14 unpinned) is unchanged.
4. **Attachment GC (OPT-IN)** — new command **"YAOS: Find unused attachments on Drive"**: dry-run lists blobs unreferenced by the live document **or** by any retained snapshot index (`referencedBlobHashes` already exists in `SnapshotIndex`). A second explicit confirmation is required to delete. Not automatic, ever. Docs updated (they currently say no GC exists).

**Files:** `src/drive-carrier/driveTransport.ts` (`compactLocked`, `KEEP_SNAPSHOTS` → option), `driveSnapshotBackend.ts` (`prune`), `driveBlobStore.ts` (+`list()` for GC), `src/settings/syncPace.ts` (new custom fields), `src/settings/settingsTab.ts` (rows), `src/main.ts` (command), `docs/drive-carrier.md`.

**Tests (new suite `tests/client/drive-carrier-retention.ts`):**
- Corrupt the just-written snapshot in the fake before readback → assert **zero** `deleteFile` calls for segments, error surfaced, and that the next cycle retries and succeeds once the fake is healthy again.
- Kill between snapshot write and segment delete (failNext delete 503) → segments remain, snapshot remains, next cycle completes.
- `driveKeepSnapshots` honoured at 2 / 4 / 10; snapshot list ordered by Drive `createdTime` (existing behaviour preserved).
- Restore-point prune: newest readable snapshot is never deleted; an unreadable newest index keeps the older ones.
- GC dry-run: a blob referenced only by an old pinned snapshot index is **not** listed as unused; a truly orphaned blob is listed and only deleted on the explicit confirm path.

**Acceptance.** With an unreadable new snapshot, zero deletions occur anywhere in the vault folder; pruning never removes the last readable snapshot of either kind; GC never deletes a blob reachable from live state or any retained snapshot. **Verify-before-prune DEFAULT-ON** (escape hatch `driveVerifyBeforePrune: false` for metered users), **retention default 4** (documented as cost-affecting), **GC OPT-IN**.

---

### F11 — Uploads above Drive's multipart limit *(new finding, found while planning)*
**Severity: high if confirmed — potentially blocks large vaults entirely.**

**Evidence.** `googleDriveRest.ts:151` always uploads with `uploadType=multipart`. Google documents simple and multipart uploads for files **≤ 5 MB** and recommends **resumable** beyond that ([Drive upload docs / community reports](https://stackoverflow.com/questions/60558516/google-drive-api-multipart-upload-gets-file-corrupted-size-1kb)). Payloads above 5 MB are not hypothetical here: a compaction snapshot is the whole document, a fresh device's first reconcile uploads the whole difference, and attachments can be up to the configured cap (default 10 MB via `maxAttachmentSizeKB`). If the limit is enforced, a vault whose document exceeds ~5 MB could never join a second device — the reconcile upload would fail forever and the carrier would report a retryable error while looking "connected".

**Approach — verify first, then fix (this is why F8's script starts in Phase 1).**
1. **Measure.** A minimal probe against a real Drive folder uploads fixed-size payloads (1, 4, 5, 8, 16, 32 MB) via the current multipart path and records the exact status/body of any refusal. Output goes into the evidence file.
2. **Fix regardless of the measurement** (it is cheap and strictly more capable): add `uploadType=resumable` for bodies above a threshold (`RESUMABLE_THRESHOLD = 4 MB`): initiate with `POST /upload/drive/v3/files?uploadType=resumable`, then a single `PUT` of the bytes to the session URI; keep the existing `size` verification and treat 5xx/`403 rateLimitExceeded` as retryable. Below the threshold the multipart path is unchanged.
3. **Make it testable.** `FakeDrive` gains a configurable `multipartLimitBytes` (default 5 MB) that refuses larger multipart bodies the way Drive does, so CI covers the resumable branch permanently.
4. **Document the measured limit** in `docs/drive-carrier.md` under limits.

**Files:** `src/drive-carrier/googleDriveRest.ts` (resumable path), `driveApi.ts` (unchanged interface), `tests/mocks/fakeDrive.ts` (limit), `docs/drive-carrier.md`.

**Tests (`tests/client/drive-carrier-rest.ts` + `drive-carrier-transport.ts`):**
- 12 MB snapshot uploads through the resumable branch, FakeDrive enforces a 5 MB multipart limit, and the file arrives intact.
- A refused multipart body yields a clear error naming size and limit (never a silent retry loop).
- `createFile` under the threshold still uses exactly one multipart request (no extra round-trip regression).
- A >5 MB document round-trips: device A creates it, fresh device B reconstructs it from Drive alone.

**Acceptance.** The real-Drive probe records the actual limit; whatever it shows, a ≥16 MB document can be created and re-joined end-to-end. **DEFAULT-ON** (transport correctness; strictly more capable than today).

---

## 4. Phase 2 — Cost and memory

### F1 — Compaction write amplification (`measured ×28`)
**Severity: medium (quota, cost, latency — no data loss).**

**Evidence (measured, reproducible).** Compaction uploads `Y.encodeStateAsUpdate(doc)` — the whole document — whenever applied segments exceed 1 MB. Probe (`analysis/probe-compaction-amplification.ts`, output in `analysis/probe-results.txt`):

| document | new content | segments | snapshots | bytes after bootstrap | amplification |
|---|---|---|---|---|---|
| 1.04 MB | 0.30 MB | 0.31 MB | 1 × 1.04 MB | 1.35 MB | ×4.4 |
| 8.29 MB | 0.30 MB | 0.31 MB | 1 × 8.30 MB | 8.61 MB | **×28.2** |
| 8.29 MB | 3.00 MB | 3.00 MB | 3 × 28.62 MB | 31.62 MB | ×10.5 |

The first reconcile after install/restart additionally writes the full local state once per device. The request meter counts **calls**, never **bytes**.

**Approach — tiered compaction (replace the single absolute trigger).**
- **Tier A — merge, don't snapshot (the new default).** When the trigger fires, first merge the applied segments into **one merged segment** with `Y.mergeUpdates(payloads)` and delete the originals. Merged bytes ≈ the sum of the inputs, **not** the document size, so this bounds file count (listing cost) and `known` size (helps F7) at ~1× amplification.
- **Tier B — snapshot only when it pays.** Upload a full snapshot only when it actually reduces stored bytes: `encodeStateAsUpdate(doc).length ≤ 0.6 × Σ(live segment bytes)`, with a 1 MB floor on live segments and a configurable ceiling on snapshot size.
- **Triggers stay bounded in both directions:** `compactSegmentCount` remains a hard cap (raised 50 → 200, which bounds listing pages and `known` growth); `compactSegmentBytes` becomes the floor for tier selection rather than a snapshot trigger.
- **Measure bytes, not just calls:** extend `MeteredDriveApi` with `bytesWritten` / `bytesRead` (per operation), surface them in `requestStats()` and diagnostics.
- **Escape hatch:** `syncPaceCustom.driveCompaction: "adaptive" | "legacy"` (default `adaptive`); `legacy` restores exact 2.1.22 behaviour.

**Target:** the ×28.2 row must drop to **≤ ×2**; the ×10.5 row to ≤ ×3. Asserted in CI, not measured by hand.

**Files:** `src/drive-carrier/driveTransport.ts` (`maybeCompactLocked`, `compactLocked`), `requestMeter.ts`, `driveCarrierRuntime.ts`, `src/settings/syncPace.ts` + `settingsTab.ts`, `drive-carrier.md` (cost section).

**Tests:** promote the probe to a permanent suite `tests/client/drive-carrier-compaction-cost.ts`: the four measured configurations become assertions with ceilings; property test over document sizes 1/4/16 MB × edit sizes 8 KB/256 KB; assert `known` size and Drive file count stay bounded; assert convergence unchanged (existing fuzz suite must stay green, including 4-device + clock-skew configurations); assert `legacy` reproduces 2.1.22 bytes bit-for-bit on a fixed scenario.

**Risks/rollback.** `mergeUpdates` CPU on 200 segments — merge in chunks of ≤50. Naming: the merged segment must sort as the *newest* input so the deterministic progress ordering is preserved. Rollback: setting, no migration. **DEFAULT-ON** (adaptive can only reduce or equal bytes written; the chunked merge is the only new CPU cost, bounded and off the interactive path).

---

### F7 — Memory bounding
**Severity: medium (phones; documented but unbounded).**

**Evidence.** `known` retains the payload of every applied file; `remoteState` is a merged update of all of them; plus a doc-sized snapshot buffer per retained snapshot. `docs/drive-carrier.md` admits "memory use grows with vault size (every applied update payload and two snapshots are kept in memory)".

**Approach.**
- Retain a payload only while it is needed to rebuild `remoteState`: drop it once a later applied snapshot/merged segment covers it (tiered compaction from F1 makes this common), and enforce a hard `maxRetainedPayloadBytes` (default 32 MB) with oldest-first eviction.
- `remoteDirty` rebuild (rare: a file vanished between listing and read) becomes "merge the payloads still retained, re-download any that were evicted and are still on Drive" — bounded by one listing.
- Expose `retainedPayloadBytes`, `knownFiles` and the existing `unreadableFiles` in diagnostics; add a `get retainedPayloadBytes()` accessor for tests.

**Files:** `src/drive-carrier/driveTransport.ts` (payload lifecycle, `rebuildRemoteIfDirty`), `driveCarrierRuntime.ts` (diagnostics), `docs/drive-carrier.md`.

**Tests (`tests/client/drive-carrier-memory.ts`):** apply 3× document size of updates in a large document → `retainedPayloadBytes ≤ maxRetainedPayloadBytes` at every step; force the `remoteDirty` path with evicted payloads and assert the document still converges; the fuzz suite's "Drive alone reproduces the document" assertion must still hold from a cold device.

**Acceptance.** Bounded payload retention with unchanged convergence; no new unbounded buffer introduced. **DEFAULT-ON** (pure resource bound).

---

## 5. Phase 3 — Trust, evidence, code hardening

### F4 — Hosted sign-in hardening
**Severity: medium, partially by design and disclosed.**

**Evidence.** `resolveHostedTokenUrl()` (`hostedAuth.ts`) returns `override?.trim() || HOSTED_TOKEN_URL` with no scheme or shape validation, so a `driveHostedUrl` of `http://…` (or a typo) would send the refresh token in cleartext. The easy sign-in is the wizard's recommended path and necessarily places the refresh token with a third-party service on every access-token refresh.

**Approach.**
1. **Require `https:`** in `resolveHostedTokenUrl` — throw a clear, user-facing error for anything else (wizard, runtime, and join validation all route through it). Trim and reject relative/empty-with-scheme inputs.
2. **Disclose a custom endpoint loudly** — when `driveHostedUrl` is set, the settings row and the wizard say exactly which host will receive tokens (the machinery for showing custom origins already exists for the wizard).
3. **Change detection** — if the configured endpoint differs from the one used previously, re-validate it before the first token refresh in the session and trace the change.
4. **[NEEDS YOUR CALL — see §9, decision 1]** make a passphrase **mandatory** when `driveAuthMode === "hosted"` (the wizard already defaults encryption ON and the docs already say "turn encryption on" for this path; making it structural removes the only case where a third party holds a token *and* the data is plaintext on Drive).

**Files:** `src/drive-carrier/hostedAuth.ts`, `wizard/wizardController.ts` (+ `screens.ts` text), `settingsTab.ts`, `main.ts` (hosted sign-in completion), `docs/drive-carrier.md`.

**Tests (`tests/client/drive-carrier-hosted.ts` additions):** `http://` endpoint refused at wizard, runtime and join; `https://` custom endpoint accepted and traced; existing "never silently fall back to a second service" tests still green; (if decision 1 lands) wizard cannot complete easy sign-in without a passphrase, and the private-client path is unaffected.

**Acceptance.** No code path can send a refresh token to a non-HTTPS endpoint; a custom endpoint is always named where the user can see it. **DEFAULT-ON** for items 1–3 (pure safety, no UX loss).

---

### F8 — Real-Drive evidence and permanent modelling
**Severity: evidence gap (the repo's own QA docs name this as the missing proof).**

**Evidence.** All Drive suites run against `FakeDrive`; the repo itself says fake-Drive tests "are not substitutes" and keeps a 17 KB manual checklist whose results are not recorded in-tree. `FakeDrive` cannot model listing lag after create/delete, real 403 rate-limit bodies, `drive.file` cross-client invisibility, duplicate names, or the multipart size limit (F11).

**Approach — three deliverables.**
1. **`tests/live/drive-real.ts`** — env-guarded (`YAOS_DRIVE_LIVE=1` plus client id/secret/refresh token/vault id), registered in `tests/suites.json` under `skip` with a reason string (the repo's existing convention), asserting: create→list visibility latency (validates the 60 s `listingGraceMs`); delete→list disappearance; duplicate names permitted; `size` echo; the multipart limit probe (feeds F11); `403` body shape; `drive.file` invisibility between two clients; an above-threshold resumable upload; a large attachment round-trip.
2. **`docs/drive-carrier-device-results.md`** — the 18-section device checklist recorded per run (device, OS, plugin version, date, result, notes), plus an update to `docs/qa.md`'s "Still missing" list stating what the run did and did not prove.
3. **Feed measurements back into the fake** — encode the measured limits (multipart ceiling, realistic listing lag, rate-limit body shapes) as `FakeDrive` defaults so CI keeps testing reality instead of a friendly fake.

**Acceptance.** The script runs green against a real Google account and its output is committed as evidence; the fake models the measured limits; `docs/qa.md` no longer lists Drive evidence as missing *for the covered scenarios*. **DEFAULT-ON** (tests/docs only).

---

### F9 — Code hardening (six small items)
All OPT-IN-free, all internal. Each is independently landable.

| # | Item | Detail | Test |
|---|---|---|---|
| 9a | **Stop pinning Yjs internals** | `isComplete()` reads `doc.store.pendingStructs`/`pendingDs`. Keep them as a fast path but add a state-vector comparison (union of applied payloads vs `encodeStateVector(doc)`) and type the internals access through one guarded module so a Yjs upgrade cannot silently flip "incomplete" to "complete". | A guard test that fails if the internals shape disappears, plus a test that the completeness result is identical with and without the internals path. |
| 9b | **Session-tagged file names** | Same-millisecond + counter-reset collisions across restarts can produce twin file names (harmless but noisy re-downloads). Append the already-computed session epoch after the counter, keeping the 13-digit ms prefix for ordering. | Restart twice inside one fake-millisecond; assert distinct names, ordering unchanged, no duplicate-name churn. |
| 9c | **Clock seam** | `DriveTransport` calls `window.setTimeout` directly. Inject a scheduler (default `window`) so the carrier is host-agnostic like the LAN carrier's node imports. | Constructor default equals `window` behaviour; a fake scheduler drives a full cycle deterministically. |
| 9d | **Document the unauthenticated header** | Kind/flags/name are outside the payload hash and unauthenticated. I verified all consequences fail closed (kind flip → re-applied as a valid update; flag flip → encryption mismatch → corrupt; cross-vault copy → AAD mismatch → corrupt). | Table-driven test proving each flip/move is rejected or harmless; a comment in `fileFormat.ts` stating the argument. |
| 9e | **Blob integrity: keep as-is, document why** | Attachments are raw bytes named by their hash, verified on download — equivalent to a header checksum. No change; document the reasoning where the format is described. | Existing blob suite unchanged. |
| 9f | **Lint hygiene** | Resolve the two `import/no-extraneous-dependencies` warnings (`lib0`, `y-protocols` are transitive of `yjs`) by declaring them in `devDependencies`; do not add runtime weight. | Full lint: 0 errors, warnings strictly fewer than the current 28. |

---

## 6. Phase 4 — Docs, positioning, release

### F3 — Restore documentation truth *(can start immediately)*
**Evidence.** `docs/BACKLOG.md` still states SYNC-01 is "Known failing behavior hidden as an expected failure" and SYNC-02 an "Open correctness gap"; `docs/sync-contract.md` §65/§92 still call the offline-delete case a "known violation". Both are **fixed in this branch**: `offlineDeletePolicy.ts` implements SYNC-01's rule *including* the `diskPresentCount === 0` guard and the >20-count / >25 % batch brake, `boundDivergencePolicy.ts` implements SYNC-02, `qa/controllers/two-device.ts:1911` now fails hard instead of logging, and `engine-offline-delete` / `engine-bound-both-changed` / `engine-tombstone-age` pass.

**Approach.** Move SYNC-01 to a resolved section (commits + suite ids + evidence); restate SYNC-02 as "resolved in code — real-device closure still tracked as QA-03"; rewrite `sync-contract.md` §§65/92 as implemented behaviour pointing at the two policy modules; update the `qa.md` evidence table. Add **`tests/contracts/docs-claim-drift.ts`**: a small guard that fails when a phrase belonging to a resolved item (mapping table in the test) reappears while its regression suite exists. Commit this plan as `docs/drive-carrier-fix-plan.md`.

**Acceptance.** No document claims a fixed defect is still open; the guard fails if a stale phrase is reintroduced. **DEFAULT-ON.**

### F10 — Positioning and onboarding
- `manifest.json` / `package.json` description: replace "powered by your own Cloudflare Worker" with wording covering the optional carriers (note: this is the text shown in the community-plugin listing — a user-visible change, see §9 decision 4).
- README: add a carrier matrix (Cloudflare default / Google Drive experimental, off by default / Local network desktop-only), keeping the honest limitations.
- Onboarding papercut found during the review: a fresh clone fails 1 of 134 suites until `npm ci --prefix server` is also run (needs `miniflare`). Document it in the README and `docs/qa.md`.
- `docs/README.md`: refresh the doc list (new: fix plan, device results).

### 2.1.23 release runbook
1. Version bump: `manifest.json`, `package.json`, `versions.json` (2.1.23), tag `2.1.23` (the scheme this fork settled on after the BRAT mismatch).
2. Changelog entry per the fork's format: each item, its evidence, and an explicit "what is still unverified" section (manual real-account/Android runs).
3. Gates: `npm run build`, `typecheck:tests`, `typecheck:qa`, all six guards, full lint (0 errors, warnings ≤ today's 28), `test:regressions` (134 + new suites), `test:integration:worker` (local Wrangler), and the F8 real-Drive script.
4. Reference `docs/drive-carrier-device-results.md` for the manual runs actually performed.
5. Release notes: normal GitHub release, **TEST RELEASE** in the title, marked Latest, not a prerelease — matching 2.1.20–2.1.22.
6. Explicitly no CRDT-schema bump, no encryption-format change, no Cloudflare server change.

---

## 7. Cross-cutting: what must not change

Any fix that would require one of these is out of scope for 2.1.23 and must be re-planned:

- **CRDT schema version** stays 3 (`guard:schema-version` pins it).
- **Drive file format** (`YDS1`, 40-byte header) stays version 1; every change above is additive (new `meta.json` field, new settings, new names for merged segments are still `seg-*.ydu`).
- **Encryption format** stays `SEAL_FORMAT = 1`; purposes unchanged. No re-keying, no re-sealing, no migration of existing vaults.
- **Cloudflare path** behaviour unchanged: F2's carrier guard is inert when the transport is the Worker provider, and the re-check in `main.ts` can only *refuse earlier*, never correct or rewrite.
- **Off-by-default discipline**: with `carrier !== "drive"`, no new code path runs, no settings are written (mirroring the existing "nothing is stored until you pick a different speed" rule).

---

## 8. Risk register

| Risk | Where | Mitigation | Rollback |
|---|---|---|---|
| Tiered compaction merges too eagerly (CPU spike on 200 segments) | F1 | chunk merges at ≤50; keep the count cap as the only hard trigger for tier A | `driveCompaction: "legacy"` |
| Verify-before-prune doubles Drive read traffic during compaction | F6 | compaction already rate-limited (≥1 MB, ≥30 s); escape hatch `driveVerifyBeforePrune: false` | setting |
| Retention 4 raises a user's Drive usage | F6 | one extra doc-sized file per compaction; documented as cost-affecting | `driveKeepSnapshots: 2` |
| Resumable upload adds a second round-trip for large files | F11 | threshold at 4 MB, multipart below it unchanged | revert threshold constant |
| Payload eviction breaks the `remoteDirty` rebuild | F7 | re-download fallback + fuzz suite's cold-device assertion | revert eviction, keep the bound |
| Schema guard false-positives and blocks a working vault | F2 | two negative tests (schema 2, schema 3 both connect) | revert commit |
| Folder-id persistence follows a folder the user moved into another account/share | F5 | validate with `getFile`; if it is gone, fall back to the name search | delete the settings field, name search still works |

---

## 9. Decisions I need from you before/while building

1. **Easy sign-in: require a passphrase?** (F4 item 4) — recommend **yes**: it removes the only configuration where a third party holds a token *and* notes are plaintext on Drive. Cost: one extra field on the easiest path; the private path is unaffected.
2. **Retention default 4 or keep 2?** (F6) — recommend **4**, with the setting. Cost: one extra doc-sized upload per compaction.
3. **Adaptive compaction default-on?** (F1) — recommend **yes** (it can only reduce bytes written), with `legacy` available. Alternative: ship `legacy` as the default for one release and flip later.
4. **Marketplace description change** (F10) — the `description` string is the public listing text; changing it may trigger a plugin-list update review. Recommend **yes**, but tell me if you would rather keep the listing text frozen.
5. **Attachment GC in 2.1.23?** (F6 item 4) — recommend **dry-run command only** in 2.1.23, deletion in a later release once the dry-run output has been eyeballed on a real vault.
6. **LAN carrier included in F2/F5?** — recommend **yes** (same ~20 lines; LAN has the identical schema gap). Say so if you want LAN frozen this cycle.

Defaults above are what the Linear phase issues assume; tell me any that differ and I will update both the plan and the tickets.

---

## 10. Definition of done for 2.1.23

- All Phase 1 + Phase 2 items merged with their suites green; Phase 3 items merged (or explicitly deferred by you, in writing, in the tracking issue).
- `test:regressions`: 134 original suites + ~7 new suites, 0 failures; `test:integration:worker` green.
- Build, 3 type checks, 6 guards, lint (0 errors, warnings ≤ 28) all green.
- F8 script run against a real Google account with its output committed.
- Changelog entry with per-item evidence **and** an explicit unverified list; the plan committed as `docs/drive-carrier-fix-plan.md`.
- `docs/BACKLOG.md` / `sync-contract.md` / `qa.md` consistent with the code, enforced by the new drift guard.
- `manifest.json` = `package.json` = `versions.json` = 2.1.23, tag `2.1.23`, TEST RELEASE notes.

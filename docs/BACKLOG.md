# Main backlog

Canonical list of unfinished work inherited by `main` before the feature branches. This excludes `.obsidian` sync, headless CLI, Docker, multivault/collaboration, auth rewrite, sharded note bodies, and recovery-v2 feature work.

Each item names current evidence, required work, and closure evidence. Historical discussion remains in Git history.

## Priority definitions

- **P0:** known correctness/data-preservation or current user incident.
- **P1:** required evidence or hardening for a confidence-heavy release.
- **P2:** bounded engineering debt; carry only if its owning code survives feature integration.
- **External:** closure depends on a reporter or real device/deployment unavailable to CI.

## Resolved since this list was written

Kept here so the claims above and in `sync-contract.md` can be checked against the code that closed them. `tests/contracts/docs-claim-drift.ts` fails if the wording of an unresolved item reappears in the documents named there while these suites exist.

### SYNC-01 — offline local delete is resurrected on re-enable — **resolved**

**Fix.** `src/runtime/reconcile/offlineDeletePolicy.ts` tells the two cases apart by content: a note that is active in the CRDT and absent on disk is a **proven local delete** when the persisted disk index still holds a baseline hash and that hash equals the hash of the CRDT text — nothing changed since the file was there, so the delete was the user's. Every other case (no index entry, no baseline hash, unreadable text, any hash difference) keeps the old behaviour and writes the CRDT text back, so a stale device cannot delete a file that genuinely changed elsewhere. The rule sits behind the same brake as the rest of reconcile: more than **20** candidates **and** more than **25 %** of the vault's tracked files missing-on-disk at once stops the pass (`evaluateOfflineDeleteBatch`), and a vault with no files on disk at all never mass-deletes.

**Commits.** `30d333d` (engine wiring) · `086c8a5` (the QA scenario hard-fails; the "known-issue" log is gone).

**Suites / evidence.** `tests/client/engine-offline-delete.ts` — the classifier table, the batch brake, a note we had in sync being tombstoned while an untouched one stays, the edited-remotely/never-materialised/ignored/incomplete-vault cases written back, the other device seeing the delete, conservative mode, and the 25-of-30 block with its trace. `tests/client/engine-tombstone-age.ts` — a tombstone is not resurrected later. QA: `qa/controllers/two-device.ts`, scenario `issue-22-disable-reenable-local-delete-remote-unchanged`, now pushes to `errors` (it throws on a resurrected file) instead of logging.

### SYNC-02 — bound-file re-enable can discard one changed side — **resolved in code**

**Fix.** `src/runtime/reconcile/boundDivergencePolicy.ts` decides it from the persisted baseline: when the disk text and the CRDT text **both** differ from the baseline **and** from each other, taking one side would silently discard the other, so the side about to be overwritten is preserved as a conflict note first (fingerprint dedupe, the per-path cap of two and the per-session cap of twenty are unchanged). Without a baseline nothing is claimed and the previous behaviour applies.

**Commits.** `a667248` (engine) · `086c8a5` (QA scenario hard-fails).

**Suites / evidence.** `tests/client/engine-bound-both-changed.ts` — the policy table, the local-only branch, the idle branch, the ordinary cases that mint nothing, and a repeated event not piling up copies.

**Still open (real-device part).** The recorded iPad ordering that started this item is still not reproduced on hardware: tracked as **QA-03** (iPad missing-baseline/cold-relaunch proof) in this file.

## P0 correctness and user incidents

### SYNC-01 — offline local delete is resurrected on re-enable

**State:** resolved — the rule is implemented and the QA scenario fails hard again. Details, commits and evidence: *Resolved since this list was written*, below.

### SYNC-02 — bound-file re-enable can discard one changed side

**State:** resolved in code — real-device closure still tracked as **QA-03**. Details and evidence: *Resolved since this list was written*, below.

### ISSUE-19 — `.base` rollback and bulk-clipping misses

**State:** Open GitHub issue from YAOS 1.6.0.

**Evidence:** User reports local `.base` layout changes later disappearing and one of several iOS Web Clipper-created Markdown files failing to reach desktop until renamed. `.base` currently uses the attachment plane; bulk-created Markdown uses ordinary file admission.

**Required investigation:** Treat these as two failure shapes until evidence joins them. Reproduce `.base` write/restart/reconnect through attachment hashing and download conflict policy. Reproduce a burst of iOS-created Markdown files and trace watcher admission, dirty-set draining, disk-index advancement, CRDT creation, provider receipt, and desktop materialization. Do not convert `.base` to Markdown character merging as a symptom fix.

**Closure:** Each shape has a focused failing reproduction, root-cause fix, regression, and reporter-facing build/result. Renaming must not be required to recover a missed create.

### ISSUE-23 — Canvas rollback and Excalidraw save freeze

**State:** Open GitHub issue from YAOS 1.6.1.

**Evidence:** User reports Canvas versions alternating after phone restarts and sporadic whole-Obsidian freezes when Excalidraw saves while YAOS is enabled. Both formats use the attachment plane; Excalidraw's own save behavior may contribute but does not explain a YAOS-only freeze.

**Required investigation:** Reproduce Canvas create/edit/restart across desktop and mobile while recording blob tombstones, hash cache, upload/download queue, and conflict decisions. Profile the Excalidraw save path for synchronous hashing, repeated watcher churn, queue loops, and plugin interaction. Preserve the exact file bytes and operation ordering; do not infer one root cause for both formats without evidence.

**Closure:** Focused reproductions identify the responsible path; Canvas no longer rolls backward/oscillates; Excalidraw save does not freeze Obsidian under the reproduced workload; attachment regressions cover the fixed transitions.

### ISSUE-68 — false receipt warning and idle auth rejection

**State:** Open against 2.1.0.

**Evidence:** Reporter traces show a candidate confirmed by one server echo and then reverted to `serverDominatesCandidate=false` by a later echo with the same encoded byte count. The status bar returns to “local state not yet received.” The same reporter observes `Auth rejected` after idle time and must reload the plugin.

**Required investigation:** Treat receipt state and idle authentication as separate until traces prove a connection. For receipts, reproduce the exact candidate/state-vector/persistence-generation sequence and determine whether remote or maintenance updates replace the candidate, whether a later non-dominating echo is allowed to revoke a valid latest-state receipt, or whether server/client documents diverge despite equal encoded lengths. For auth, capture ticket expiry, proactive refresh, patched provider URL, reconnect attempts, fatal frames, and HTTP ticket refresh result over real idle/sleep timing.

The existing local `ws-ticket-reconnect` suite proves URL patching and short-TTL reconnect under Wrangler; it does not invalidate the field report.

**Closure:** Issue-shaped traces no longer produce a false negative; status language remains exact; a real idle/sleep reconnect succeeds without plugin reload; regression coverage fails on the identified root cause.

## P1 validation and release confidence

### QA-01 — strict Linux+iPad+Android active-edit proof

**State:** Implemented scenario; never executed to its strict contract.

**Evidence:** Existing three-device evidence is passive agreement on a pre-existing hash. The two-desktop active-edit scenario passes, but it is not real mobile evidence.

**Required work and closure:** Execute the procedure in [QA](qa.md#qa-01-strict-three-device-active-edit). Preserve three untouched bundles, analyzer report, and human summary. Closure requires foreground iOS/Android, a distinct Linux local-edit target hash, both mobile devices settling that exact hash, and `summary.ok: true`.

### QA-02 — real-device conflict-artifact proof

**State:** Desktop proof exists; mobile/tablet proof absent.

**Required work and closure:** Execute [QA](qa.md#qa-02-real-device-conflict-artifact) on real devices. The local offline edit must survive at the original path, remote content must be preserved, artifact locality must match policy, and all original paths must converge.

### QA-03 — iPad missing-baseline/cold-relaunch proof

**State:** Desktop classifier and CDP coverage exist; mobile filesystem timing is unproven.

**Evidence:** The current heuristic gives disk the original path only when `diskMtime > lastDiskIndexPersistedAt`; otherwise CRDT wins while disk is preserved separately. The timestamp is global and may be coarse or preserved by external tools.

**Required work:** Kill/suspend Obsidian before disk-index persistence, edit locally, advance remote state, relaunch on iPad, and capture the decision fields (`missingBaselinePolicy`, mtimes, evidence, winner, artifact).

**Closure:** User-visible local work is not silently demoted or lost; the trace matches the documented policy; limitations remain explicit if the filesystem cannot provide decisive evidence.

### QA-04 — live provider/client sequential handoff

**State:** Storage-level and live Worker components exist; full product-visible proof is missing.

**Evidence:** Server persistence tests and Issue #24 experiments prove checkpoint/journal behavior. The missing claim is one layer above storage.

**Required work:** Device A edits through the client, receives the appropriate server receipt, and disconnects. Start Device B cold with A absent. Assert B's Yjs content and ordinary Obsidian file both match A's edit. Ensure the proof does not rely on simultaneous peer presence.

**Closure:** Reproducible integration evidence passes after a server cold-load/eviction boundary and fails if durable handoff is removed.

### QA-05 — real Node-filesystem watcher proof

**State:** Adapter-write and controller tests exist; OS watcher path unproven.

**Required work:** In a real debug-enabled Obsidian instance, modify an open/bound file through `qa/controllers/obsidian-client.ts::writeNodeFileAndWait`, not the vault adapter. Exercise tab-close/reconcile deferral and preserve the trace.

**Closure:** The OS event reaches the intended controller path, no wrong-authority overwrite occurs, and disk/editor/CRDT converge.

### QA-06 — original reporter validation for the #22 family

**State:** Internal fail/pass evidence exists; no reporter confirmation is recorded.

**Closure:** Reporter validates a fixed build or the project explicitly closes the external-validation requirement with a documented decision. Internal QA must not be relabeled as reporter evidence.

### QA-07 — blank workspace live acceptance

**State:** `qa:prepare` output is hermetically byte-tested but not accepted against a supported Obsidian runtime.

**Required work:** Prepare a fresh vault, open it in Obsidian, and use CDP to verify no Markdown leaf, recent file, or vault-specific path is restored.

**Closure:** Live acceptance records Obsidian version and observed empty workspace state.

### OPS-01 — duplicate-Yjs warning re-check

**State:** The old duplicate-import cause was fixed; at least one later live run reportedly still emitted the warning.

**Required work:** Run the current CI/live entrypoints from a clean checkout and identify the module paths if the warning appears. Distinguish stale generated JS, nested dependency copies, and runner aliasing.

**Closure:** Either reproduce and remove the second import or preserve a clean run proving the current entrypoints load one Yjs copy.

### OPS-02 — strict legacy-token-disable deployment smoke

**State:** Initial ticket and reconnect paths run in local integration; migration-closed deployment behavior remains a manual gate.

**Required work:** Deploy with `YAOS_DISABLE_LEGACY_WS_TOKEN=true`; connect a ticket-aware plugin; attempt an old `?token=` socket; verify 401 before vault-room wake and Worker-level rejection logging.

**Closure:** New client connects, old client fails closed, and no per-room mutation occurs for the rejection.

### OPS-03 — Cloudflare WebSocket upgrade coverage boundary

**State:** Node/Miniflare and local Wrangler cover most pre-auth and socket behavior; Cloudflare-specific upgrade handling is not completely represented in Node tests.

**Required work:** Identify the remaining production-only branch rather than adding another broad harness. Exercise it against a deployed Worker if it affects admission or rejection guarantees.

**Closure:** The exact branch has deployed evidence or is removed/refactored into tested platform-independent logic.

## P1 path, reconciliation, and diagnostics

### PATH-01 — NFC/NFD normalization across the full pipeline

**State:** Canonicalization exists at rename admission; storage/import/reconcile do not uniformly use it.

**Evidence:** `findCanonicalPathCollisions()` is tested but has no production caller. `main.ts` can emit a collision trace but explicitly does not resolve it. Case folding is intentionally undecided.

**Required work:** Define the invariant for Obsidian display paths versus CRDT identity keys. Exercise startup scan, create/import, rename, reconcile, and persisted disk index with NFC/NFD variants. Wire collision detection at an admission boundary or delete the unused vault-wide primitive. Do not add platform-dependent case folding without a separate product decision.

**Closure:** No two CRDT identities are created for canonically equivalent paths; collision behavior is deterministic and tested on relevant filesystems; unused detection code is absent.

### REC-01 — local repair must not round-trip as remote writeback

**State:** Representative #22 evidence exists; the exact invariant lacks a focused proof.

**Required work:** Drive a local repair through CRDT, editor binding, DiskMirror suppression, and the resulting watcher event. Assert that the repair-origin write is acknowledged/suppressed and does not return as external input or produce a second semantic update.

**Closure:** Focused test fails when origin/suppression is removed and passes through the real orchestration path.

### REC-02 — full recovery-controller orchestration proof

**State:** Policy and partial controller tests exist; complete orchestration remains uncovered.

**Required work:** In one realistic path prove: disk selected as sole authority when disk/CRDT/editor diverge; `EditorBinding.repair()` selected rather than `heal()` when health requires it; `flushWriteUnlocked` performs the intended disk I/O; suppression fingerprint is installed; second reconciliation pass is a no-op.

**Closure:** One behavioral test covers the complete sequence without replacing dependencies so aggressively that the disputed transitions cannot fail.

### TRACE-01 — direct throttle-summary recursion test

**State:** `recordTrace()` has an `isThrottleSummary` recursion guard; tests do not invoke the recursion shape directly.

**Required work:** Saturate trace throttling, force summary emission, and assert the summary does not recursively create another summary or affect room availability.

**Closure:** Behavioral server test fails if the guard is removed.

### TRACE-02 — structured path-bearing diagnostics

**State:** Safe redaction handles known structured path fields and seeded free-form paths, but product logs still interpolate paths into strings.

**Required work:** Move path values used by support-facing diagnostics into recognized structured fields. Extend event types and redaction tests with each migrated path. Avoid a mechanical logging rewrite unrelated to exported/support data.

**Closure:** Safe bundles contain no raw migrated paths and no longer depend on regex discovery for those events.

### TRACE-03 — explicit safe versus local-only diagnostics contract

**State:** `buildDebugInfo()` and exports carry overlapping safe/local values; the contract depends partly on caller expectations.

**Required work:** Define separate typed payloads or builders for safe export and explicitly confirmed filename-inclusive/local inspection. Server URL, vault ID, device name, tokens, and paths must not cross the safe boundary.

**Closure:** Compile-time separation and runtime leak tests reject insertion of sensitive fields into the safe payload.

### STATUS-01 — distinguish user edits from maintenance updates

**State:** `lastLocalUpdateAt` includes user edits, disk imports, restores, repairs, and maintenance writes.

**Required work:** If UI continues to imply user activity, capture user-edit origin separately. Otherwise rename/remove the claim. Do not infer authorship solely from “local” Yjs origin.

**Closure:** Status copy and source fact have matching semantics, with origin tests for user edit versus repair/restore.

## P2 debt subject to feature-branch survival

### ARCH-01 — planner/mutation split around `reconcileVault`

**State:** `mintAdmissionOpId` callback is a controller-shaped seam in `VaultSync.reconcileVault()` so a decision can be emitted before mutation.

**Decision:** Do not refactor `main` independently if the selected sharding/integration branch removes this code. If it survives, return a seed plan without mutation; let the controller mint IDs, emit decisions, and call `ensureFile`; migrate every caller in one cutover.

**Closure:** Callback and compatibility comments are removed, every caller uses the selected ownership boundary, and decision-before-mutation tests remain.

### ARCH-02 — complete or stop TraceSink migration

**State:** Some DiskMirror, provider, recovery, and path-scoped events bypass `FlightTraceSink`.

**Decision:** Enumerate bypasses that still serve a product/support contract. Route those through mapped typed events; delete incidental tracing rather than creating an abstraction solely for completeness.

**Closure:** The documented boundary matches imports/callers; no claim of full dependency inversion while bypasses remain.

### ARCH-03 — narrow telemetry mutable handles

**State:** Telemetry host access remains broader than its read-only sync-state intent, including concrete service handles and the Obsidian `App` for file output.

**Required work:** If the current telemetry runtime survives integration, define minimal read ports for DiskMirror/BlobSync and a narrow diagnostics file-output port. Preserve mobile adapter behavior.

**Closure:** Telemetry cannot call mutation-capable members through its types; tests cover required reads/exports.

### AUTH-01 — dedicated ticket signing secret

**State:** Ticket HMAC signing derives from existing auth material rather than a dedicated random server secret.

**Decision:** Resolve in the auth/control-plane integration, not as parallel main-only work. If the old model survives, generate/store a dedicated signing secret and define existing-deployment backfill.

**Closure:** Signing authority is independent of the bearer-token verifier; migration and ticket tests pass.

### AUTH-02 — auth material in diagnostics

**State:** Current safe exports test common sensitive fields; auth hardening remains an explicit requirement.

**Required work:** Audit URL, headers, fatal frames, ticket-fetch errors, setup links, and server traces for token/ticket persistence. Add exact leak fixtures for any uncovered carrier.

**Closure:** Safe/local diagnostic policies intentionally cover each carrier; no bearer token or ticket is persisted in room traces or safe exports.

### STORAGE-01 — decide journal previous-hash chaining

**State:** Checkpoint/journal payloads have individual hashes and strict sequence validation, but no cryptographic previous-segment chain. The old limits document listed this as future work without a concrete incident.

**Decision:** Either name a failure the chain detects that current sequence/hash validation does not, then implement and test it, or close the idea and remove it from planning. Do not carry an unowned “maybe harden” item indefinitely.

### CLEAN-01 — remove `redirectPendingCreate` transition alias

**State:** `ReconciliationController.redirectPendingCreate()` is deprecated in favor of `redirectPendingDirtyPath`; QA scenario names/comments still use the old term.

**Required work:** Migrate callers and QA language, remove the alias, retain the regression proving a pending modify is not lost across rename.

### CLEAN-02 — remove false-pass receipt wait API

**State:** `waitForMemoryReceipt()` is deprecated because it polls global current state and can satisfy a later action with an earlier receipt. It remains exposed through QA ports, API types, help text, and wrappers.

**Required work:** Migrate every scenario to action-bound `waitForReceiptAfter(timestamp)` or a candidate-bound equivalent, then delete the old method through all layers.

**Closure:** No deprecated API or help entry remains; receipt waits cannot pass on pre-action state.

### CLEAN-03 — choose snapshot compatibility cutoff

**State:** Client/server still carry `structureUnchanged`, `semanticUnchanged`, `stateVectorHash`, and `computeStateVectorHash` compatibility paths. Some are read-only aliases for old clients; state vectors are known to miss deletion-only changes.

**Decision:** Establish the oldest supported plugin/server pair. Remove aliases and tests only when that support window permits, or retain them with one explicit compatibility table. The recovery-v2 branch may supersede the entire surface.

**Closure:** No ambiguous deprecated field remains without an owned compatibility requirement.

### CLEAN-04 — delete historical issue narratives from source comments

**State:** Several production files carry long Issue #40/#22 histories and links to documents being removed.

**Required work:** Keep the invariant, failure consequence, and non-obvious reason adjacent to code. Move no history elsewhere; Git already preserves it. Update the few load-bearing references to this backlog/contract.

### CLEAN-05 — documentation cutover

**State:** This file is the only backlog after the approved documentation rewrite.

**Closure:** Root README and code comments link only to retained documents; no `docs/archive`, superseded RFC, old status ledger, orphan diagram, or ignored `qa-runs` path is presented as repository-verifiable current truth; total durable docs remain within the approved 2,000–3,000-line budget.

## External issue closure

| Item | External dependency |
|---|---|
| ISSUE-19 | Reporter-shaped reproduction and preferably reporter validation |
| ISSUE-23 | Excalidraw/Canvas environment and reporter validation |
| ISSUE-68 | Real idle/sleep deployment behavior and reporter validation |
| QA-01/02/03 | Real iPad/Android hardware |
| QA-06 | Original reporter response |

External dependency does not excuse reachable work: build the reproduction, fix, regression, and release candidate first; record exactly what remains external.

## Deliberately excluded

Not backlog unless a new observed problem makes them necessary:

- generic soak/stress expansion;
- Phase 4 or awareness witness relay;
- automated mobile CDP;
- configurable cursor colors;
- native Windows support;
- feature-branch deliverables named at the top of this file;
- dependency-origin re-verification before the corresponding dependency is upgraded.

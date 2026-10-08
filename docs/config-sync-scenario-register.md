# Configuration sync: scenario register and release gates

**Status: design requirements, not implemented or tested.** Companion to `config-sync-plan.md`. Applies to Cloudflare Worker, Google Drive and Local network wherever the platform supports the carrier.

## Coverage contract

It is impossible to prove coverage of every conceivable environment, arbitrary plugin, malicious endpoint or combined hardware/software failure. This register establishes an auditable minimum, not a claim of exhaustive proof.

Before implementation is accepted, each numbered entry below must have:
1. Preconditions and the operation/state transition affected.
2. Expected shared-state, disk-state and runtime-state outcomes.
3. Detection, bounded recovery, backup/rollback and user-visible status rules.
4. Named automated test(s), manual qualification evidence, or a specifically justified unsupported combination.
5. An implementation owner and one of: **unimplemented**, **implemented/unverified**, **verified**, **blocked**, **unsupported by design**.

**Initial status of every entry: unimplemented.** Listing a scenario is not evidence that it has been handled. No blank, silently skipped or merely flaky-quarantined scenario counts as a pass. Unsupported cases must be prevented at runtime and documented. They must not be advertised as supported.

Unknown/unclassified conditions pause the affected transaction, retain its last known-good state and recovery material, and expose a redacted diagnostic. Continue unrelated work only when its independence is established. Fail closed does not mean restore is always possible after physical data loss.

## A. Enablement, initial adoption and membership

- **A01 — Existing populated source:** seed a complete verified baseline; partial seeding must not become authoritative.
- **A02 — Empty/new joining device:** adopt shared state; local absence is not deletion.
- **A03 — Populated joining device:** back up selected local state before adoption; account for both overlapping and unique local files. Do not silently destroy local-only categories.
- **A04 — Simultaneous first enablement:** deterministically elect a baseline; preserve losing proposals and prevent partially mixing two seed transactions.
- **A05 — Seeder crashes or disconnects:** resume its committed/proposed state without publishing incomplete content or electing conflicting authority merely on a timeout.
- **A06 — Join while offline or before remote enumeration completes:** remain uninitialized/pending; never seed from an assumed empty remote.
- **A07 — Long-offline or retired device returns:** rebase against the current epoch and tombstone rules; stale absence/content cannot resurrect retired state.
- **A08 — Device identity cloned by copying a vault:** detect identity/sequence collision, allocate distinct local identity safely, and preserve already-authored revisions.
- **A09 — Local identity/counter storage lost or rolled back:** avoid revision-ID reuse; rejoin/rebase rather than overwrite another operation.
- **A10 — Multiple app windows/processes for one vault:** enforce one local applying writer or refuse concurrent apply; define stale-lock recovery without stealing an active lock.
- **A11 — Two devices share a filesystem through another sync tool:** detect unsupported dual writers or repeated divergence; avoid creating a deletion/conflict storm.
- **A12 — Wrong vault, vault copy, renamed/moved vault or changed vault ID:** fence old work; require correct identity binding and reinitialization before writes into the new location.

## B. Selection, privacy and policy changes

- **B01 — Enable/disable the whole feature during work:** cancel/fence work, persist recovery state, and never interpret disabling as deletion.
- **B02 — Add/remove a category or path filter:** define adoption when adding; removing stops synchronization without deleting live/shared files implicitly.
- **B03 — Device-local selection differs from shared desired policy:** local refusal is not a shared deletion; show a scope mismatch rather than false full convergence.
- **B04 — Unknown plugin settings:** do not upload opaque files automatically under a claim of secret-free synchronization.
- **B05 — Known plugin changes settings schema:** version the policy; block unsupported projections rather than upload newly introduced fields blindly.
- **B06 — Secrets nested in arrays/objects or encoded in values:** keyword filtering is not a safety proof; use approved projections or exclude the opaque file.
- **B07 — Local-only fields coexist with shared fields:** preserve local fields during apply; validate against current disk bytes and avoid write-back leakage.
- **B08 — Credentials already uploaded under an earlier policy:** stop propagation, disclose that cached/history/remote copies may remain, define purge scope and require credential rotation where appropriate. Deletion is not proof of revocation.
- **B09 — Incoming configuration tries to widen trust, enable code sync, change endpoints or disable YAOS:** reject remote privilege escalation; standing local permissions remain local.
- **B10 — YAOS directory, journals, backups, logs, lock files or staging are encountered:** exclude before upload and before remote write admission, including nested/custom-directory variants.
- **B11 — Another plugin contains its own backups/caches/binaries:** classify explicitly; do not recursively assume everything below plugins/ is portable configuration.
- **B12 — Privacy policy differs across app/plugin versions:** block affected fields/categories or negotiate supported policy; never silently downgrade protection.

## C. Paths and filesystem behavior

- **C01 — Non-default active config directory:** map logical config-relative paths to the correct device-local root.
- **C02 — Config directory changes while operations are queued:** invalidate old target bindings; require rescan/rebase before applying to the new root.
- **C03 — Absolute paths, traversal, backslashes, repeated separators or encoded traversal:** canonicalize once under a strict path grammar; reject escapes at every write boundary.
- **C04 — Symlinks, junctions or ancestor substitution between check and write:** enforce containment with platform-supported guarantees; block writes where the guarantee cannot be established.
- **C05 — Case-only rename, Unicode normalization collision, reserved names, trailing dots/spaces or invalid characters:** detect conflicts before writing; never overwrite an unrelated platform-equivalent path.
- **C06 — Long paths, deep trees, excessive entry counts or huge files:** enforce documented resource limits; leave oversized/unsupported items blocked without truncation.
- **C07 — File replaced by directory or directory by file:** use an explicit backed-up transaction; no recursive deletion based on an ambiguous type change.
- **C08 — Read-only files, permissions, sharing locks or unavailable volume:** bounded retry where appropriate; retain the prior live state and pending work.
- **C09 — Disk full, quota exhaustion or space runs out during rollback:** budget staging and recovery space before mutation; report blocked/recovery-required status if the platform still fails.
- **C10 — Adapter lacks atomic replacement, durable flush or required locking:** qualify a weaker supported protocol explicitly or block the affected category; never claim filesystem guarantees unavailable through the adapter.
- **C11 — Stat/mtime lies, low timestamp resolution or same-size modification:** hashes and stable reads determine content, not mtime alone.
- **C12 — Partial enumeration, inaccessible child or canceled scan:** incomplete scans cannot generate deletion proposals.
- **C13 — Transient read failure/zero-byte temporary file during editor save:** distinguish a stable intentional empty file from an incomplete write; use bounded stabilization with truthful pending status.
- **C14 — BOM, encoding, newline differences or arbitrary binary files:** preserve bytes unless a documented category-specific projection requires serialization. Invalid required encoding blocks application.

## D. Causality, conflicts, deletes and renames

- **D01 — Concurrent edits to one file:** every delivery order converges to the same documented winner; retain losing content before pruning history.
- **D02 — Concurrent independent files/packages:** do not serialize the whole vault unnecessarily; obey declared cross-file dependencies.
- **D03 — Edit versus delete:** preserve concurrent edits; recognize a causally later intentional deletion.
- **D04 — Delete followed by recreate at the same path:** distinguish identities/revisions; stale tombstones cannot delete the recreation.
- **D05 — Rename versus edit/delete/another rename:** preserve causal relationships and conflicts, not just filename ordering.
- **D06 — Rename onto an existing target or case/Unicode-equivalent target:** back up both candidates and refuse unsafe replacement until deterministic policy resolves it.
- **D07 — Duplicate delivery, retries, acknowledgement loss or replay:** application and publication are idempotent.
- **D08 — Reordered metadata/content and delayed older revisions:** never roll back a causally newer applied state merely due to arrival order.
- **D09 — Device clock jumps backward/forward or counter overflow:** use stable logical ordering and defined counter bounds; do not silently reset identity.
- **D10 — Parent revision/history missing:** request/reconcile missing context or block; do not invent causal precedence.
- **D11 — Excessive or malformed causal graph:** bound traversal, depth and storage; quarantine invalid records.
- **D12 — Tombstone/history cleanup with inactive peers:** use explicit membership/epoch rules; old peers must rebase rather than resurrect pruned state.
- **D13 — Local edits appear while a remote winner is downloading/applying:** recheck the preimage, preserve/publish the edit and recompute before overwrite.
- **D14 — Obsidian regenerates a deleted default file:** use category-specific regeneration rules to avoid deletion/recreation loops without hiding intentional edits.

## E. Transfer, encryption and carrier behavior

- **E01 — Offline, partition, captive portal, DNS failure or half-open request:** deadline, durable retry state, jitter/backoff and generation fencing.
- **E02 — Rate limit, service overload, transient errors or quota:** obey bounded retries and available retry hints; expose persistent failures without tight loops.
- **E03 — Revoked/expired credentials or lost permissions:** pause safely; authentication recovery may require user action despite routine prompt-free operation.
- **E04 — Metadata exists but payload is missing:** remain pending; do not delete existing configuration or pretend application succeeded.
- **E05 — Truncated/corrupt response, wrong hash, wrong length or substituted content:** reject before application and retain working local state.
- **E06 — Wrong vault, wrong encryption key or replay across content purposes:** verify identity/integrity and the applicable authenticated context; do not treat a hash alone as sender authentication.
- **E07 — Encryption disabled, enabled or key rotated:** define a supported migration or explicitly block in-place transitions. Never silently publish decrypted configuration to a less-protected destination.
- **E08 — Drive delayed listing, duplicate names, moved/deleted folders or late write response:** immutable identity/integrity checks and reconciliation; no cleanup on the basis of unknown coverage.
- **E09 — Worker compatibility/authentication/size limits:** negotiate or enforce supported contracts; do not couple note availability unnecessarily to config failures.
- **E10 — LAN source disconnects mid-transfer or only holder is offline:** resume/re-request verified content later; report unavailable, not durably saved elsewhere.
- **E11 — LAN relay supplies malformed/unauthorized content:** authenticate peer and vault, validate every payload, bound resources, and contain callback errors.
- **E12 — Carrier switch with outstanding writes:** fence old work, retain recovery state, and reseed/verify required payloads at the destination before handover completion.
- **E13 — Same document used simultaneously through multiple carriers:** support only through an explicitly designed bridge, otherwise prevent it; no accidental dual-authority mode.
- **E14 — Background suspension, network change or application resume:** preserve durable checkpoints; reconnect/revalidate before resuming stale work.
- **E15 — Retry queue flood or one repeatedly failing payload:** deduplicate, bound resource use, ensure fairness and isolate unrelated independent transactions.

## F. Transactions, crashes and recovery

- **F01 — Crash before/after each outgoing checkpoint:** no committed reference before carrier-specific content availability; safe resume without duplicate authority.
- **F02 — Crash before/after each incoming backup, journal, stage, replacement, verification and completion checkpoint:** recover deterministically from the durable boundary.
- **F03 — Power loss, journal corruption or ambiguous commit:** do not infer success from file existence alone; validate hashes and journal states, or block recovery.
- **F04 — Backup fails, corrupts or cannot be read back:** do not begin destructive replacement.
- **F05 — Multi-file transaction stops halfway:** prevent exposure of mixed executable packages; use a validated commit point or do not activate that category.
- **F06 — Restore/rollback itself fails:** keep available evidence/recovery copies and surface recovery-required state; never mark the transaction applied.
- **F07 — Startup recovery races with another instance or plugin loading:** do not assume YAOS loads first; qualify the startup/apply protocol before advertising automatic package updates.
- **F08 — Cancellation, feature disablement, vault switch or coordinator destruction:** late continuations cannot write, acknowledge application or alter the replacement session.
- **F09 — Queue/index/database lost while live files survive:** recover via a safe fresh baseline/reconciliation process, not mass upload/delete guesses.
- **F10 — Recovery data on the same failed disk is lost:** disclose recovery limits; local backups are not independent disaster backups.
- **F11 — Old temporary files/abandoned staging accumulate:** safe age/reference-aware cleanup; never remove data required by active or unresolved journals.
- **F12 — Backup retention budget exhausted:** block destructive work or apply an explicitly agreed retention policy; do not silently discard the last recoverable preimage.

## G. Plugin packages and activation

- **G01 — Plugin install/update consists of manifest, JavaScript, CSS and additional assets:** define complete package boundaries and dependency hashes.
- **G02 — Source updater is still writing the package:** do not publish mixed versions; stability alone must not be represented as publisher authenticity.
- **G03 — Enablement list arrives before package:** defer enablement until the complete compatible package is installed safely.
- **G04 — Plugin uninstall/disable while settings or package transfer is pending:** cancel/reconcile dependent work; prevent stale completion from re-enabling it.
- **G05 — Desktop-only plugin on mobile, minimum app version, unsupported API or missing dependency:** block local activation while preserving desired shared state.
- **G06 — Manifest identity differs from directory/package identity:** reject unsafe mismatch; define valid package migration explicitly.
- **G07 — Running plugin rewrites its settings after remote disk replacement:** separate runtime and disk state, detect write-back loops, and defer unsafe activation.
- **G08 — Plugin needs a restart or offers no supported reload API:** do not hot reload or force restart; establish a safe later commit/activation path or keep staged.
- **G09 — Plugin code upgrade migrates settings incompatibly:** package/settings version dependency must be explicit. Default to manual/updater-only handling for unsupported migration paths rather than claim automatic safe downgrade.
- **G10 — Plugin crash, failed load or corrupted startup configuration:** retain previous package/settings and recovery instructions. Automatic rollback requires reliable failure attribution; do not guess that YAOS caused every crash.
- **G11 — Plugin initialization modifies other selected configuration:** classify genuine resulting edits, avoid echo loops, and bound cascades.
- **G12 — Plugin introduces its own database, native module, generated artifact or executable:** require an explicit category/platform policy; do not treat it as portable JSON.
- **G13 — Community/core plugin ordering or cross-plugin dependencies:** model required dependencies or block unsupported ordering constraints.
- **G14 — Malicious or compromised paired device sends validly hashed executable code:** acknowledge the standing-trust threat model; hash/encryption do not establish publisher safety. Local trust revocation stops future application but cannot undo executed code.
- **G15 — YAOS package/settings or the enabled-plugin list would remove the sync engine:** protect local operation; prevent remote self-replacement/self-disable through this feature.

## H. Core settings, themes and workspaces

- **H01 — Unsupported core setting or app-version-specific format:** block unsupported application; preserve valid local state.
- **H02 — OS-specific paths, external commands or absolute executable paths:** do not execute/adopt arbitrary machine-specific commands under a portable-settings policy.
- **H03 — Appearance references missing theme/snippet:** apply dependencies before references; retain prior appearance until complete.
- **H04 — Workspace references deleted notes, unknown views or unavailable plugins:** validate or defer; do not close active editors or discard buffers.
- **H05 — Desktop/mobile workspace formats differ:** optional workspace category has an explicit compatibility matrix; same-state mirroring cannot override unsupported formats.
- **H06 — Current window/session changes workspace continually:** avoid high-frequency cross-device session fighting; defer or block unsupported live mirroring.
- **H07 — Hotkeys/settings conflict with platform capabilities:** retain desired state but block unsupported application with a visible reason.
- **H08 — Safe mode/restricted mode disables community plugins:** respect the application's local restriction; never bypass it via a synced enablement list.

## I. Versions, snapshots and garbage collection

- **I01 — Older YAOS peer sees unknown config metadata:** verify preservation or gate compatibility; must not reinterpret it as normal attachments.
- **I02 — Newer unknown config schema/policy arrives:** stop config processing safely; keep notes working only where that remains compatible.
- **I03 — Upgrade/downgrade midway through an apply journal:** version the journal and recovery code; block unsafe downgrade or retain recoverability.
- **I04 — Old snapshot contains no configuration:** leave current configuration unchanged.
- **I05 — Snapshot contains config metadata but referenced content was pruned:** report incomplete restore; do not replace live files with absence.
- **I06 — Restore an older config snapshot:** publish an intentional new revision through current safety/privacy rules, not an old causal timestamp or unconditional disk copy.
- **I07 — Snapshot or carrier compaction encounters unknown/corrupt metadata:** retain unknown references safely or block destructive compaction; no guessed coverage.
- **I08 — Content garbage collection races with upload, history retention or restore:** protect active references, transactions, retained losers and snapshots before deletion.
- **I09 — Privacy policy changes after snapshot creation:** current policy still applies during restoration; old snapshots cannot bypass exclusions.
- **I10 — Full config reset/reseed or abandoned vault epoch:** require explicit scope, backup and epoch transition; old devices cannot reinstate the discarded authority.

## J. Resources, diagnostics and qualification

- **J01 — Very large directory, many small files or repeated rapid changes:** bounded memory, batch size, concurrency and I/O; foreground editing remains responsive.
- **J02 — Mobile battery/background restrictions or long process suspension:** no dependence on precise timers; checkpoint/rescan after resume.
- **J03 — Invalid metadata sizes/counts or decompression/resource bombs:** reject before unbounded allocation; specify tested budgets and compressed/raw limits.
- **J04 — Diagnostics include sensitive paths/values or payload fragments:** redact by default, never log credentials/content; exports require an explicit privacy policy.
- **J05 — Transfer complete but disk apply/activation pending:** accurate distinct states, not a single misleading “synced” indicator.
- **J06 — Persistent blocked state:** nonblocking, discoverable error with a concrete recovery path; no endless silent retries or routine modal spam.
- **J07 — Regression in notes, attachments, encryption, restore, compaction or unload:** full existing regression suite plus cross-subsystem scenarios remains a release gate.
- **J08 — Untested platform/carrier/category combination:** identify it as unqualified/unsupported, not implicitly covered by fake adapters.
- **J09 — Flaky concurrency test:** investigate and fix or block the affected feature; rerunning until green is not evidence of safety.
- **J10 — Unknown future plugin/OS behavior:** fail affected operations safely, preserve available recovery state, and add the discovered scenario to this register before claiming support.

## Interaction coverage: isolated tests are not enough

For each applicable scenario, combine the following dimensions using risk-based pairwise coverage, plus targeted higher-order and adversarial cases:
- Carrier: Worker / Drive / LAN.
- Platform/adapter: qualified desktop OSs / Android / iOS; LAN mobile combinations explicitly unsupported.
- Content: core JSON / approved plugin projection / theme/snippet / executable package / optional workspace.
- Device count: one / two / three or more; online / partitioned / suspended / returning stale peer.
- Lifecycle: initialization / publication / transfer / staging / disk commit / activation / rollback / shutdown.
- Version: current / supported older / unknown newer / interrupted upgrade.
- Storage/security: encrypted/unencrypted supported modes, low-space/read-only, valid/revoked credentials, trusted/revoked peer.

Pairwise coverage reduces omissions but does not prove all interactions safe. Mandatory higher-risk combinations include:
1. Offline concurrent edit + remote deletion + device restart during conflict recovery.
2. Plugin upgrade + settings migration + crash between package and settings activation.
3. Carrier switch + in-flight upload + old-session late completion.
4. Privacy-policy tightening + pending upload + restoration of an old snapshot.
5. Disk full + local edit during incoming apply + failed rollback.
6. Returning stale peer + tombstone compaction + re-created path.
7. Mobile suspension + partial enumeration + app-generated default configuration.
8. Two local app instances + external sync tool + active plugin write-back.
9. Seed election + missing payload + source disappearance.
10. Snapshot retention + content garbage collection + concurrent restore.

## Test strategy and release gates

- Build an explicit state machine for each transaction, with invariants checked after every transition.
- Use deterministic scheduler tests and randomized/property-based runs for operation reorderings, duplication, partitions and crash points. Preserve random seeds and minimized counterexamples.
- Inject failures before and after each persistence boundary, not just at the start of a transfer.
- Independently test carrier contracts, filesystem adapters, policy admission and activation behavior before end-to-end testing.
- Exercise actual filesystem/process termination and real Obsidian/plugin behavior on each claimed platform. Loopback tests do not replace this.
- Record exact implementation revision, environment, expected invariants and evidence for qualification runs.
- Release only supported categories whose scenarios are verified. A blocked scenario either blocks its category/release or results in an explicit runtime-enforced scope reduction requiring approval when it changes the agreed scope.
- Maintain a separate issue register for discovered failures, with a regression test and risk review before closure.

### Non-negotiable invariants

1. No secret or excluded operational state is intentionally admitted into shared config content.
2. No write outside the authorized active configuration root or local recovery root.
3. No destructive replacement without verified required recovery material and an unchanged preimage.
4. No deletion derived from an incomplete scan or uninitialized device.
5. No incomplete executable package made eligible for loading.
6. No late canceled operation can mutate an ended/replaced session.
7. No false claim of applied, activated or durably replicated state.
8. No remote elevation of local trust or platform restrictions.
9. No forced restart or loss of active editing to satisfy mirroring.
10. No passing coverage claim merely because a scenario appears in this document.

## Open engineering decisions that must not be skipped

Before implementation of affected functionality, settle and record:
- Exact safe activation/commit mechanisms per platform and category, including runtime settings write-back and plugin load order.
- Baseline-election protocol, causal representation, stable conflict ordering and concurrent delete/edit rules.
- Local writer locking, identity-clone detection and counter recovery.
- Exact backup, history, tombstone, payload-retention and resource budgets.
- Policy registry ownership, supported plugin settings schemas and handling of excluded fields.
- Old-client, schema and server-admission compatibility; snapshot and compaction retention of config references.
- Supported encryption transitions and carrier-switch protection requirements.
- Supported executable-package boundaries, setting migrations and downgrade restrictions.

Until resolved and qualified, these remain **open gates**, not promises that the existing repository already supplies the required guarantees.

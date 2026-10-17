# Obsidian configuration sync — cross-carrier implementation plan

**Status:** Approved design; a first gated staging increment is implemented. This design is not a claim of completed support. See `config-sync-preview.md` and `config-sync-coverage.md` for current scope and outstanding gates.

**Baseline inspected:** `google-drive-carrier`, commit `39b90af` / release 2.1.21.

## 1. Decisions

The feature will support **Cloudflare Worker, Google Drive and Local network**, using one common policy and reconciliation implementation.

User-selected behavior:
- Support the configuration directory, including selectable settings, plugin packages/settings, themes, snippets and workspace layouts.
- Mirror selected eligible files, rather than introduce user-managed per-device profiles.
- Resolve conflicts automatically using a deterministic winner, with recoverable losing versions.
- Operate without routine approval dialogs or forced application restarts.
- Changes requiring a restart activate at the next natural restart.

Recommended decisions, delegated by the user:
- **Initial baseline:** the first device on which configuration sync is enabled seeds the shared configuration. Other devices back up their eligible local files before adopting it. Existing unique files on joining devices are not silently imported; they remain recoverable in the adoption backup.
- **Trust:** one-time consent at feature enablement authorizes eligible plugin packages from trusted paired devices. Subsequent updates do not prompt. This is consistent with automatic operation, but must explicitly disclose that plugin JavaScript can execute code. Pairing does not make a compromised device safe.
- Feature enablement remains opt-in. Ordinary notes continue syncing if configuration sync is disabled, blocked or degraded.

**Meaning of robust:** explicit safety invariants, bounded operations, durable recovery and a tested failure matrix—not a guarantee against every possible failure, compromised endpoint, or arbitrary plugin behavior.

## 2. Scope and exclusions

Logical configuration paths are relative to the active `app.vault.configDir`, not hard-coded to `.obsidian`. Devices with different configured directory names map the same logical file into their respective active configuration directories.

| Category | Planned handling |
|---|---|
| Core Obsidian preferences and hotkeys | Automatically sync eligible files/fields through versioned policies. |
| Core/community plugin enablement lists | Dependency-aware changes after compatible packages are complete; do not remotely disable YAOS. |
| Community plugin packages | Optional category covered by standing trust; treat each package as a unit, not unrelated files. |
| Plugin settings | Supported plugin-specific policies; unknown files are not assumed free of credentials or device-specific data. |
| Themes and CSS snippets | Automatically transfer eligible files; apply live only through tested supported mechanisms. |
| Workspace/layout files | Optional, off by default; apply only when compatible, preferably at a natural restart. |
| YAOS installation, credentials and operational state | Always excluded from this subsystem. YAOS updates remain on the existing updater path. |
| Backups, journals, staging, caches, logs, lock/temp files | Always local; never re-uploaded as user configuration. |
| Unsupported or unsafe files | Preserve locally or in staging, mark blocked with a reason, and continue syncing unrelated eligible files. |

Mandatory privacy policy:
- Never sync YAOS tokens, encryption passphrases, pairing keys, device identity or transport selection.
- Never promise that a filename/keyword scan can identify all secrets in third-party plugin settings.
- Use a reviewed registry of portable fields/files for known formats. For structured files with local-only fields, synchronize an approved projection and preserve local fields when applying it.
- Unknown plugin settings are blocked by default until a safe policy exists or an explicit advanced standing policy is chosen. Do not silently upload them under the label “full folder.”
- A device's trust/permission policy cannot be elevated by incoming synced configuration.

“Mirror” means the same selected **eligible shared state**, not identical bytes where credentials, local-only fields or platform restrictions make that unsafe. These exceptions must be visible, not disguised as successful mirroring.

## 3. Architecture

Keep the ordinary vault-content exclusion for the configuration directory. Removing that rule alone would expose sensitive/internal files and would not solve activation, filesystem discovery or multi-file consistency.

Add a dedicated shared `ConfigSyncCoordinator` with:

1. **Policy registry:** categories, local-only fields, compatibility rules, package membership and safe activation strategies.
2. **Scanner:** adapter-based traversal of the configuration directory; discovery must not rely on `vault.getFiles()` or ordinary note events exposing hidden configuration files.
3. **Change stabilizer:** debounce and repeated stat/hash checks to avoid publishing partial writes from Obsidian or plugins. Unstable files wait without blocking unrelated work.
4. **Metadata/revision store:** independent configuration records, separate from note metadata and `pathToBlob`, so existing note/attachment consumers cannot apply configuration accidentally.
5. **Content transfer adapter:** reuse carrier blob primitives only after auditing hash checks, encryption, availability, limits and cancellation. Do not bypass each carrier's existing authentication/privacy boundary.
6. **Durable reconciliation queue:** persists desired, staged, applied and pending-activation revisions independently.
7. **Transactional apply/recovery layer:** verified local backup, journal, staging, precondition checks, supported atomic replacement and post-write verification.
8. **Activation manager:** applies supported live changes or records that activation waits for a natural restart. No automatic plugin-code hot reload.
9. **Diagnostics:** quiet status, aggregate errors and retry controls, without logging configuration contents or credentials.

Candidate modules: `src/config-sync/{policy,scanner,revisionStore,transferAdapter,coordinator,applyJournal,activation,diagnostics}.ts`. Names are proposals, not existing APIs.

Integration points to audit include `main.ts`, runtime/settings configuration, the transport seam, attachment stores, snapshots, carrier compaction and lifecycle teardown. Existing note and attachment behavior must remain covered by its current regression suites.

## 4. Revision and conflict model

Use immutable revisions carrying at least:
- Vault identity, feature/schema version and baseline epoch.
- Canonical logical path or package identifier.
- Operation type, author device identity and persistent logical sequence.
- Causal parent/frontier information.
- Content hash, byte count, category and package manifest when applicable.

Rules:
- A causally newer change supersedes its ancestors.
- Concurrent revisions use a documented total ordering over logical revision identity and stable device identity; wall-clock time is not the authority.
- Retain concurrent candidates until every device can derive the same winner. A mutable Y.Map entry alone is not an adequate conflict-history model.
- Winner ordering must be stable when events arrive out of order or are replayed.
- Preserve losing versions before replacing local bytes. Where multiple candidates exist remotely, retain enough immutable history to recover them after convergence.
- An unresolved/missing winner payload remains pending. Do not temporarily apply a different winner merely because it arrived first.
- File-level replacement is the default for JSON, matching the selected automatic-winner policy. Field-level projection for privacy is distinct from automatic merging of concurrent user edits.
- Concurrent delete versus edit uses an explicit **edit-preserving** rule; a causally later intentional deletion can still delete the edited revision. Keep an explicit tombstone.
- Renames are coherent operations or package manifest changes; never infer them from a single incomplete listing.
- If a newer local edit appears while an incoming revision is being staged, preserve/publish that local edit and recompute the winner before replacement.

Initial seeding is itself a committed operation. Joining waits for a complete seed marker and verified payloads. Concurrent first-enable attempts require a deterministic baseline election, with both proposals retained until resolution. An empty or offline device never establishes authority just by having no files.

## 5. Transfer and apply protocol

### Outgoing
1. Wait for baseline/compatibility readiness.
2. Read a stable eligible file/package and enforce policy before upload.
3. Persist the proposed revision and local recovery checkpoint.
4. Upload content and verify the carrier's completion guarantee.
5. Publish a committed metadata revision only after its referenced content is available under that carrier's documented durability model.
6. Retain pending work across shutdown, cancellation and carrier failure.

### Incoming
1. Check vault, feature version, path/category authorization and causal winner.
2. Fetch every required payload with bounded concurrency, deadlines and bounded retry/backoff.
3. Validate declared sizes, content hashes, JSON/manifests, package completeness and platform/application compatibility.
4. Recheck that live local content still matches the expected preimage.
5. Persist and verify the local backup and apply journal **before** touching live files.
6. Stage the complete transaction, then replace files only using a platform-validated strategy.
7. Verify resulting bytes; durably record applied state; suppress only matching self-generated filesystem changes.
8. Apply a supported live activation or record “stored; activation pending restart.”

Do not equate transfer completion with successful disk application or runtime activation.

Single-file replacement and multi-file transactions have different guarantees. A journal can make recovery possible, but cannot make arbitrary multi-file writes atomic. Plugin packages and enablement changes must not expose a mixed executable package to Obsidian.

**Release gate:** establish a safe package commit/recovery point on each supported platform before enabling automatic executable-package installation there. If the adapter/runtime cannot provide one, leave the package staged and report the limitation. Do not claim that YAOS startup recovery necessarily runs before other plugins load.

## 6. Runtime activation and write-back loops

Writing a settings file does not prove the running application/plugin has consumed it. Loaded plugins may retain old state and overwrite the file later.

- Maintain separate desired, disk-applied and runtime-active states.
- Use supported, tested live application APIs only for explicitly covered categories.
- Keep restart-dependent changes durably staged where necessary to avoid active-process write-back; establish the safe commit point in the feasibility stage.
- Never assume plugin shutdown callbacks can complete asynchronous disk/network work before application exit.
- Never force a restart, silently discard an editor buffer or hot-reload YAOS itself.
- Use content/revision-aware write suppression, not a fixed “ignore all events for N seconds” window.
- Detect bounded repeated divergence/write-back loops, stop the affected activation and retain both versions. Avoid endless configuration ping-pong.
- A failed local activation does not automatically publish a global rollback to otherwise healthy devices. Quarantine that revision locally; an intentional shared restore creates a new revision.

## 7. Carrier-specific contracts

| Carrier | Required behavior |
|---|---|
| Cloudflare Worker | Reuse authenticated metadata/blob transport with verified limits and retention; audit server admission/schema requirements. Preserve note-only compatibility where feasible. |
| Google Drive | Preserve configured encryption, integrity checks and session fencing. Upload complete payloads before references; retry missing/eventually visible content without declaring configuration applied. |
| Local network | Transfer verified content through authorized peers and keep a durable local cache/queue. Advertise only locally verified available content. If its only holder goes offline, remain pending—never claim cloud-like durability. |

All carriers use the same selection, conflict, deletion, backup and apply semantics. Carrier adapters only implement the transport/availability differences.

Carrier switching needs an explicit handover: verify/reseed configuration payloads on the destination before treating it as complete; retain the source/local recovery material. Missing destination blobs are not deletions.

## 8. Failure and recovery matrix

| Scenario | Required response |
|---|---|
| Offline, timeout, rate limit or transient service failure | Persist queue; bounded retry with jitter; preserve working local configuration. |
| Expired/revoked credentials | Pause affected transfers; expose a nonblocking actionable status. Do not pretend authentication can always recover unattended. |
| Missing/corrupt payload or malformed JSON | Reject/quarantine the revision, retain existing live files, retry only where meaningful. |
| Remote metadata arrives before content | Keep pending; no partial application or deletion. |
| Disk full, quota, permission error, unavailable backup | Fail before destructive replacement when possible; preserve journal/staging and block only the affected transaction. |
| Crash during backup/staging/apply | Recover from durable journal and verified backup; distinguish pre-commit from committed state. |
| Corrupt/lost journal or backup | Fail closed for affected files; do not guess authority or manufacture deletions. Surface recovery status. |
| Local edit during download/apply | Preimage mismatch cancels replacement; retain both edits and reconcile again. |
| Plugin writes files in several steps | Wait for stable complete package; enforce bounded waiting and report incomplete packages. |
| Desktop-only plugin on mobile, unsupported Obsidian version | Keep shared desired state, block local activation with a compatibility reason; never enable incompatible code. |
| Workspace contains stale paths or transient session data | Validate/defer; do not close active editors to mirror a remote layout. |
| App creates a default file after remote deletion | Distinguish startup/default regeneration from intentional changes; prevent delete/recreate loops through category-specific policy. |
| Missing listing entry, partial scan, canceled scan | No delete inference. Only a complete authoritative scan against an established baseline can propose a deletion. |
| Long-offline peer or restored old database | Rebase against current baseline/tombstones; do not resurrect deleted files from stale state. |
| Clock skew, duplicate delivery, reordered updates | Causal/logical ordering and idempotent revision application. |
| Disconnect, vault switch, unload or destroyed coordinator | Generation fencing; late results cannot write files or mutate the new session. |
| Traversal, absolute path, symlink escape, case/Unicode collision | Reject unsafe/ambiguous targets; canonical containment checks on every write. Validate platform adapter capabilities before relying on them. |
| Unknown newer feature format or older client | Gate configuration processing; preserve note sync when safe. Never reinterpret unknown config data as vault attachments. |
| External configuration-sync tool writes concurrently | Detect recurring divergence and back off/quarantine; document that multiple writers cannot guarantee stable mirroring. |
| All copies of source payload or backups are lost | Report unrecoverable state honestly; no invented recovery guarantee. |

## 9. Backups, retention, deletion and snapshots

- Recovery material lives under an always-excluded local namespace; never let the scanner re-ingest it.
- Set explicit byte/count/time budgets during implementation. When space is insufficient to retain a required preimage, block that replacement rather than discard recoverability.
- Keep at least the verified preimage needed by every pending transaction; never prune referenced pending recovery data.
- Content hashes provide integrity, not authenticity. Existing carrier authentication/encryption and trusted-device policy remain necessary.
- Determine tombstone/history compaction from membership and acknowledgement rules, not a short time-to-live alone. Retired and long-offline devices need an explicit rejoin/rebase rule.
- Audit existing snapshot writers, pruning, Drive compaction and restore UI before claiming configuration is included in restore points. Referenced configuration payloads must survive retention.
- Old snapshots containing no configuration metadata must leave live configuration unchanged.
- Configuration restoration is a new revision through the same policy/apply pipeline—not an unconditional overwrite of `.obsidian`.

## 10. Compatibility and phased implementation

### Phase 0 — feasibility and specification
- Inventory actual configuration layouts and current supported Obsidian/plugin APIs.
- Prototype adapter scanning, path containment, atomic replacement, crash recovery and safe activation on desktop and mobile.
- Specify revision ordering, simultaneous seed election, deletion rules, membership, retention and encryption treatment.
- Audit whether an additive feature-versioned metadata namespace is safely preserved by old clients, snapshots and compaction. Introduce a coordinated schema/server change only if required; do not assume either outcome.
- Produce a supported-category/platform matrix. Failure to establish safe package activation blocks that category, not ordinary note sync.

### Phase 1 — shared core and test harness
Implement policy registry, immutable revisions, baseline election, durable queue/journal, deterministic conflict resolution, backup/recovery and loop suppression against fake filesystem/carrier adapters.

### Phase 2 — three carrier adapters
Integrate and run identical contract scenarios against Cloudflare, Drive and LAN. Validate encryption, availability, cancellation, switch-over and retention behavior.

### Phase 3 — configuration categories
Start with covered settings/hotkeys/themes/snippets, then known plugin settings, then package transactions/enablement and optional workspace layouts after their platform-specific safety gates pass. This is staged delivery of the full design, not a change to the requested scope.

### Phase 4 — integration and release qualification
Add opt-in settings and quiet diagnostics; validate mixed-version behavior, snapshot recovery and migrations; run full regression suites and real-device qualification. Publish only after separate implementation/release authorization.

## 11. Acceptance tests

Required automated coverage:
- Three-device convergence under every ordering of concurrent updates, deletes, renames and package revisions; property-based randomized schedules in addition to hand-written examples.
- Initial seed, simultaneous seed election, new/empty joiner, offline joiner, stale database and carrier switching.
- Fault injection before/after every durable transaction boundary, including backup failure and process termination.
- Missing/corrupt/oversized content, malformed manifests/JSON, network stalls, quota/rate-limit errors and revoked credentials.
- Local edits during application, self-generated changes, plugin write-back loops and incomplete package updates.
- Custom config directory, path traversal, symlink escape, case/Unicode collisions and mobile adapter differences.
- Secrets and internal files never enter shared metadata, payloads, diagnostic logs or recoverable cloud history by accident.
- Older clients and snapshots do not delete, leak, overwrite or reinterpret configuration state.
- No regression to existing notes, attachments, encryption, restore, compaction or shutdown behavior.

Required real-device qualification:
- Desktop ↔ desktop, desktop ↔ Android, desktop ↔ iOS for carriers supported there; LAN remains desktop-only.
- Actual plugin installation/upgrade, restart-dependent settings, workspace behavior, application termination during commit, and storage/permission failures where reproducible.
- Explicitly document anything not exercised. Fake adapters and loopback TLS do not prove mobile filesystem or Obsidian activation safety.

Success means automatic convergence of eligible supported state, recoverable conflicts, truthful pending/blocked status, no routine approval prompts, no forced restart, and no silent unsafe overwrite. Failures requiring credentials, free disk space or manual recovery cannot be solved solely by automation.

## 12. Mandatory scenario register and coverage evidence

The companion [scenario register](config-sync-scenario-register.md) is a required part of this plan. It expands the failure matrix into numbered requirements, cross-scenario combinations, release gates and unresolved engineering decisions.

Every scenario must be traced to implementation and verification evidence or an explicit runtime-enforced unsupported case. All entries initially remain **unimplemented**. No scenario is treated as covered merely because it is listed. Unresolved safety-critical cases block the affected category; any reduction to the agreed scope requires approval.

Unknown conditions must preserve available last-known-good state and recovery material, pause affected operations, and report a nonblocking diagnostic. This is a fail-safe design requirement, not a claim that every conceivable failure or third-party plugin behavior can be predicted.

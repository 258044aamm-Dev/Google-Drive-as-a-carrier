# Configuration sync coverage — first implementation increment

This is **not** a claim that the 122-scenario plan is complete. The shipping candidate is a **default-off staging preview**, with no live configuration writes or activation. Executable code, deletion and other unqualified categories are blocked. Core note/attachment exclusion rules remain unchanged.

Tests execute narrower staging/protocol cases than the complete operational scenarios. A referenced test is **partial evidence**, not proof of the full scenario or its interactions. None of the full 122 scenarios is marked universally complete in this report. Automated full-suite results belong in release notes; real Obsidian/mobile qualification remains outstanding.

Scenario IDs below are traceability labels, not permission to omit their remaining requirements. Details: `config-sync-plan.md`, `config-sync-scenario-register.md`, `config-sync-preview.md`.

| ID | Scenario | Status | Partial evidence / gate |
|---|---|---|---|
| A01 | Existing populated source: | Partially implemented/tested in staging preview; full scenario remains open | initial baseline contains only approved projections and no live-file writes |
| A02 | Empty/new joining device: | Partially implemented/tested in staging preview; full scenario remains open | empty device cannot seed or publish deletions |
| A03 | Populated joining device: | Partially implemented/tested in staging preview; full scenario remains open | joining populated device does not overwrite or republish its initial local files |
| A04 | Simultaneous first enablement: | Partially implemented/tested in staging preview; full scenario remains open | simultaneous baselines elect one deterministically and retain both proposals |
| A05 | Seeder crashes or disconnects: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| A06 | Join while offline or before remote enumeration completes: | Partially implemented/tested in staging preview; full scenario remains open | no scanning or metadata writes before full readiness |
| A07 | Long-offline or retired device returns: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| A08 | Device identity cloned by copying a vault: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| A09 | Local identity/counter storage lost or rolled back: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| A10 | Multiple app windows/processes for one vault: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| A11 | Two devices share a filesystem through another sync tool: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| A12 | Wrong vault, vault copy, renamed/moved vault or changed vault ID: | Partially implemented/tested in staging preview; full scenario remains open | mismatched vault checkpoint is ignored rather than imported; identity/readiness change during capture prevents publication |
| B01 | Enable/disable the whole feature during work: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| B02 | Add/remove a category or path filter: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| B03 | Device-local selection differs from shared desired policy: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| B04 | Unknown plugin settings: | Partially implemented/tested in staging preview; full scenario remains open | hotkeys are structured and canonical, not opaque plugin settings |
| B05 | Known plugin changes settings schema: | Partially implemented/tested in staging preview; full scenario remains open | appearance projection admits bounded reviewed fields only |
| B06 | Secrets nested in arrays/objects or encoded in values: | Partially implemented/tested in staging preview; full scenario remains open | app projection excludes credentials, endpoints, unknown and prototype fields |
| B07 | Local-only fields coexist with shared fields: | Partially implemented/tested in staging preview; full scenario remains open | app projection excludes credentials, endpoints, unknown and prototype fields |
| B08 | Credentials already uploaded under an earlier policy: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| B09 | Incoming configuration tries to widen trust, enable code sync, change endpoints or disable YAOS: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| B10 | YAOS directory, journals, backups, logs, lock files or staging are encountered: | Partially implemented/tested in staging preview; full scenario remains open | original config-directory exclusion remains unchanged; initial baseline contains only approved projections and no live-file writes |
| B11 | Another plugin contains its own backups/caches/binaries: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| B12 | Privacy policy differs across app/plugin versions: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| C01 | Non-default active config directory: | Partially implemented/tested in staging preview; full scenario remains open | a custom configuration directory is read without scanning unrelated paths |
| C02 | Config directory changes while operations are queued: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| C03 | Absolute paths, traversal, backslashes, repeated separators or encoded traversal: | Partially implemented/tested in staging preview; full scenario remains open | malformed, excessive, array and unsafe paths fail closed |
| C04 | Symlinks, junctions or ancestor substitution between check and write: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| C05 | Case-only rename, Unicode normalization collision, reserved names, trailing dots/spaces or invalid characters: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| C06 | Long paths, deep trees, excessive entry counts or huge files: | Partially implemented/tested in staging preview; full scenario remains open | oversized or inaccurate stat data cannot bypass payload validation |
| C07 | File replaced by directory or directory by file: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| C08 | Read-only files, permissions, sharing locks or unavailable volume: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| C09 | Disk full, quota exhaustion or space runs out during rollback: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| C10 | Adapter lacks atomic replacement, durable flush or required locking: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| C11 | Stat/mtime lies, low timestamp resolution or same-size modification: | Partially implemented/tested in staging preview; full scenario remains open | oversized or inaccurate stat data cannot bypass payload validation |
| C12 | Partial enumeration, inaccessible child or canceled scan: | Partially implemented/tested in staging preview; full scenario remains open | missing previously observed file never emits an implicit deletion |
| C13 | Transient read failure/zero-byte temporary file during editor save: | Partially implemented/tested in staging preview; full scenario remains open | file changing between reads is not published |
| C14 | BOM, encoding, newline differences or arbitrary binary files: | Partially implemented/tested in staging preview; full scenario remains open | malformed, excessive, array and unsafe paths fail closed |
| D01 | Concurrent edits to one file: | Partially implemented/tested in staging preview; full scenario remains open | concurrent edits converge in either delivery order with losers retained; three concurrent writers converge under all six arrival permutations |
| D02 | Concurrent independent files/packages: | Partially implemented/tested in staging preview; full scenario remains open | concurrent edits converge in either delivery order with losers retained |
| D03 | Edit versus delete: | Partially implemented/tested in staging preview; full scenario remains open | missing previously observed file never emits an implicit deletion |
| D04 | Delete followed by recreate at the same path: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| D05 | Rename versus edit/delete/another rename: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| D06 | Rename onto an existing target or case/Unicode-equivalent target: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| D07 | Duplicate delivery, retries, acknowledgement loss or replay: | Partially implemented/tested in staging preview; full scenario remains open | unchanged local config does not echo a remotely staged winner; three concurrent writers converge under all six arrival permutations |
| D08 | Reordered metadata/content and delayed older revisions: | Partially implemented/tested in staging preview; full scenario remains open | concurrent edits converge in either delivery order with losers retained |
| D09 | Device clock jumps backward/forward or counter overflow: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| D10 | Parent revision/history missing: | Partially implemented/tested in staging preview; full scenario remains open | missing parents, forged rank and unknown versions block processing |
| D11 | Excessive or malformed causal graph: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| D12 | Tombstone/history cleanup with inactive peers: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| D13 | Local edits appear while a remote winner is downloading/applying: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| D14 | Obsidian regenerates a deleted default file: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| E01 | Offline, partition, captive portal, DNS failure or half-open request: | Partially implemented/tested in staging preview; full scenario remains open | timeout releases queue and late read cannot publish |
| E02 | Rate limit, service overload, transient errors or quota: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| E03 | Revoked/expired credentials or lost permissions: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| E04 | Metadata exists but payload is missing: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| E05 | Truncated/corrupt response, wrong hash, wrong length or substituted content: | Partially implemented/tested in staging preview; full scenario remains open | tampered bytes and wrong-vault metadata cannot become staged winners |
| E06 | Wrong vault, wrong encryption key or replay across content purposes: | Partially implemented/tested in staging preview; full scenario remains open | tampered bytes and wrong-vault metadata cannot become staged winners |
| E07 | Encryption disabled, enabled or key rotated: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| E08 | Drive delayed listing, duplicate names, moved/deleted folders or late write response: | Partially implemented/tested in staging preview; full scenario remains open | real Drive transport carries staged projections with encryption and ordinary notes |
| E09 | Worker compatibility/authentication/size limits: | Partially implemented/tested in staging preview; full scenario remains open | tests/live/config-sync-preview.ts: real local Worker, ordinary notes and late joining client |
| E10 | LAN source disconnects mid-transfer or only holder is offline: | Partially implemented/tested in staging preview; full scenario remains open | real loopback LAN transport carries staged projections without live config writes |
| E11 | LAN relay supplies malformed/unauthorized content: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| E12 | Carrier switch with outstanding writes: | Partially implemented/tested in staging preview; full scenario remains open | identity/readiness change during capture prevents publication |
| E13 | Same document used simultaneously through multiple carriers: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| E14 | Background suspension, network change or application resume: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| E15 | Retry queue flood or one repeatedly failing payload: | Partially implemented/tested in staging preview; full scenario remains open | storage failures are bounded, redacted, and do not alter source files |
| F01 | Crash before/after each outgoing checkpoint: | Partially implemented/tested in staging preview; full scenario remains open | checkpoint write failure retains shared proposal without duplicate publication on retry |
| F02 | Crash before/after each incoming backup, journal, stage, replacement, verification and completion checkpoint: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| F03 | Power loss, journal corruption or ambiguous commit: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| F04 | Backup fails, corrupts or cannot be read back: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| F05 | Multi-file transaction stops halfway: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| F06 | Restore/rollback itself fails: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| F07 | Startup recovery races with another instance or plugin loading: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| F08 | Cancellation, feature disablement, vault switch or coordinator destruction: | Partially implemented/tested in staging preview; full scenario remains open | timeout releases queue and late read cannot publish; destroy during read prevents checkpoint and publication |
| F09 | Queue/index/database lost while live files survive: | Partially implemented/tested in staging preview; full scenario remains open | persisted source checkpoint captures edits made while app was closed; checkpoint write failure retains shared proposal without duplicate publication on retry |
| F10 | Recovery data on the same failed disk is lost: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| F11 | Old temporary files/abandoned staging accumulate: | Partially implemented/tested in staging preview; full scenario remains open | history cap pauses rather than pruning recoverable alternatives |
| F12 | Backup retention budget exhausted: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| G01 | Plugin install/update consists of manifest, JavaScript, CSS and additional assets: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| G02 | Source updater is still writing the package: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| G03 | Enablement list arrives before package: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| G04 | Plugin uninstall/disable while settings or package transfer is pending: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| G05 | Desktop-only plugin on mobile, minimum app version, unsupported API or missing dependency: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| G06 | Manifest identity differs from directory/package identity: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| G07 | Running plugin rewrites its settings after remote disk replacement: | Partially implemented/tested in staging preview; full scenario remains open | unchanged local config does not echo a remotely staged winner |
| G08 | Plugin needs a restart or offers no supported reload API: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| G09 | Plugin code upgrade migrates settings incompatibly: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| G10 | Plugin crash, failed load or corrupted startup configuration: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| G11 | Plugin initialization modifies other selected configuration: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| G12 | Plugin introduces its own database, native module, generated artifact or executable: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| G13 | Community/core plugin ordering or cross-plugin dependencies: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| G14 | Malicious or compromised paired device sends validly hashed executable code: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| G15 | YAOS package/settings or the enabled-plugin list would remove the sync engine: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| H01 | Unsupported core setting or app-version-specific format: | Partially implemented/tested in staging preview; full scenario remains open | appearance projection admits bounded reviewed fields only |
| H02 | OS-specific paths, external commands or absolute executable paths: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| H03 | Appearance references missing theme/snippet: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| H04 | Workspace references deleted notes, unknown views or unavailable plugins: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| H05 | Desktop/mobile workspace formats differ: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| H06 | Current window/session changes workspace continually: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| H07 | Hotkeys/settings conflict with platform capabilities: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| H08 | Safe mode/restricted mode disables community plugins: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| I01 | Older YAOS peer sees unknown config metadata: | Partially implemented/tested in staging preview; full scenario remains open | an opaque older replica and whole-document snapshot preserve the namespace |
| I02 | Newer unknown config schema/policy arrives: | Partially implemented/tested in staging preview; full scenario remains open | missing parents, forged rank and unknown versions block processing |
| I03 | Upgrade/downgrade midway through an apply journal: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| I04 | Old snapshot contains no configuration: | Partially implemented/tested in staging preview; full scenario remains open | preview does not modify note maps or the ordinary configuration exclusion; an opaque older replica and whole-document snapshot preserve the namespace |
| I05 | Snapshot contains config metadata but referenced content was pruned: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| I06 | Restore an older config snapshot: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| I07 | Snapshot or carrier compaction encounters unknown/corrupt metadata: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| I08 | Content garbage collection races with upload, history retention or restore: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| I09 | Privacy policy changes after snapshot creation: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| I10 | Full config reset/reseed or abandoned vault epoch: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| J01 | Very large directory, many small files or repeated rapid changes: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| J02 | Mobile battery/background restrictions or long process suspension: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| J03 | Invalid metadata sizes/counts or decompression/resource bombs: | Partially implemented/tested in staging preview; full scenario remains open | malformed, excessive, array and unsafe paths fail closed; history cap pauses rather than pruning recoverable alternatives |
| J04 | Diagnostics include sensitive paths/values or payload fragments: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| J05 | Transfer complete but disk apply/activation pending: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| J06 | Persistent blocked state: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| J07 | Regression in notes, attachments, encryption, restore, compaction or unload: | Partially implemented/tested in staging preview; full scenario remains open | original config-directory exclusion remains unchanged; preview does not modify note maps or the ordinary configuration exclusion |
| J08 | Untested platform/carrier/category combination: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| J09 | Flaky concurrency test: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |
| J10 | Unknown future plugin/OS behavior: | Open / safety-gated; not verified | No completion claim. See preview scope and next implementation gates. |

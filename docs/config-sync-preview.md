# Configuration sync — safety-gated staging preview

## What this delivery is, and is not

This is the **first implementation increment**, not the completed configuration-mirroring plan.

It adds a default-off shared configuration data path for **Cloudflare Worker, Google Drive and Local network**. It automatically captures reviewed projections of three JSON files, exchanges immutable revisions through the existing carrier, and stages a deterministic desired state in the local Yjs replica.

**It never writes the staged values into live configuration files. Restarting Obsidian does not activate them.** Package installation, configuration application, backups before replacement, automatic activation, deletions, reset/reseed and configuration restore commands are NOT implemented in this preview. They remain safety gates, not hidden experimental behavior.

The implementation deliberately has no live-file write/remove/rename or plugin-activation capability. Normal settings persistence still stores the local feature toggle and source hashes in YAOS's existing settings file.

## Enabling and observing

Settings → YAOS → **Configuration sync (safety preview)** → **Stage reviewed configuration**.

The default is off, including for existing installations. The row is available for all three carriers. It requires working local persistence and carrier catch-up before scanning. Check the configuration status in settings; reopen the settings page to refresh its displayed status.

- Reviewed changes are captured on a 30-second foreground timer, with bounded retries/backoff after failures. Background scheduling is subject to the host's suspension behavior.
- A new populated device seeds the baseline when the caught-up document contains none.
- A joining device keeps its live configuration unchanged; its first scan does not override the shared baseline.
- Subsequent source changes become immutable proposals. Local source hashes survive normal restarts, so later source changes can be detected.
- A deterministic winner is staged per file; concurrent alternatives and prior versions remain in history.
- Absence never publishes a deletion. An empty device cannot seed.
- Disabling stops capture, but **does not erase already-shared history**. Purging/retention migration is a future gated operation.

## Exact admitted content

Only these logical paths below the device's active `app.vault.configDir` are read:

| File | Shared projection |
|---|---|
| `app.json` | Boolean values for `alwaysUpdateLinks`, `readableLineLength`, `strictLineBreaks`, `showLineNumber`, `spellcheck`, `vimMode`, `foldHeading`, `foldIndent`, `autoPairBrackets`, `autoPairMarkdown`, `smartIndentList`. |
| `appearance.json` | Integer `baseFontSize` from 8–48; `theme` equal to `obsidian`, `moonstone` or `system`; six-digit hex `accentColor`. |
| `hotkeys.json` | Validated command IDs and arrays of key/modifier bindings. Unknown binding fields or unsupported encodings block capture; this is not arbitrary plugin configuration. |

Other app/appearance fields never enter the projection. Hotkey command IDs and key bindings are shared data: do not intentionally place sensitive information in them. These policies are format allowlists, **not a universal secret detector**.

Plugin settings/code, enabled-plugin lists, themes, snippets, workspaces and arbitrary files are not scanned. YAOS's own settings, auth material, device identity, caches and recovery state are not part of shared configuration metadata.

The existing exclusion of the configuration directory from normal note and attachment pipelines stays in place. No CRDT schema bump or Worker implementation change is made by this preview.

## Data model and limits

- Isolated namespace: `yaos.config.preview.v1`. This is a preview protocol, not a guarantee of permanent format stability.
- Content-addressed, canonical JSON revisions are bound to the vault and contain only projected values.
- Source payloads are inlined into the metadata to avoid introducing unqualified blob retention/availability semantics in this increment.
- First connected seeding normally establishes the baseline. Simultaneous seed proposals elect the lexicographically smallest content-addressed seed ID; both remain retained. That election may change the staged baseline when delayed concurrent proposals arrive; no live files are changed.
- Changes name causal parents. Concurrent tips are ordered by logical rank, author identity and content-addressed revision ID, not device time. Different files resolve independently.
- Session-random author IDs avoid dependence on a copied persistent device counter for this preview. Complete device membership/retirement and trusted-author provenance are future protocol gates.
- Each source file is limited to 32 KiB. Total visible preview history is capped at 128 revisions and 512 KiB. No automatic history deletion occurs: reaching a cap blocks further capture instead of discarding alternatives. These budgets limit this preview; they do not change note/attachment size settings.
- Missing parents, invalid hashes, unsupported formats or a corrupt history block preview processing rather than guessing a winner.
- Existing carrier authentication and configured encryption apply. This feature does not add encryption to an unencrypted carrier, and a hash does not authenticate a publisher.

These application-level checks do not prevent an already-authorized malicious Yjs peer from sending an oversized document through the existing transport. They are not a new security boundary around trusted peer code.

## Failure and lifecycle behavior

- Read-only capture checks file size, reads twice, and publishes only a stable canonical projection. A stable read is not proof of atomic multi-file capture; executable packages are therefore blocked.
- One bounded cycle runs at a time. A five-second deadline fences late continuations; unabortable reads may still finish but cannot publish into an ended cycle.
- After three storage/integrity/timeout failures, the preview pauses. Toggle it off/on to retry after fixing the cause. Rapid edits, a changed document and temporary loss of readiness trigger rescan rather than consuming that failure budget.
- Local persistence unavailability or an incomplete carrier blocks capture.
- Vault, config-directory, carrier or server identity changes pause capture until the runtime is reloaded; an old document must not be relabeled as a new vault.
- Source checkpoint failure retains the published proposal for retry. It does not imply a durable acknowledgement from another device.
- Malformed eligible source JSON currently blocks the small preview batch. Per-category independent scanning is a future improvement; note and attachment sync continue independently.
- Status distinguishes staging from application. Local Yjs staging is not a promise of a separate disaster backup or remote durability.

## Verification and limits of evidence

The regression suite covers projection privacy, malformed input, size/path limits, startup readiness, empty seeding, joining, no echo loops, restart checkpoints, missing files, source races, bounded failure handling, timeout/destruction fencing, deterministic conflicts, duplicate/reordered delivery, baseline election, integrity, history limits and preservation of note maps.

Carrier checks use:
- Actual Drive transport and encryption against **FakeDrive**, not a real Google account.
- Actual LAN transport over loopback TLS, not multiple physical PCs.
- Actual local Cloudflare Worker with three WebSocket clients, alongside ordinary note updates.

An opaque Yjs replica/full-document round trip checks preservation of unknown metadata. This is not blanket qualification of all historical YAOS builds, snapshot restore paths or mobile versions.

Real Obsidian desktop/Android/iOS activation and filesystem crash recovery have not been qualified. There is no automatic disk-application path to test in this increment. The full 122-scenario register remains open; see `config-sync-coverage.md` for traceability.

## Next implementation gates

1. Confirm category-specific safe activation APIs and application startup ordering on real devices.
2. Implement validated filesystem containment, single-writer ownership, durable backup/journal and replacement/recovery protocols.
3. Qualify privacy policies for additional categories, plugin setting schemas and executable package boundaries.
4. Add explicit deletion, membership/epoch transitions, retention, carrier handover and config-aware snapshot restore.
5. Qualify the full scenario/interaction register before advertising full automatic mirroring.

Do not enable live writes merely because transport tests pass. The safety preview is intentionally useful for testing the shared data path without making that leap.

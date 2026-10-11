/**
 * YAOS CRDT schema version constant.
 *
 * This module is intentionally Obsidian-free so it can be imported
 * in Node regression tests and server code without the Obsidian dependency.
 *
 * Schema versioning semantics:
 *   v1 — legacy path model (pathToId authoritative)
 *   v2 — id-first model (meta.path authoritative), flat JSON metadata values
 *   v3 — nested Y.Map metadata (field-level CRDT), lazy on-write migration
 *
 * Bump this constant AND SERVER_MIN/MAX_SCHEMA_VERSION in server/src/version.ts
 * together whenever a breaking schema change ships.
 */
export const SCHEMA_VERSION = 3;

/**
 * F2: what to tell the user about a stored schema version this plugin cannot
 * read, or null when it can. One function so the engine, the Drive carrier and
 * the Local network carrier all refuse the same rooms with the same wording.
 *
 * Rules (unchanged from the original check in `VaultSync.checkSchemaVersion`):
 *   - not a number (absent, null, corrupt) -> readable, "first run"
 *   - <= SCHEMA_VERSION                    -> readable (same or older)
 *   - >  SCHEMA_VERSION                    -> refused, the user must update
 */
export function schemaAdmissionError(stored: unknown): string | null {
	if (typeof stored !== "number") return null;
	if (stored > SCHEMA_VERSION) {
		return (
			`CRDT schema version ${stored} is newer than this plugin supports (v${SCHEMA_VERSION}). ` +
			`Update the plugin or risk data corruption.`
		);
	}
	return null;
}

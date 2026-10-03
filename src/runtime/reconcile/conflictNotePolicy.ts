/**
 * Conflict notes ("<name> (YAOS conflict ... ).md") are local safety copies and
 * are not meant to sync. A vault can still hold some as ACTIVE shared entries
 * (they synced in 2.1.0, and an older device can still send them). Two rules
 * keep such an entry from coming back after you delete the file:
 *
 *  - a delete of a conflict note that is an active shared entry is recorded like
 *    any note's delete, so every device drops it and the delete sticks;
 *  - the full reconcile never writes a conflict note from the shared document to
 *    disk when it is missing locally (it is local-only by contract).
 *
 * Both rules look only at conflict-note paths. Every other path is untouched.
 * Pure functions.
 */
import { isMarkdownConflictArtifactPath } from "../../sync/markdownConflictArtifact";

/** Should a vault "delete" event for this markdown path be recorded in the shared document? */
export function shouldRecordMarkdownDelete(input: {
	path: string;
	/** `isMarkdownPathSyncable(path)`: true for an ordinary, non-ignored note. */
	syncable: boolean;
	/** The shared document holds an active entry for this path. */
	activeInSharedDoc: boolean;
}): boolean {
	if (input.syncable) return true;
	return isMarkdownConflictArtifactPath(input.path) && input.activeInSharedDoc;
}

/** Drop conflict notes from the list of shared paths a reconcile would write to disk. */
export function withoutConflictNotes(paths: readonly string[]): string[] {
	return paths.filter((path) => !isMarkdownConflictArtifactPath(path));
}

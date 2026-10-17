/**
 * Offline-delete policy (SYNC-01).
 *
 * A note that is active in the CRDT but missing on disk used to be written
 * back unconditionally at the next authoritative reconcile. That is right for a
 * note this device never had (new device, remote creation), but wrong for a
 * note this device HAD in sync and the user deleted while YAOS was off or before
 * the first reconcile finished: the delete came back.
 *
 * One content-based rule tells the two apart. The disk index stores the hash of
 * the text this device last knew to be on disk and in sync. If that hash still
 * equals the hash of the CRDT text, nothing has changed since the file was
 * there, so its absence is a deliberate local delete. Anything else keeps the
 * old behaviour (write the CRDT text back):
 *
 *   no index entry, or no baseline hash  -> never materialised here: write
 *   baseline hash != CRDT hash           -> someone edited it meanwhile: write
 *                                           (the edit is not lost to a delete)
 *   baseline hash == CRDT hash           -> proven local delete: tombstone
 *
 * Pure functions only; the reconciliation controller supplies the hashes.
 */

/** Same shape as the existing reconcile safety brake: more than 20 AND more than 25 %. */
export const OFFLINE_DELETE_BRAKE_MIN_COUNT = 20;
export const OFFLINE_DELETE_BRAKE_MIN_RATIO = 0.25;

export type MissingOnDiskDecision = "treat-as-local-delete" | "write-crdt-to-disk";

export function classifyMissingOnDisk(input: {
	/** `contentHash` from the persisted disk index for this path, if any. */
	baselineHash: string | null | undefined;
	/** Hash of the CRDT text, or null when the text is unavailable. */
	crdtHash: string | null;
}): MissingOnDiskDecision {
	const { baselineHash, crdtHash } = input;
	if (!baselineHash || !crdtHash) return "write-crdt-to-disk";
	return baselineHash === crdtHash ? "treat-as-local-delete" : "write-crdt-to-disk";
}

export interface OfflineDeleteBatchDecision {
	allowed: boolean;
	reason?: string;
}

/**
 * Guards against mass deletion when the vault was not loaded (empty or partial
 * file list at startup): if many tracked notes look deleted at once, none of
 * them is treated as a delete and the old behaviour (write them back) applies.
 */
export function evaluateOfflineDeleteBatch(input: {
	candidateCount: number;
	/** Active CRDT paths that have a baseline hash in the index. */
	trackedCount: number;
	/** Markdown files found on disk by this reconcile. */
	diskPresentCount: number;
}): OfflineDeleteBatchDecision {
	const { candidateCount, trackedCount, diskPresentCount } = input;
	if (candidateCount === 0) return { allowed: true };
	if (diskPresentCount === 0 && candidateCount > 1) {
		return { allowed: false, reason: `${candidateCount} notes look deleted but no markdown file was found on disk` };
	}
	const ratio = trackedCount > 0 ? candidateCount / trackedCount : 1;
	if (candidateCount > OFFLINE_DELETE_BRAKE_MIN_COUNT && ratio > OFFLINE_DELETE_BRAKE_MIN_RATIO) {
		return {
			allowed: false,
			reason: `${candidateCount} notes look deleted (${Math.round(ratio * 100)}% of tracked notes)`,
		};
	}
	return { allowed: true };
}

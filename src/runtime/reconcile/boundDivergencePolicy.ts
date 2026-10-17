/**
 * SYNC-02: an editor-bound note whose disk text and CRDT text differ is
 * resolved by taking one side (the editor/disk side in the "local only" branch,
 * the disk side in the "external edit while idle" branch). That is a clean
 * resolution only if the other side did not change on its own.
 *
 * With the persisted baseline hash (the text last known to be in sync) it is
 * decidable: when the disk text and the CRDT text BOTH differ from the baseline
 * and from each other, taking one side silently discards the other side's edit.
 * Then the side that is about to be overwritten is kept as a conflict note
 * first. Without a baseline nothing is claimed and the old behaviour applies.
 */
export function bothSidesChangedFromBaseline(input: {
	baselineHash: string | null | undefined;
	diskHash: string;
	crdtHash: string;
}): boolean {
	const { baselineHash, diskHash, crdtHash } = input;
	if (!baselineHash) return false;
	return diskHash !== crdtHash && diskHash !== baselineHash && crdtHash !== baselineHash;
}

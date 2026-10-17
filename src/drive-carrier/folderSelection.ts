import type { DriveApi, DriveFolderInfo } from "./driveApi";
import { inspectFolderFingerprint, type FolderFingerprintInspection } from "./folderFingerprint";

/** Read-only candidate decision. No fallback to an oldest wrong-vault folder. */
export type FolderDecision =
	| { kind: "selected"; folder: DriveFolderInfo; inspection: Extract<FolderFingerprintInspection, { kind: "identified" }> }
	| { kind: "none" }
	| { kind: "needs-choice"; reason: string; folderIds: string[] };

/**
 * Returns only an unambiguous verified vault folder. A saved folder ID is
 * authoritative for a renamed folder, but must still match the vault ID and
 * expected fingerprint. Discovery never mutates Drive or creates a folder.
 */
export async function selectVerifiedFolder(
	api: DriveApi,
	name: string,
	vaultId: string,
	savedId?: string,
	expectedFingerprint?: string,
): Promise<FolderDecision> {
	const candidates = await api.findFolders(name);
	const sorted = [...candidates].sort((a, b) => a.createdTime - b.createdTime || a.id.localeCompare(b.id));
	const pinned = savedId?.trim();
	if (pinned) {
		// getFile errors propagate: a 404/permission refusal does not prove that
		// another folder is the same history. A renamed folder is still valid.
		const info = await api.getFile(pinned);
		if (info.trashed || (info.mimeType && info.mimeType !== "application/vnd.google-apps.folder")) {
			return { kind: "needs-choice", reason: "The remembered Drive folder is no longer usable.", folderIds: [pinned] };
		}
		const inspected = await inspectFolderFingerprint(api, pinned);
		if (inspected.kind !== "identified" || inspected.vaultId !== vaultId || (expectedFingerprint && inspected.fingerprint !== expectedFingerprint)) {
			return { kind: "needs-choice", reason: "The remembered Drive folder does not match this vault and its expected fingerprint.", folderIds: [pinned] };
		}
		return { kind: "selected", folder: { id: pinned, createdTime: info.createdTime }, inspection: inspected };
	}
	const matches: { folder: DriveFolderInfo; inspection: Extract<FolderFingerprintInspection, { kind: "identified" }> }[] = [];
	const uncertain: string[] = [];
	for (const folder of sorted) {
		const inspected = await inspectFolderFingerprint(api, folder.id);
		if (inspected.kind === "identified" && inspected.vaultId === vaultId) {
			if (!expectedFingerprint || inspected.fingerprint === expectedFingerprint) matches.push({ folder, inspection: inspected });
			else uncertain.push(folder.id);
		} else if (inspected.kind !== "identified" || inspected.vaultId === null) uncertain.push(folder.id);
	}
	if (matches.length > 1) return { kind: "needs-choice", reason: "Several folders hold this vault. Select the intended history explicitly.", folderIds: matches.map((m) => m.folder.id) };
	if (matches.length === 1 && uncertain.length === 0) return { kind: "selected", ...matches[0]! };
	if (matches.length === 1 && !expectedFingerprint && uncertain.length > 0) {
		// A verified match beats unknown candidates; never create metadata in an
		// unknown folder or treat one as an additional copy of this vault.
		return { kind: "selected", ...matches[0]! };
	}
	if (uncertain.length > 0) return { kind: "needs-choice", reason: "Drive folders with missing or mismatched identity need verification.", folderIds: uncertain };
	if (sorted.length > 0) return { kind: "needs-choice", reason: "The visible folders belong to a different vault.", folderIds: sorted.map((f) => f.id) };
	return { kind: "none" };
}

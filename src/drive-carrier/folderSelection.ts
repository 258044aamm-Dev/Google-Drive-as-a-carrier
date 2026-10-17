import { DriveError, FOLDER_MIME, type DriveApi, type DriveFolderInfo } from "./driveApi";
import { inspectFolderFingerprint, type FolderFingerprintInspection } from "./folderFingerprint";

type Identified = Extract<FolderFingerprintInspection, { kind: "identified" }>;

/** Read-only candidate decision. Callers must not turn ambiguity into a new folder. */
export type FolderDecision =
	| { kind: "selected"; folder: DriveFolderInfo; inspection: Identified }
	| { kind: "legacy"; folder: DriveFolderInfo; inspection: Identified }
	| { kind: "empty"; folder: DriveFolderInfo }
	| { kind: "none" }
	| { kind: "needs-choice"; reason: string; folderIds: string[] };

/**
 * Inspect every visible folder before deciding. `legacy` (one metadata record
 * without a vaultId) is NOT a verified match: the caller must migrate/confirm
 * it before treating it as a fingerprinted vault. This helper never writes.
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
		let info;
		try {
			info = await api.getFile(pinned);
		} catch (err) {
			if (err instanceof DriveError && err.notFound) {
				return { kind: "needs-choice", reason: "The remembered Drive folder is unavailable; it may be hidden by this Google sign-in.", folderIds: [pinned] };
			}
			throw err; // network failures must not be mistaken for missing history
		}
		if (info.trashed || (info.mimeType && info.mimeType !== FOLDER_MIME)) {
			return { kind: "needs-choice", reason: "The remembered Drive folder is no longer usable.", folderIds: [pinned] };
		}
		const folder = { id: pinned, createdTime: info.createdTime };
		const inspected = await inspectFolderFingerprint(api, pinned);
		if (inspected.kind === "identified" && inspected.vaultId === vaultId && (!expectedFingerprint || inspected.fingerprint === expectedFingerprint)) {
			return { kind: "selected", folder, inspection: inspected };
		}
		if (inspected.kind === "identified" && inspected.vaultId === null && inspected.schema === 1 && !expectedFingerprint) {
			return { kind: "legacy", folder, inspection: inspected };
		}
		if (inspected.kind === "empty" && !expectedFingerprint) return { kind: "empty", folder };
		return { kind: "needs-choice", reason: "The remembered Drive folder does not match this vault and its expected fingerprint.", folderIds: [pinned] };
	}
	const matches: { folder: DriveFolderInfo; inspection: Identified }[] = [];
	const unknown: string[] = [];
	let sole: { folder: DriveFolderInfo; inspection: FolderFingerprintInspection } | null = null;
	for (const folder of sorted) {
		const inspection = await inspectFolderFingerprint(api, folder.id);
		if (sorted.length === 1) sole = { folder, inspection };
		if (inspection.kind === "identified" && inspection.vaultId === vaultId) matches.push({ folder, inspection });
		else if (inspection.kind !== "identified" || inspection.vaultId === null) unknown.push(folder.id);
	}
	// A hash never licenses ignoring a different initialized history for this vault.
	if (matches.length > 1) return { kind: "needs-choice", reason: "Several folders hold this vault. Select the intended history explicitly.", folderIds: matches.map((m) => m.folder.id) };
	const match = matches[0];
	if (match) {
		if (expectedFingerprint && match.inspection.fingerprint !== expectedFingerprint) {
			return { kind: "needs-choice", reason: "The visible folder's fingerprint differs from the one this device remembers.", folderIds: [match.folder.id] };
		}
		return { kind: "selected", ...match };
	}
	if (sole?.inspection.kind === "identified" && sole.inspection.vaultId === null && sole.inspection.schema === 1 && !expectedFingerprint) {
		return { kind: "legacy", folder: sole.folder, inspection: sole.inspection };
	}
	if (sole?.inspection.kind === "empty" && !expectedFingerprint) return { kind: "empty", folder: sole.folder };
	if (unknown.length > 0) return { kind: "needs-choice", reason: "Drive folders with missing or unreadable identity need verification.", folderIds: unknown };
	if (sorted.length > 0) return { kind: "needs-choice", reason: "The visible folders belong to a different vault.", folderIds: sorted.map((f) => f.id) };
	return { kind: "none" };
}

import type { DriveApi } from "./driveApi";
import { META_NAME } from "./fileFormat";

/**
 * A stable fingerprint of the random installId already written into each new
 * vault folder's meta.json. This is an identity, NOT a content checksum or an
 * authentication proof. No remote files are modified by these helpers.
 */
export async function fingerprintForInstallId(installId: string): Promise<string> {
	const bytes = new TextEncoder().encode(`YAOS-folder-v1:${installId}`);
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type FolderFingerprintInspection =
	| { kind: "empty" }
	| { kind: "unreadable" }
	| { kind: "identified"; vaultId: string | null; fingerprint: string | null; schema: unknown };

/** Read the canonical (oldest) meta file, matching DriveKeyring's selection. */
export async function inspectFolderFingerprint(api: DriveApi, folderId: string): Promise<FolderFingerprintInspection> {
	// A failed listing must propagate: network errors do not imply an empty folder.
	const files = await api.listFiles(folderId);
	const meta = files.filter((f) => f.name === META_NAME)
		.sort((a, b) => a.createdTime - b.createdTime || a.id.localeCompare(b.id))[0];
	if (!meta) return { kind: "empty" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(await api.readFile(meta.id)));
	} catch {
		return { kind: "unreadable" };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { kind: "unreadable" };
	const record = parsed as Record<string, unknown>;
	return {
		kind: "identified",
		vaultId: typeof record.vaultId === "string" ? record.vaultId : null,
		fingerprint: typeof record.installId === "string" && record.installId.length > 0
			? await fingerprintForInstallId(record.installId) : null,
		schema: record.schema,
	};
}

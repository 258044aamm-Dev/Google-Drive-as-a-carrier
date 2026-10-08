import { DriveError, type DriveApi, type DriveFileInfo } from "./driveApi";

/**
 * Find the folder with this name, or create it. When two devices create it at
 * the same moment, everyone picks the same one (oldest, then lowest id).
 */
export async function ensureFolder(api: DriveApi, name: string): Promise<string> {
	let folders = await api.findFolders(name);
	if (folders.length === 0) {
		const created = await api.createFolder(name);
		folders = await api.findFolders(name);
		if (!folders.some((f) => f.id === created.id)) folders.push(created);
	}
	folders.sort((a, b) => a.createdTime - b.createdTime || (a.id < b.id ? -1 : 1));
	const chosen = folders[0];
	if (!chosen) throw new DriveError(500, `Could not create the Drive folder "${name}"`);
	return chosen.id;
}

/** Oldest first, so duplicate files with the same name resolve the same way on every device. */
export function oldestFirst(files: DriveFileInfo[]): DriveFileInfo[] {
	return [...files].sort((a, b) => a.createdTime - b.createdTime || (a.id < b.id ? -1 : 1));
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
	const copy = new Uint8Array(data.byteLength);
	copy.set(data);
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", copy));
	let out = "";
	for (const byte of digest) out += byte.toString(16).padStart(2, "0");
	return out;
}

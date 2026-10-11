import { DriveError, FOLDER_MIME, type DriveApi, type DriveFileInfo, type DriveFolderInfo } from "./driveApi";
import { META_NAME } from "./fileFormat";

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

function oldestFolderFirst(folders: DriveFolderInfo[]): DriveFolderInfo[] {
	return [...folders].sort((a, b) => a.createdTime - b.createdTime || (a.id < b.id ? -1 : 1));
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
	const copy = new Uint8Array(data.byteLength);
	copy.set(data);
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", copy));
	let out = "";
	for (const byte of digest) out += byte.toString(16).padStart(2, "0");
	return out;
}

// ---------------------------------------------------------------------------
// F5: folder identity
// ---------------------------------------------------------------------------

/** What another folder's `meta.json` says about it, for reporting duplicates. */
interface FolderIdentity {
	vaultId: string | null;
	installId: string | null;
}

async function readFolderIdentity(api: DriveApi, folderId: string): Promise<FolderIdentity> {
	try {
		const meta = oldestFirst((await api.listFiles(folderId)).filter((f) => f.name === META_NAME))[0];
		if (!meta) return { vaultId: null, installId: null };
		const parsed: unknown = JSON.parse(new TextDecoder().decode(await api.readFile(meta.id)));
		const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
		return {
			vaultId: typeof record.vaultId === "string" ? record.vaultId : null,
			installId: typeof record.installId === "string" ? record.installId : null,
		};
	} catch {
		// An unreadable or damaged meta file proves nothing; the caller says so.
		return { vaultId: null, installId: null };
	}
}

/** How many other folders are looked at when reporting a duplicate. Cost: two requests each. */
export const MAX_DUPLICATE_SAMPLES = 5;

async function describeOthers(
	api: DriveApi,
	chosenId: string,
	others: DriveFolderInfo[],
	name: string,
	vaultId: string,
): Promise<string | null> {
	if (others.length === 0) return null;
	const head = others.length === 1
		? `Another folder named "${name}" exists on Drive in addition to the one in use.`
		: `${String(others.length)} other folders named "${name}" exist on Drive in addition to the one in use.`;
	// The folder in use is read as well, so an install id can be compared with it.
	const chosen = await readFolderIdentity(api, chosenId);
	let sameInstall = 0;
	let otherInstall = 0;
	let otherVault: string | null = null;
	let unknown = 0;
	for (const other of others.slice(0, MAX_DUPLICATE_SAMPLES)) {
		const identity = await readFolderIdentity(api, other.id);
		if (!identity.vaultId || !identity.installId) unknown++;
		else if (identity.vaultId !== vaultId) otherVault ??= identity.vaultId;
		// The install id is what the folder's own setup wrote into meta.json. The
		// same one in both folders means a copy (or the same setup creating again);
		// a different one means two set-ups for one vault, which is how a device
		// with a different Google sign-in ends up with a folder of its own.
		else if (chosen.installId && identity.installId === chosen.installId) sameInstall++;
		else otherInstall++;
	}
	const details: string[] = [];
	if (sameInstall > 0) {
		details.push(`${String(sameInstall)} of them carry the same install id as the folder in use (a copy of the folder, or the folder created again).`);
	}
	if (otherInstall > 0) {
		details.push(
			`${String(otherInstall)} of them hold this vault but were created by a different set-up: that is what happens when a device signs in with a different Google client, because Drive lets an app see only the files it created.`,
		);
	}
	if (otherVault !== null) {
		details.push(`One of them holds a different vault (its meta.json says "${otherVault}"). Check whether this folder name was reused or changed by hand.`);
	}
	if (unknown > 0) {
		details.push(`${String(unknown)} of them have no readable meta.json (an empty folder left behind by an earlier start).`);
	}
	return `${head} This device uses the oldest one and never deletes the others.${details.length > 0 ? ` ${details.join(" ")}` : ""}`;
}

export interface VaultFolderResolution {
	id: string;
	/** True when this call created the folder it chose. */
	created: boolean;
	/** How many folders with this name exist (after the call). */
	folders: number;
	/** Something the user should be told, or null. Nothing is ever deleted. */
	warning: string | null;
}

export interface ResolveVaultFolderOptions {
	name: string;
	vaultId: string;
	/** The folder this device used before, when it has one saved (F5). */
	savedId?: string;
}

/**
 * F5: resolve the vault folder, preferring the folder id this device used last
 * time. Drive keeps a file id across a rename and a move, so a folder the user
 * renamed in the Drive web app is simply used again instead of a second empty
 * folder being created and the whole vault being uploaded into it.
 *
 * The choice among folders that share the name is unchanged (oldest, then
 * lowest id), including the case where two devices create the folder at the
 * same moment: after creating, the name is listed again and everyone picks the
 * same oldest folder. Duplicates are reported, never deleted; a saved id that
 * is gone, trashed or not a folder is reported and falls back to the name search.
 */
export async function resolveVaultFolder(api: DriveApi, opts: ResolveVaultFolderOptions): Promise<VaultFolderResolution> {
	const candidates = oldestFolderFirst(await api.findFolders(opts.name));
	const savedId = opts.savedId?.trim() ?? "";
	if (savedId) {
		const usable = await isUsableFolder(api, savedId);
		if (usable) {
			const others = candidates.filter((f) => f.id !== savedId);
			return {
				id: savedId,
				created: false,
				folders: others.length + 1,
				warning: await describeOthers(api, savedId, others, opts.name, opts.vaultId),
			};
		}
	}
	const rememberedGone = savedId !== "";
	const goneSentence = `The Drive folder this device remembered is gone (removed or trashed), so it was looked up by name again.`;
	const goneAndCreatedSentence = `The Drive folder this device remembered is gone (removed or trashed), and no folder named "${opts.name}" was found, so a new one was made. Nothing on Drive was deleted.`;
	if (candidates.length === 0) {
		const created = await api.createFolder(opts.name);
		// Two devices may have created the folder at the same moment: list once
		// more and pick the same oldest one, as the name search would have. The
		// loser's empty folder stays where it is (a trace line notes it).
		const after = oldestFolderFirst(await api.findFolders(opts.name));
		if (!after.some((f) => f.id === created.id)) after.push({ id: created.id, createdTime: created.createdTime });
		const chosen = after[0] ?? created;
		return {
			id: chosen.id,
			created: chosen.id === created.id,
			folders: after.length,
			warning: rememberedGone ? goneAndCreatedSentence : null,
		};
	}
	const chosen = candidates[0];
	if (!chosen) throw new DriveError(500, `Could not create the Drive folder "${opts.name}"`);
	const duplicate = await describeOthers(api, chosen.id, candidates.filter((f) => f.id !== chosen.id), opts.name, opts.vaultId);
	const parts = [rememberedGone ? goneSentence : null, duplicate].filter((part): part is string => part !== null);
	return {
		id: chosen.id,
		created: false,
		folders: candidates.length,
		warning: parts.length > 0 ? parts.join(" ") : null,
	};
}

/** True when this id is still a live folder in the user's Drive. A missing id (404) is not an error here. */
async function isUsableFolder(api: DriveApi, folderId: string): Promise<boolean> {
	let info: DriveFileInfo;
	try {
		info = await api.getFile(folderId);
	} catch (err) {
		if (err instanceof DriveError && err.notFound) return false;
		throw err;
	}
	if (info.trashed === true) return false;
	// A mime type we cannot see is left to the name search; a file (not a folder)
	// can never be the vault folder.
	return info.mimeType === undefined || info.mimeType === FOLDER_MIME;
}

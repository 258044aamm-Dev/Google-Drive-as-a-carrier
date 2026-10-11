/**
 * The small slice of Google Drive that the Drive carrier needs.
 *
 * The transport only ever talks to this interface, so it can be tested against
 * an in-memory fake and run against the real REST API (googleDriveRest.ts).
 */

export interface DriveFolderInfo {
	id: string;
	/** Creation time, ms since epoch. Used to pick one folder when two devices race. */
	createdTime: number;
}

export interface DriveFileInfo {
	id: string;
	name: string;
	/** Size in bytes as reported by Drive. */
	size: number;
	/** Creation time, ms since epoch. */
	createdTime: number;
	/** Set by `getFile`: the item is in the user's trash. */
	trashed?: boolean;
	/** Set by `getFile`: Drive's mime type. Folders use FOLDER_MIME. */
	mimeType?: string;
}

/** Drive's mime type for a folder. */
export const FOLDER_MIME = "application/vnd.google-apps.folder";

export interface DriveApi {
	/** Folders in the user's Drive with exactly this name (not trashed). */
	findFolders(name: string): Promise<DriveFolderInfo[]>;
	createFolder(name: string): Promise<DriveFolderInfo>;
	/** Every non-folder file directly inside the folder (all pages). */
	listFiles(folderId: string): Promise<DriveFileInfo[]>;
	createFile(folderId: string, name: string, data: Uint8Array): Promise<DriveFileInfo>;
	readFile(fileId: string): Promise<Uint8Array>;
	/**
	 * One file or folder by id, wherever it is in the user's Drive. File ids
	 * survive a rename or a move, so a remembered folder id can be checked
	 * directly instead of searching for its name again. A missing id raises
	 * DriveError(404); a trashed item comes back with `trashed: true`.
	 */
	getFile(fileId: string): Promise<DriveFileInfo>;
	/** Permanently delete a file or folder. A missing file raises DriveError(404). */
	deleteFile(fileId: string): Promise<void>;
}

/** A failed Drive request. `status` is 0 for network failures. */
export class DriveError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "DriveError";
	}

	/** Worth retrying later: rate limits, server errors, network failures. */
	get retryable(): boolean {
		return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500;
	}

	get notFound(): boolean {
		return this.status === 404;
	}
}

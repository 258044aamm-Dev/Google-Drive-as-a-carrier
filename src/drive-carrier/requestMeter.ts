import type { DriveApi, DriveFileInfo, DriveFolderInfo } from "./driveApi";

export interface RequestStats {
	/** Requests since the carrier started. */
	total: number;
	/** Requests in the last 60 seconds. */
	lastMinute: number;
	byOperation: Record<string, number>;
}

/**
 * Counts every request the carrier sends to Drive, so the request budget can
 * be checked (tests) and reported (diagnostics) instead of guessed.
 */
export class MeteredDriveApi implements DriveApi {
	private total = 0;
	private recent: number[] = [];
	private readonly ops: Record<string, number> = {};

	constructor(
		private readonly inner: DriveApi,
		private readonly now: () => number = () => Date.now(),
	) {}

	stats(): RequestStats {
		const cutoff = this.now() - 60_000;
		this.recent = this.recent.filter((t) => t > cutoff);
		return { total: this.total, lastMinute: this.recent.length, byOperation: { ...this.ops } };
	}

	private count(op: string): void {
		this.total++;
		this.ops[op] = (this.ops[op] ?? 0) + 1;
		this.recent.push(this.now());
	}

	findFolders(name: string): Promise<DriveFolderInfo[]> {
		this.count("findFolders");
		return this.inner.findFolders(name);
	}

	createFolder(name: string): Promise<DriveFolderInfo> {
		this.count("createFolder");
		return this.inner.createFolder(name);
	}

	listFiles(folderId: string): Promise<DriveFileInfo[]> {
		this.count("listFiles");
		return this.inner.listFiles(folderId);
	}

	createFile(folderId: string, name: string, data: Uint8Array): Promise<DriveFileInfo> {
		this.count("createFile");
		return this.inner.createFile(folderId, name, data);
	}

	readFile(fileId: string): Promise<Uint8Array> {
		this.count("readFile");
		return this.inner.readFile(fileId);
	}

	deleteFile(fileId: string): Promise<void> {
		this.count("deleteFile");
		return this.inner.deleteFile(fileId);
	}
}

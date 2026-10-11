import type { DriveApi, DriveFileInfo, DriveFolderInfo } from "./driveApi";

export interface RequestStats {
	/** Requests since the carrier started. */
	total: number;
	/** Requests in the last 60 seconds. */
	lastMinute: number;
	byOperation: Record<string, number>;
	/** F1: payload bytes stored on Drive (`createFile`) since the carrier started. */
	bytesWritten: number;
	/** F1: payload bytes downloaded (`readFile`) since the carrier started. */
	bytesRead: number;
	/** The same two figures per operation. Requests without a payload stay at zero. */
	bytesByOperation: Record<string, { written: number; read: number }>;
}

/**
 * Counts every request the carrier sends to Drive, so the request budget can
 * be checked (tests) and reported (diagnostics) instead of guessed.
 */
export class MeteredDriveApi implements DriveApi {
	private total = 0;
	private recent: number[] = [];
	private readonly ops: Record<string, number> = {};
	private written = 0;
	private read = 0;
	private readonly bytes: Record<string, { written: number; read: number }> = {};

	constructor(
		private readonly inner: DriveApi,
		private readonly now: () => number = () => Date.now(),
	) {}

	stats(): RequestStats {
		const cutoff = this.now() - 60_000;
		this.recent = this.recent.filter((t) => t > cutoff);
		const bytesByOperation: Record<string, { written: number; read: number }> = {};
		for (const [op, entry] of Object.entries(this.bytes)) bytesByOperation[op] = { ...entry };
		return {
			total: this.total,
			lastMinute: this.recent.length,
			byOperation: { ...this.ops },
			bytesWritten: this.written,
			bytesRead: this.read,
			bytesByOperation,
		};
	}

	private count(op: string): void {
		this.total++;
		this.ops[op] = (this.ops[op] ?? 0) + 1;
		this.recent.push(this.now());
	}

	/**
	 * Count payload bytes. Only the file body counts: names, listings and error
	 * bodies are not part of the figure, and a request that failed counts no
	 * bytes, so `bytesWritten` says what was actually stored.
	 */
	private countBytes(op: string, bytes: { written?: number; read?: number }): void {
		const entry = (this.bytes[op] ??= { written: 0, read: 0 });
		if (bytes.written) {
			entry.written += bytes.written;
			this.written += bytes.written;
		}
		if (bytes.read) {
			entry.read += bytes.read;
			this.read += bytes.read;
		}
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

	async createFile(folderId: string, name: string, data: Uint8Array): Promise<DriveFileInfo> {
		this.count("createFile");
		const info = await this.inner.createFile(folderId, name, data);
		this.countBytes("createFile", { written: data.length });
		return info;
	}

	async readFile(fileId: string): Promise<Uint8Array> {
		this.count("readFile");
		const bytes = await this.inner.readFile(fileId);
		this.countBytes("readFile", { read: bytes.length });
		return bytes;
	}

	getFile(fileId: string): Promise<DriveFileInfo> {
		this.count("getFile");
		return this.inner.getFile(fileId);
	}

	deleteFile(fileId: string): Promise<void> {
		this.count("deleteFile");
		return this.inner.deleteFile(fileId);
	}
}

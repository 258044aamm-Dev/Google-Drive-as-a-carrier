/**
 * In-memory stand-in for Google Drive, implementing the DriveApi the Drive
 * carrier uses. Several FakeDriveClient views can share one FakeDrive, which
 * is how multi-device tests are written.
 *
 * Failure injection:
 *   - `failNext(op, status, count)`: the next `count` calls of `op` raise DriveError(status)
 *   - `offline = true`: every call raises a network error (status 0)
 *   - `corrupt(name, mutate)`: change the stored bytes of a file in place
 *   - `latencyHook`: awaited before every call (lets a test interleave devices)
 *   - `createdInFlight`: files whose upload "succeeded" on the server but whose
 *     response is lost on the client (`loseResponseNext`)
 */

import {
	DriveError,
	type DriveApi,
	type DriveFileInfo,
	type DriveFolderInfo,
} from "../../src/drive-carrier/driveApi";

export type FakeOp = "findFolders" | "createFolder" | "listFiles" | "createFile" | "readFile" | "deleteFile";

interface StoredFile {
	id: string;
	name: string;
	parent: string;
	data: Uint8Array;
	createdTime: number;
}

interface StoredFolder {
	id: string;
	name: string;
	createdTime: number;
}

export class FakeDrive {
	readonly folders = new Map<string, StoredFolder>();
	readonly files = new Map<string, StoredFile>();
	offline = false;
	clock = 1_000_000;
	/** Calls per operation, for assertions about request budgets. */
	readonly calls: Record<FakeOp, number> = {
		findFolders: 0,
		createFolder: 0,
		listFiles: 0,
		createFile: 0,
		readFile: 0,
		deleteFile: 0,
	};
	latencyHook: ((op: FakeOp) => Promise<void>) | null = null;
	/** Files for which this returns true are missing from listings (a lagging file listing); reads still work. */
	hideFromListing: ((name: string) => boolean) | null = null;
	private nextId = 1;
	private readonly failures: { op: FakeOp; status: number; count: number }[] = [];
	private readonly loseResponse: { count: number }[] = [];

	failNext(op: FakeOp, status: number, count = 1): void {
		this.failures.push({ op, status, count });
	}

	loseResponseNext(count = 1): void {
		this.loseResponse.push({ count });
	}

	/** Make a client's view of this drive. */
	client(options: { reverseFolders?: boolean } = {}): FakeDriveClient {
		return new FakeDriveClient(this, options.reverseFolders === true);
	}

	filesIn(folderName: string): StoredFile[] {
		const folder = Array.from(this.folders.values()).find((f) => f.name === folderName);
		if (!folder) return [];
		return Array.from(this.files.values()).filter((f) => f.parent === folder.id);
	}

	namesIn(folderName: string): string[] {
		return this.filesIn(folderName).map((f) => f.name).sort();
	}

	corrupt(name: string, mutate: (data: Uint8Array) => Uint8Array): void {
		for (const f of this.files.values()) {
			if (f.name === name) f.data = mutate(f.data.slice());
		}
	}

	remove(name: string): void {
		for (const [id, f] of this.files) {
			if (f.name === name) this.files.delete(id);
		}
	}

	tick(): number {
		this.clock += 1;
		return this.clock;
	}

	newId(prefix: string): string {
		return `${prefix}${this.nextId++}`;
	}

	async enter(op: FakeOp): Promise<void> {
		this.calls[op]++;
		if (this.latencyHook) await this.latencyHook(op);
		if (this.offline) throw new DriveError(0, "offline");
		const index = this.failures.findIndex((f) => f.op === op && f.count > 0);
		const failure = this.failures[index];
		if (failure) {
			failure.count--;
			throw new DriveError(failure.status, `injected ${failure.status} on ${op}`);
		}
	}

	consumeLostResponse(): boolean {
		const entry = this.loseResponse.find((l) => l.count > 0);
		if (!entry) return false;
		entry.count--;
		return true;
	}
}

export class FakeDriveClient implements DriveApi {
	constructor(
		private readonly drive: FakeDrive,
		/** List folders newest-first, so a client that trusts listing order picks a different one. */
		private readonly reverseFolders = false,
	) {}

	async findFolders(name: string): Promise<DriveFolderInfo[]> {
		await this.drive.enter("findFolders");
		const found = Array.from(this.drive.folders.values())
			.filter((f) => f.name === name)
			.map((f) => ({ id: f.id, createdTime: f.createdTime }));
		return this.reverseFolders ? found.reverse() : found;
	}

	async createFolder(name: string): Promise<DriveFolderInfo> {
		await this.drive.enter("createFolder");
		const folder: StoredFolder = { id: this.drive.newId("folder-"), name, createdTime: this.drive.tick() };
		this.drive.folders.set(folder.id, folder);
		return { id: folder.id, createdTime: folder.createdTime };
	}

	async listFiles(folderId: string): Promise<DriveFileInfo[]> {
		await this.drive.enter("listFiles");
		return Array.from(this.drive.files.values())
			.filter((f) => f.parent === folderId && !(this.drive.hideFromListing?.(f.name) ?? false))
			.map((f) => ({ id: f.id, name: f.name, size: f.data.length, createdTime: f.createdTime }));
	}

	async createFile(folderId: string, name: string, data: Uint8Array): Promise<DriveFileInfo> {
		await this.drive.enter("createFile");
		if (!this.drive.folders.has(folderId)) throw new DriveError(404, "folder not found");
		const stored: StoredFile = {
			id: this.drive.newId("file-"),
			name,
			parent: folderId,
			data: data.slice(),
			createdTime: this.drive.tick(),
		};
		this.drive.files.set(stored.id, stored);
		if (this.drive.consumeLostResponse()) throw new DriveError(0, "response lost");
		return { id: stored.id, name, size: stored.data.length, createdTime: stored.createdTime };
	}

	async readFile(fileId: string): Promise<Uint8Array> {
		await this.drive.enter("readFile");
		const file = this.drive.files.get(fileId);
		if (!file) throw new DriveError(404, "file not found");
		return file.data.slice();
	}

	async deleteFile(fileId: string): Promise<void> {
		await this.drive.enter("deleteFile");
		if (this.drive.files.delete(fileId)) return;
		if (this.drive.folders.delete(fileId)) return;
		throw new DriveError(404, "file not found");
	}
}

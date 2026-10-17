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
	FOLDER_MIME,
	type DriveApi,
	type DriveFileInfo,
	type DriveFolderInfo,
} from "../../src/drive-carrier/driveApi";

export type FakeOp = "findFolders" | "createFolder" | "listFiles" | "createFile" | "readFile" | "getFile" | "deleteFile";

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
	/** F5: a trashed folder is invisible to findFolders, like Drive's `trashed = false` query. */
	trashed?: boolean;
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
		getFile: 0,
		deleteFile: 0,
	};
	latencyHook: ((op: FakeOp) => Promise<void>) | null = null;
	/** Files for which this returns true are missing from listings (a lagging file listing); reads still work. */
	hideFromListing: ((name: string) => boolean) | null = null;
	/**
	 * F8: how long a write takes to appear in (or disappear from) a listing, in
	 * this fake's clock. Zero by default, so every existing suite keeps the old
	 * "listings are immediate" behaviour; tests that care set it and advance
	 * `clock`. The real gate measures the same latency on a real account
	 * (tests/live/drive-real.ts); the number it prints belongs here.
	 */
	listingLagTicks = 0;
	/** Files that are stored but not listed yet (created inside the lag window). */
	private readonly listingNotYet = new Map<string, number>();
	/** Files that are deleted but still listed (deleted inside the lag window). */
	private readonly listingGhosts = new Map<string, { file: StoredFile; until: number; parent: string }>();
	private nextId = 1;
	private readonly failures: { op: FakeOp; status: number; count: number }[] = [];
	private readonly loseResponse: { count: number }[] = [];
	/** Bytes a reader sees instead of the stored ones, once, for files whose name matches. */
	private readonly readCorruptions: { pattern: RegExp; mutate: (data: Uint8Array) => Uint8Array }[] = [];

	failNext(op: FakeOp, status: number, count = 1): void {
		this.failures.push({ op, status, count });
	}

	loseResponseNext(count = 1): void {
		this.loseResponse.push({ count });
	}

	/**
	 * The next read of a file whose name matches `pattern` hands the reader
	 * damaged bytes. The stored file is left alone, so the damage is gone by the
	 * next read — a damaged download, not a damaged file.
	 */
	corruptOnNextRead(pattern: RegExp, mutate: (data: Uint8Array) => Uint8Array): void {
		this.readCorruptions.push({ pattern, mutate });
	}

	/** One-shot: the mutation a read of `name` should apply, if any. */
	consumeReadCorruption(name: string): ((data: Uint8Array) => Uint8Array) | null {
		const index = this.readCorruptions.findIndex((r) => r.pattern.test(name));
		if (index < 0) return null;
		const [rule] = this.readCorruptions.splice(index, 1);
		return rule?.mutate ?? null;
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

	/** Rename a folder the way the user could in the Drive web app (file ids do not change). */
	renameFolder(name: string, newName: string): number {
		let renamed = 0;
		for (const folder of this.folders.values()) {
			if (folder.name === name && !folder.trashed) {
				folder.name = newName;
				renamed++;
			}
		}
		return renamed;
	}

	/** Move a folder to the trash. Its id keeps resolving, but with `trashed: true`. */
	trashFolder(name: string): number {
		let trashed = 0;
		for (const folder of this.folders.values()) {
			if (folder.name === name && !folder.trashed) {
				folder.trashed = true;
				trashed++;
			}
		}
		return trashed;
	}

	/** The folder with this id, or undefined. */
	folderById(id: string): StoredFolder | undefined {
		return this.folders.get(id);
	}

	tick(): number {
		this.clock += 1;
		return this.clock;
	}

	/** F8: is this file id visible in listings right now? */
	isListed(fileId: string): boolean {
		const from = this.listingNotYet.get(fileId);
		return from === undefined || this.clock >= from;
	}

	/** F8: hold a file back from listings until the clock reaches `from`. */
	holdListing(fileId: string, from: number): void {
		this.listingNotYet.set(fileId, from);
	}

	/** F8: keep a deleted file in listings until the clock reaches `until`. */
	holdGhost(file: StoredFile, until: number): void {
		this.listingGhosts.set(file.id, { file, until, parent: file.parent });
	}

	/** F8: the ghost listings still shown, as DriveFileInfo. */
	ghostsIn(folderId: string): DriveFileInfo[] {
		this.expireListings();
		return Array.from(this.listingGhosts.values())
			.filter((g) => g.parent === folderId && this.clock < g.until)
			.map((g) => ({ id: g.file.id, name: g.file.name, size: g.file.data.length, createdTime: g.file.createdTime }));
	}

	/** F8: forget published and ghost listings whose window has passed. */
	expireListings(): void {
		for (const [id, from] of this.listingNotYet) if (this.clock >= from) this.listingNotYet.delete(id);
		for (const [id, ghost] of this.listingGhosts) if (this.clock >= ghost.until) this.listingGhosts.delete(id);
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
			.filter((f) => f.name === name && !f.trashed)
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
		this.drive.expireListings();
		const here = Array.from(this.drive.files.values())
			.filter((f) => f.parent === folderId && !(this.drive.hideFromListing?.(f.name) ?? false))
			.filter((f) => this.drive.isListed(f.id))
			.map((f) => ({ id: f.id, name: f.name, size: f.data.length, createdTime: f.createdTime }));
		for (const ghost of this.drive.ghostsIn(folderId)) here.push(ghost);
		return here;
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
		if (this.drive.listingLagTicks > 0) this.drive.holdListing(stored.id, this.drive.clock + this.drive.listingLagTicks);
		if (this.drive.consumeLostResponse()) throw new DriveError(0, "response lost");
		return { id: stored.id, name, size: stored.data.length, createdTime: stored.createdTime };
	}

	async readFile(fileId: string): Promise<Uint8Array> {
		await this.drive.enter("readFile");
		const file = this.drive.files.get(fileId);
		if (!file) throw new DriveError(404, "file not found");
		const damage = this.drive.consumeReadCorruption(file.name);
		const bytes = file.data.slice();
		return damage ? damage(bytes) : bytes;
	}

	async getFile(fileId: string): Promise<DriveFileInfo> {
		await this.drive.enter("getFile");
		const folder = this.drive.folders.get(fileId);
		if (folder) {
			const info: DriveFileInfo = { id: folder.id, name: folder.name, size: 0, createdTime: folder.createdTime, mimeType: FOLDER_MIME };
			if (folder.trashed) info.trashed = true;
			return info;
		}
		const file = this.drive.files.get(fileId);
		if (!file) throw new DriveError(404, "file not found");
		return { id: file.id, name: file.name, size: file.data.length, createdTime: file.createdTime, mimeType: "application/octet-stream" };
	}

	async deleteFile(fileId: string): Promise<void> {
		await this.drive.enter("deleteFile");
		const file = this.drive.files.get(fileId);
		if (file) {
			if (this.drive.listingLagTicks > 0) this.drive.holdGhost(file, this.drive.clock + this.drive.listingLagTicks);
			this.drive.files.delete(fileId);
			return;
		}
		if (this.drive.folders.delete(fileId)) return;
		throw new DriveError(404, "file not found");
	}
}

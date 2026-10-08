import type { BlobStoreClient } from "../sync/blobSync";
import { DriveError, type DriveApi } from "./driveApi";
import { EncryptionError, type DriveSealer } from "./driveCrypto";
import { ensureFolder, oldestFirst, sha256Hex } from "./driveFolders";
import type { DriveKeyring } from "./driveKeyring";

const HEX_64 = /^[0-9a-f]{64}$/;
/** How long a listing of the blob folder is trusted before a "not found" is re-checked. */
const LISTING_MAX_AGE_MS = 30_000;

export interface DriveBlobStoreOptions {
	vaultId: string;
	now?: () => number;
	/**
	 * Decides whether the vault is encrypted. With it, attachments are sealed and
	 * their file names are keyed hashes. Without it, attachments are stored as they are.
	 */
	keyring?: DriveKeyring;
}

/** The name of the Drive folder holding this vault's attachments. */
export function blobFolderName(vaultId: string): string {
	return `YAOS ${vaultId} blobs`;
}

async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: number | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = window.setTimeout(() => reject(new DriveError(408, `Timeout (${ms} ms) during ${what}`)), ms);
	});
	try {
		return await Promise.race([work, timeout]);
	} finally {
		if (timer !== undefined) window.clearTimeout(timer);
	}
}

/**
 * Attachments on Drive: one file per attachment, named by its SHA-256, in a
 * folder next to the vault folder (so the sync folder that is polled every few
 * seconds stays small). Content addressing means the same attachment is only
 * stored once, and what comes back is checked against its name.
 */
export class DriveBlobStore implements BlobStoreClient {
	private folderId: string | null = null;
	private folderPending: Promise<string> | null = null;
	/** file name -> file id, from the last listing and from our own uploads. */
	private known = new Map<string, string>();
	private listedAt = -Infinity;
	private readonly now: () => number;

	constructor(
		private readonly api: DriveApi,
		private readonly options: DriveBlobStoreOptions,
	) {
		this.now = options.now ?? (() => Date.now());
	}

	private folder(): Promise<string> {
		if (this.folderId !== null) return Promise.resolve(this.folderId);
		this.folderPending ??= ensureFolder(this.api, blobFolderName(this.options.vaultId)).then(
			(id) => {
				this.folderId = id;
				return id;
			},
			(err: unknown) => {
				this.folderPending = null;
				throw err;
			},
		);
		return this.folderPending;
	}

	private async sealer(): Promise<DriveSealer | null> {
		return this.options.keyring ? await this.options.keyring.ready() : null;
	}

	/** The file name an attachment is stored under: its hash, or a keyed hash of it when encrypted. */
	private async nameFor(hash: string, sealer: DriveSealer | null): Promise<string> {
		return sealer ? await sealer.blobName(hash) : hash;
	}

	private async refreshListing(): Promise<void> {
		const folderId = await this.folder();
		const files = oldestFirst(await this.api.listFiles(folderId));
		const fresh = new Map<string, string>();
		for (const file of files) {
			if (HEX_64.test(file.name) && !fresh.has(file.name)) fresh.set(file.name, file.id);
		}
		this.known = fresh;
		this.listedAt = this.now();
	}

	async exists(hashes: string[]): Promise<string[]> {
		const wanted = hashes.filter((h) => HEX_64.test(h));
		if (wanted.length === 0) return [];
		const sealer = await this.sealer();
		const names = await Promise.all(wanted.map((h) => this.nameFor(h, sealer)));
		const missing = names.some((n) => !this.known.has(n));
		if (missing && this.now() - this.listedAt >= LISTING_MAX_AGE_MS) await this.refreshListing();
		return wanted.filter((_, i) => this.known.has(names[i] ?? ""));
	}

	async upload(hash: string, _contentType: string, data: ArrayBuffer, timeoutMs: number): Promise<void> {
		if (!HEX_64.test(hash)) throw new Error(`blob upload failed: invalid hash ${hash.slice(0, 12)}`);
		const bytes = new Uint8Array(data);
		await withTimeout(this.uploadInner(hash, bytes), timeoutMs, `blob upload ${hash.slice(0, 12)}…`);
	}

	private async uploadInner(hash: string, bytes: Uint8Array): Promise<void> {
		if ((await sha256Hex(bytes)) !== hash) {
			throw new Error(`blob upload failed: content does not match hash ${hash.slice(0, 12)}`);
		}
		const sealer = await this.sealer();
		const name = await this.nameFor(hash, sealer);
		const stored = sealer ? await sealer.seal(bytes, "blob") : bytes;
		const folderId = await this.folder();
		const info = await this.api.createFile(folderId, name, stored);
		if (info.size !== stored.length) {
			await this.api.deleteFile(info.id).catch(() => undefined);
			throw new DriveError(502, `Attachment ${hash.slice(0, 12)} was stored with a different size (${info.size} != ${stored.length})`);
		}
		this.known.set(name, info.id);
	}

	async download(hash: string, timeoutMs: number): Promise<ArrayBuffer> {
		if (!HEX_64.test(hash)) throw new Error(`blob download failed: invalid hash ${hash.slice(0, 12)}`);
		return await withTimeout(this.downloadInner(hash), timeoutMs, `blob download ${hash.slice(0, 12)}…`);
	}

	private async downloadInner(hash: string): Promise<ArrayBuffer> {
		const sealer = await this.sealer();
		const name = await this.nameFor(hash, sealer);
		let id = this.known.get(name);
		if (id === undefined) {
			await this.refreshListing();
			id = this.known.get(name);
		}
		if (id === undefined) throw new DriveError(404, `blob download failed: 404 attachment ${hash.slice(0, 12)} is not on Drive`);
		let bytes: Uint8Array;
		try {
			bytes = await this.api.readFile(id);
		} catch (err) {
			if (err instanceof DriveError && err.notFound) this.known.delete(name);
			throw err;
		}
		if (sealer) {
			try {
				bytes = await sealer.open(bytes, "blob");
			} catch (err) {
				if (err instanceof EncryptionError) {
					throw new DriveError(502, `blob download failed: attachment ${hash.slice(0, 12)} on Drive is damaged`);
				}
				throw err;
			}
		}
		if ((await sha256Hex(bytes)) !== hash) {
			throw new DriveError(502, `blob download failed: attachment ${hash.slice(0, 12)} on Drive is damaged`);
		}
		const copy = new Uint8Array(bytes.byteLength);
		copy.set(bytes);
		return copy.buffer;
	}
}

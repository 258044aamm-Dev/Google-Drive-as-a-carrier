import * as Y from "yjs";
import { gunzipSync, gzipSync } from "fflate";
import type { SnapshotBackend } from "../snapshots/snapshotBackend";
import type { SnapshotIndex, SnapshotResult } from "../sync/snapshotClient";
import type { DriveApi, DriveFileInfo } from "./driveApi";
import { EncryptionError, type DriveSealer } from "./driveCrypto";
import { ensureFolder, oldestFirst, sha256Hex } from "./driveFolders";
import type { DriveKeyring } from "./driveKeyring";
import { KIND_SNAPSHOT, decodeFile, encodeFile } from "./fileFormat";
import { isFileMetaDeletedValue } from "../sync/fileMeta";

const INDEX_PREFIX = "snapidx-";
const INDEX_SUFFIX = ".json";
const DATA_PREFIX = "snapdat-";
const DATA_SUFFIX = ".bin";
/** Unpinned snapshots kept by "cleanup". Manual snapshots are pinned and never removed. */
export const KEEP_UNPINNED_SNAPSHOTS = 14;
const LIST_LIMIT = 50;
/** A data file with no index is a snapshot still being written until it is this old. */
const ORPHAN_GRACE_MS = 10 * 60_000;

export interface DriveSnapshotBackendOptions {
	vaultId: string;
	/** The live document to snapshot. */
	getDoc: () => Y.Doc | null;
	now?: () => number;
	random?: () => string;
	/** Decides whether snapshots are sealed. Without it they are stored as they are. */
	keyring?: DriveKeyring;
}

export function snapshotFolderName(vaultId: string): string {
	return `YAOS ${vaultId} snapshots`;
}

function indexName(id: string): string {
	return `${INDEX_PREFIX}${id}${INDEX_SUFFIX}`;
}

function dataName(id: string): string {
	return `${DATA_PREFIX}${id}${DATA_SUFFIX}`;
}

function idFromIndexName(name: string): string | null {
	if (!name.startsWith(INDEX_PREFIX) || !name.endsWith(INDEX_SUFFIX)) return null;
	const id = name.slice(INDEX_PREFIX.length, name.length - INDEX_SUFFIX.length);
	return id.length > 0 ? id : null;
}

function idFromDataName(name: string): string | null {
	if (!name.startsWith(DATA_PREFIX) || !name.endsWith(DATA_SUFFIX)) return null;
	const id = name.slice(DATA_PREFIX.length, name.length - DATA_SUFFIX.length);
	return id.length > 0 ? id : null;
}

function parseIndex(raw: string): SnapshotIndex | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const r = parsed as Record<string, unknown>;
	if (typeof r.snapshotId !== "string" || typeof r.createdAt !== "string" || typeof r.day !== "string") return null;
	if (typeof r.crdtSizeBytes !== "number" || typeof r.markdownFileCount !== "number" || typeof r.blobFileCount !== "number") return null;
	return parsed as SnapshotIndex;
}

/**
 * Notes in the document. From schema v2 `meta` is authoritative and `pathToId`
 * is frozen or empty, so counting it reported "0 notes" (upstream issue #78 saw
 * the same in the server's snapshot index). Documents without a schema version
 * keep the legacy count.
 */
function countActiveNotes(doc: Y.Doc): number {
	const schema = doc.getMap<unknown>("sys").get("schemaVersion");
	if (!(typeof schema === "number" && Number.isFinite(schema) && schema >= 2)) {
		return doc.getMap<string>("pathToId").size;
	}
	let active = 0;
	doc.getMap<unknown>("meta").forEach((value) => {
		if (!isFileMetaDeletedValue(value)) active++;
	});
	return active;
}

function defaultRandom(): string {
	const bytes = new Uint8Array(4);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Restore points on Drive, in a folder next to the vault folder. Each snapshot
 * is a data file (the document, gzip, with a checksum) plus a small index file
 * that is written last, so a snapshot only shows up once it is complete.
 */
export class DriveSnapshotBackend implements SnapshotBackend {
	private folderId: string | null = null;
	private readonly clock: () => number;
	private readonly random: () => string;

	constructor(
		private readonly api: DriveApi,
		private readonly options: DriveSnapshotBackendOptions,
	) {
		this.clock = options.now ?? (() => Date.now());
		this.random = options.random ?? defaultRandom;
	}

	private async folder(): Promise<string> {
		this.folderId ??= await ensureFolder(this.api, snapshotFolderName(this.options.vaultId));
		return this.folderId;
	}

	private async sealer(): Promise<DriveSealer | null> {
		return this.options.keyring ? await this.options.keyring.ready() : null;
	}

	private async readIndexes(files: DriveFileInfo[]): Promise<{ file: DriveFileInfo; index: SnapshotIndex }[]> {
		const sealer = await this.sealer();
		const wanted = files
			.filter((f) => idFromIndexName(f.name) !== null)
			.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
		const out: { file: DriveFileInfo; index: SnapshotIndex }[] = [];
		const decoder = new TextDecoder();
		for (let i = 0; i < wanted.length; i += 4) {
			const batch = wanted.slice(i, i + 4);
			const results = await Promise.all(batch.map(async (file) => {
				try {
					const stored = await this.api.readFile(file.id);
					const index = parseIndex(decoder.decode(sealer ? await sealer.open(stored, "snapshot-index") : stored));
					return index && idFromIndexName(file.name) === index.snapshotId ? { file, index } : null;
				} catch {
					return null;
				}
			}));
			for (const r of results) if (r) out.push(r);
		}
		return out;
	}

	private today(): string {
		return new Date(this.clock()).toISOString().slice(0, 10);
	}

	async daily(device?: string): Promise<SnapshotResult> {
		const folderId = await this.folder();
		const existing = await this.readIndexes(await this.api.listFiles(folderId));
		const today = this.today();
		if (existing.some((e) => e.index.day === today)) return { status: "noop", reason: "already taken today" };
		return await this.create("daily", device, existing.map((e) => e.index));
	}

	/** Take a snapshot right now (pinned, so cleanup never removes it). */
	async now(device?: string): Promise<SnapshotResult> {
		const folderId = await this.folder();
		const existing = await this.readIndexes(await this.api.listFiles(folderId));
		return await this.create("manual", device, existing.map((e) => e.index));
	}

	private async create(reason: "daily" | "manual", device: string | undefined, existing: SnapshotIndex[]): Promise<SnapshotResult> {
		const doc = this.options.getDoc();
		if (!doc) return { status: "unavailable", reason: "sync is not running" };
		const folderId = await this.folder();

		const raw = Y.encodeStateAsUpdate(doc);
		const compressed = gzipSync(raw);
		const fullUpdateHash = await sha256Hex(raw);

		const pathToBlob = doc.getMap<unknown>("pathToBlob");
		const sys = doc.getMap<unknown>("sys");
		const referencedBlobHashes: string[] = [];
		pathToBlob.forEach((ref) => {
			if (typeof ref === "object" && ref !== null && "hash" in ref && typeof ref.hash === "string") {
				referencedBlobHashes.push(ref.hash);
			}
		});

		const now = this.clock();
		const id = `${String(now).padStart(13, "0")}-${this.random()}`;
		const index: SnapshotIndex = {
			snapshotId: id,
			vaultId: this.options.vaultId,
			createdAt: new Date(now).toISOString(),
			day: this.today(),
			schemaVersion: typeof sys.get("schemaVersion") === "number" ? sys.get("schemaVersion") as number : undefined,
			markdownFileCount: countActiveNotes(doc),
			blobFileCount: pathToBlob.size,
			crdtSizeBytes: compressed.byteLength,
			crdtRawSizeBytes: raw.byteLength,
			referencedBlobHashes,
			triggeredBy: device,
			fullUpdateHash,
			pinned: reason === "manual",
			reason,
		};

		const latest = [...existing].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
		const identical = latest?.fullUpdateHash === fullUpdateHash;

		// Content first, index last: a snapshot is only listed once it is complete.
		const sealer = await this.sealer();
		const data = await encodeFile(KIND_SNAPSHOT, sealer ? await sealer.seal(compressed, "snapshot-data") : compressed, sealer !== null);
		const stored = await this.api.createFile(folderId, dataName(id), data);
		if (stored.size !== data.length) {
			await this.api.deleteFile(stored.id).catch(() => undefined);
			throw new Error(`Snapshot upload was stored with a different size (${stored.size} != ${data.length})`);
		}
		const indexBytes = new TextEncoder().encode(JSON.stringify(index));
		await this.api.createFile(folderId, indexName(id), sealer ? await sealer.seal(indexBytes, "snapshot-index") : indexBytes);
		return { status: "created", snapshotId: id, snapshotKey: dataName(id), index, snapshotIdenticalToLatest: identical };
	}

	async list(): Promise<SnapshotIndex[]> {
		const folderId = await this.folder();
		const all = await this.readIndexes(await this.api.listFiles(folderId));
		return all
			.map((e) => e.index)
			.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
			.slice(0, LIST_LIMIT);
	}

	async prune(): Promise<{ kept: number; pruned: number; failed: number }> {
		const folderId = await this.folder();
		const files = await this.api.listFiles(folderId);
		const entries = (await this.readIndexes(files))
			.sort((a, b) => (a.index.createdAt < b.index.createdAt ? 1 : -1));
		let kept = 0;
		let pruned = 0;
		let failed = 0;
		let unpinnedSeen = 0;
		const dataByName = new Map(files.map((f) => [f.name, f] as const));
		for (const { file, index } of entries) {
			if (index.pinned === true || unpinnedSeen < KEEP_UNPINNED_SNAPSHOTS) {
				if (index.pinned !== true) unpinnedSeen++;
				kept++;
				continue;
			}
			try {
				// Index first: a snapshot without its index disappears from the list at once.
				await this.api.deleteFile(file.id);
				const data = dataByName.get(dataName(index.snapshotId));
				if (data) await this.api.deleteFile(data.id).catch(() => undefined);
				pruned++;
			} catch {
				failed++;
			}
		}
		// Leftovers of snapshots that never got an index (an interrupted upload).
		const indexed = new Set(entries.map((e) => e.index.snapshotId));
		const cutoff = this.clock() - ORPHAN_GRACE_MS;
		for (const file of oldestFirst(files)) {
			const id = idFromDataName(file.name);
			if (id === null || indexed.has(id) || file.createdTime === 0 || file.createdTime > cutoff) continue;
			// Do not touch data whose index exists but could not be read this time.
			if (files.some((f) => f.name === indexName(id))) continue;
			await this.api.deleteFile(file.id).catch(() => undefined);
		}
		return { kept, pruned, failed };
	}

	async download(snapshot: SnapshotIndex): Promise<Y.Doc> {
		const folderId = await this.folder();
		const files = await this.api.listFiles(folderId);
		const file = oldestFirst(files.filter((f) => f.name === dataName(snapshot.snapshotId)))[0];
		if (!file) throw new Error("Snapshot download failed (404)");
		const decoded = await decodeFile(await this.api.readFile(file.id));
		if (decoded.kind !== KIND_SNAPSHOT) throw new Error("Snapshot download failed (not a snapshot file)");
		const sealer = await this.sealer();
		if (decoded.encrypted !== (sealer !== null)) {
			throw new Error(decoded.encrypted ? "Snapshot download failed (encrypted snapshot in an unencrypted vault)" : "Snapshot download failed (unencrypted snapshot in an encrypted vault)");
		}
		let payload = decoded.payload;
		if (sealer) {
			try {
				payload = await sealer.open(payload, "snapshot-data");
			} catch (err) {
				if (err instanceof EncryptionError) throw new Error(`Snapshot download failed (${err.message})`);
				throw err;
			}
		}
		const doc = new Y.Doc();
		Y.applyUpdate(doc, gunzipSync(payload));
		return doc;
	}
}

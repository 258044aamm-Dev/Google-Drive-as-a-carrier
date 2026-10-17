import * as Y from "yjs";
import { gzipSync } from "fflate";
import { verifiedSnapshotDoc } from "../snapshots/snapshotIntegrity";
import type { SnapshotBackend } from "../snapshots/snapshotBackend";
import type { SnapshotIndex, SnapshotResult } from "../sync/snapshotClient";
import { isFileMetaDeletedValue } from "../sync/fileMeta";
import { sha256Hex, type LanFileStore } from "./lanFileStore";

const INDEX_PREFIX = "snapidx-";
const INDEX_SUFFIX = ".json";
const DATA_PREFIX = "snapdat-";
const DATA_SUFFIX = ".bin";
/** Unpinned snapshots kept by cleanup. Manual snapshots are pinned and never removed. */
export const LAN_KEEP_UNPINNED_SNAPSHOTS = 14;
const LIST_LIMIT = 50;

export interface LanSnapshotBackendOptions {
	vaultId: string;
	getDoc: () => Y.Doc | null;
	now?: () => number;
	random?: () => string;
}

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

function defaultRandom(): string {
	const bytes = new Uint8Array(4);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Restore points kept on THIS device (there is no server to keep them). Each
 * snapshot is a data file (the whole document, gzip) plus a small index file
 * that is written last, so a snapshot only appears once it is complete.
 */
export class LanSnapshotBackend implements SnapshotBackend {
	private readonly clock: () => number;
	private readonly random: () => string;

	constructor(
		private readonly files: LanFileStore,
		private readonly options: LanSnapshotBackendOptions,
	) {
		this.clock = options.now ?? (() => Date.now());
		this.random = options.random ?? defaultRandom;
	}

	private today(): string {
		return new Date(this.clock()).toISOString().slice(0, 10);
	}

	private async indexes(): Promise<SnapshotIndex[]> {
		const out: SnapshotIndex[] = [];
		const decoder = new TextDecoder();
		for (const name of await this.files.list()) {
			if (!name.startsWith(INDEX_PREFIX) || !name.endsWith(INDEX_SUFFIX)) continue;
			const bytes = await this.files.read(name);
			if (!bytes) continue;
			const index = parseIndex(decoder.decode(bytes));
			const id = name.slice(INDEX_PREFIX.length, name.length - INDEX_SUFFIX.length);
			if (index && index.snapshotId === id && index.vaultId === this.options.vaultId) out.push(index);
		}
		return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
	}

	async daily(device?: string): Promise<SnapshotResult> {
		const existing = await this.indexes();
		if (existing.some((e) => e.day === this.today())) return { status: "noop", reason: "already taken today" };
		return await this.create("daily", device, existing);
	}

	async now(device?: string): Promise<SnapshotResult> {
		return await this.create("manual", device, await this.indexes());
	}

	private async create(reason: "daily" | "manual", device: string | undefined, existing: SnapshotIndex[]): Promise<SnapshotResult> {
		const doc = this.options.getDoc();
		if (!doc) return { status: "unavailable", reason: "sync is not running" };
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
		// Namespace new IDs by vault without moving or deleting legacy files.
		// Old timestamp-only IDs remain readable when their index names this vault.
		const namespace = await sha256Hex(new TextEncoder().encode(this.options.vaultId));
		const id = `${String(now).padStart(13, "0")}-${this.random()}-${namespace}`;
		const schema = sys.get("schemaVersion");
		const index: SnapshotIndex = {
			snapshotId: id,
			vaultId: this.options.vaultId,
			createdAt: new Date(now).toISOString(),
			day: this.today(),
			schemaVersion: typeof schema === "number" ? schema : undefined,
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
		const identical = existing[0]?.fullUpdateHash === fullUpdateHash;
		// Content first, index last: a snapshot is only listed once it is complete.
		await this.files.write(`${DATA_PREFIX}${id}${DATA_SUFFIX}`, compressed);
		await this.files.write(`${INDEX_PREFIX}${id}${INDEX_SUFFIX}`, new TextEncoder().encode(JSON.stringify(index)));
		return { status: "created", snapshotId: id, snapshotKey: `${DATA_PREFIX}${id}${DATA_SUFFIX}`, index, snapshotIdenticalToLatest: identical };
	}

	async list(): Promise<SnapshotIndex[]> {
		return (await this.indexes()).slice(0, LIST_LIMIT);
	}

	async prune(): Promise<{ kept: number; pruned: number; failed: number }> {
		let kept = 0;
		let pruned = 0;
		let failed = 0;
		let unpinnedSeen = 0;
		for (const index of await this.indexes()) {
			if (index.pinned === true || unpinnedSeen < LAN_KEEP_UNPINNED_SNAPSHOTS) {
				if (index.pinned !== true) unpinnedSeen++;
				kept++;
				continue;
			}
			try {
				// Index first: a snapshot without its index disappears from the list at once.
				await this.files.remove(`${INDEX_PREFIX}${index.snapshotId}${INDEX_SUFFIX}`);
				await this.files.remove(`${DATA_PREFIX}${index.snapshotId}${DATA_SUFFIX}`).catch(() => undefined);
				pruned++;
			} catch {
				failed++;
			}
		}
		return { kept, pruned, failed };
	}

	async download(snapshot: SnapshotIndex): Promise<Y.Doc> {
		if (snapshot.vaultId !== this.options.vaultId) throw new Error("Snapshot belongs to a different vault");
		const data = await this.files.read(`${DATA_PREFIX}${snapshot.snapshotId}${DATA_SUFFIX}`);
		if (!data) throw new Error("Snapshot download failed (404)");
		const indexBytes = await this.files.read(`${INDEX_PREFIX}${snapshot.snapshotId}${INDEX_SUFFIX}`);
		const stored = indexBytes ? parseIndex(new TextDecoder().decode(indexBytes)) : null;
		if (!stored || stored.vaultId !== this.options.vaultId || stored.snapshotId !== snapshot.snapshotId) {
			throw new Error("Snapshot index is missing or belongs to a different vault");
		}
		return await verifiedSnapshotDoc(data, snapshot, this.options.vaultId);
	}
}

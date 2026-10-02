import * as Y from "yjs";
import { ObservableV2 } from "lib0/observable";
import { Awareness } from "y-protocols/awareness";
import type { SyncTransport } from "../sync/transport";
import { DriveError, type DriveApi, type DriveFileInfo } from "./driveApi";
import {
	CorruptFileError,
	KIND_SEGMENT,
	KIND_SNAPSHOT,
	META_NAME,
	classifyName,
	decodeFile,
	encodeFile,
	segmentName,
	snapshotName,
	type FileKind,
} from "./fileFormat";

/** Schema of the Drive layout. A device refuses a vault folder written with another one. */
export const DRIVE_LAYOUT_SCHEMA = 1;

export interface DriveTransportOptions {
	vaultId: string;
	/** Random per-install id; keeps file names from different devices apart. */
	deviceId: string;
	/** Drive folder name. Defaults to `YAOS <vaultId>`. */
	folderName?: string;
	/** Delay between polls while everything works. */
	pollIntervalMs?: number;
	/** Local edits are batched for this long before one segment is uploaded. */
	batchMs?: number;
	/** Compact when this many segment files exist... */
	compactSegmentCount?: number;
	/** ...or when they total this many bytes. */
	compactSegmentBytes?: number;
	/** Check that Drive holds everything we hold, this often (ms). 0 disables. */
	reconcileIntervalMs?: number;
	/** Largest wait after repeated failures. */
	maxBackoffMs?: number;
	/** false: no timers at all; the owner drives the transport with syncNow(). */
	autoTimers?: boolean;
	/** Origins whose Y.Doc updates are NOT local edits (e.g. the IndexedDB persistence). */
	ignoreOrigin?: (origin: unknown) => boolean;
	now?: () => number;
	log?: (message: string) => void;
}

type FileState = "applied" | "corrupt" | "gone";

interface KnownFile {
	id: string;
	size: number;
	kind: "segment" | "snapshot";
	state: FileState;
	/** The Yjs update the file holds. Kept for applied files so Drive's content can be recomputed. */
	payload?: Uint8Array;
}

const MIN_BACKOFF_MS = 1000;
const FAILURES_BEFORE_OFFLINE = 2;
const DOWNLOAD_PARALLELISM = 4;
const KEEP_SNAPSHOTS = 2;
const MAX_PENDING_PARTS = 200;
/** Never compact more often than this, so a failing cleanup cannot spam snapshots. */
const MIN_COMPACT_GAP_MS = 30_000;

/**
 * Carries a vault's Y.Doc between devices through a Google Drive folder.
 *
 * There is no server and no authoritative copy. Every device keeps its own full
 * document and writes the Yjs updates it produces as small immutable files; every
 * device reads the files the others wrote and applies them. Yjs updates commute and
 * are idempotent, so duplicates, reordering and re-reads are harmless.
 *
 * Files in the vault folder:
 *   meta.json      layout schema, written once
 *   seg-*.ydu      one batch of updates from one device
 *   snap-*.yds     a full state; lets old segments be deleted
 *
 * Repair: any device that holds state Drive lacks (an upload that failed, a
 * segment that was damaged) re-uploads the difference at the next reconcile.
 *
 * Remote updates are applied with `this` as the Y.Doc origin, as SyncTransport
 * requires.
 */
interface TransportEvents {
	status: (event: { status: string }) => void;
	sync: (synced: boolean) => void;
	"custom-message": (payload: string) => void;
	message: (event: MessageEvent) => void;
}

export class DriveTransport extends ObservableV2<TransportEvents> implements SyncTransport {
	readonly awareness: Awareness;
	wsconnected = false;
	wsconnecting = false;
	private _synced = false;

	/** Set when the carrier stopped for a reason retrying cannot fix (e.g. layout mismatch). */
	fatalError: string | null = null;
	/** Last error seen, for diagnostics. */
	lastError: string | null = null;

	private readonly opts: Required<Omit<DriveTransportOptions, "ignoreOrigin" | "log" | "folderName">> & {
		folderName: string;
		ignoreOrigin: (origin: unknown) => boolean;
		log: (message: string) => void;
	};

	private folderId: string | null = null;
	private readonly known = new Map<string, KnownFile>();
	/** Merged copy of everything Drive is known to hold (applied or uploaded), as one Yjs update. */
	private remoteState: Uint8Array | null = null;
	/** True when a file vanished from Drive, so `remoteState` must be rebuilt from the payloads still there. */
	private remoteDirty = false;
	/** A file disappeared between listing and reading in the last poll; wait one cycle before repairing. */
	private pollSawGone = false;
	private pending: Uint8Array[] = [];
	private counter = 0;
	private lastReconcileAt = 0;
	private lastCompactAt = -Infinity;

	private started = false;
	private destroyed = false;
	private failures = 0;
	private chain: Promise<unknown> = Promise.resolve();
	private tickTimer: number | null = null;
	private flushTimer: number | null = null;

	private readonly onDocUpdate = (update: Uint8Array, origin: unknown): void => {
		if (origin === this || this.opts.ignoreOrigin(origin)) return;
		this.pending.push(update);
		if (this.pending.length > MAX_PENDING_PARTS) {
			this.pending = [Y.mergeUpdates(this.pending)];
		}
		this.scheduleFlush();
	};

	constructor(
		private readonly doc: Y.Doc,
		private readonly api: DriveApi,
		options: DriveTransportOptions,
	) {
		super();
		this.opts = {
			folderName: options.folderName ?? `YAOS ${options.vaultId}`,
			vaultId: options.vaultId,
			deviceId: options.deviceId,
			pollIntervalMs: options.pollIntervalMs ?? 3000,
			batchMs: options.batchMs ?? 2000,
			compactSegmentCount: options.compactSegmentCount ?? 50,
			compactSegmentBytes: options.compactSegmentBytes ?? 1_000_000,
			reconcileIntervalMs: options.reconcileIntervalMs ?? 5 * 60_000,
			maxBackoffMs: options.maxBackoffMs ?? 60_000,
			autoTimers: options.autoTimers ?? true,
			ignoreOrigin: options.ignoreOrigin ?? (() => false),
			now: options.now ?? (() => Date.now()),
			log: options.log ?? (() => undefined),
		};
		this.awareness = new Awareness(doc);
		doc.on("update", this.onDocUpdate);
	}

	get synced(): boolean {
		return this._synced;
	}

	// ---------------------------------------------------------------------
	// SyncTransport
	// ---------------------------------------------------------------------

	async connect(): Promise<void> {
		if (this.destroyed || this.fatalError || this.started) return;
		this.started = true;
		await this.attemptConnect();
	}

	disconnect(): void {
		this.started = false;
		this.clearTimers();
		this.markOffline();
	}

	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.started = false;
		this.clearTimers();
		this.doc.off("update", this.onDocUpdate);
		this.awareness.destroy();
		this.wsconnected = false;
		this.wsconnecting = false;
		this._synced = false;
		super.destroy();
	}

	// ---------------------------------------------------------------------
	// Driving the transport
	// ---------------------------------------------------------------------

	/**
	 * One full cycle: upload pending edits, read what others wrote, repair, compact.
	 * Used by the timer loop, and directly by tests. Never throws: failures are
	 * recorded, counted and turned into the offline state after a few in a row.
	 */
	async syncNow(): Promise<boolean> {
		if (this.destroyed || this.fatalError) return false;
		return this.serial(async () => {
			try {
				if (this.folderId === null) await this.prepareFolder();
				await this.flushLocked();
				await this.pollLocked();
				await this.maybeReconcileLocked();
				await this.maybeCompactLocked();
				this.recordSuccess();
				return true;
			} catch (err) {
				this.recordFailure(err);
				return false;
			}
		});
	}

	/** Upload pending local edits now. Rejects if the upload fails (edits stay queued). */
	flush(): Promise<void> {
		return this.serial(() => this.flushLocked());
	}

	/** Check now that Drive holds everything this device holds, and upload what is missing. */
	reconcile(): Promise<void> {
		return this.serial(() => this.reconcileLocked());
	}

	/** Number of local edits not yet uploaded. */
	get pendingParts(): number {
		return this.pending.length;
	}

	// ---------------------------------------------------------------------
	// Connection life cycle
	// ---------------------------------------------------------------------

	private async attemptConnect(): Promise<void> {
		this.wsconnecting = true;
		this.emit("status", [{ status: "connecting" }]);
		const ok = await this.serial(async () => {
			try {
				await this.prepareFolder();
				await this.flushLocked();
				await this.pollLocked();
				await this.reconcileLocked();
				return true;
			} catch (err) {
				this.recordFailure(err);
				return false;
			}
		});
		this.wsconnecting = false;
		if (ok) {
			this.failures = 0;
			this.markOnline();
		} else if (!this.fatalError) {
			this.emit("status", [{ status: "disconnected" }]);
		}
		this.scheduleTick();
	}

	private markOnline(): void {
		const wasOnline = this.wsconnected;
		this.wsconnected = true;
		if (!wasOnline) this.emit("status", [{ status: "connected" }]);
		if (!this._synced) {
			this._synced = true;
			this.emit("sync", [true]);
		}
	}

	private markOffline(): void {
		const wasOnline = this.wsconnected;
		this.wsconnected = false;
		this.wsconnecting = false;
		if (wasOnline) this.emit("status", [{ status: "disconnected" }]);
		if (this._synced) {
			this._synced = false;
			this.emit("sync", [false]);
		}
	}

	private recordSuccess(): void {
		this.failures = 0;
		this.lastError = null;
		if (this.started) this.markOnline();
	}

	private recordFailure(err: unknown): void {
		this.failures++;
		const message = err instanceof Error ? err.message : String(err);
		this.lastError = message;
		this.opts.log(`drive carrier: ${message}`);
		if (err instanceof LayoutMismatchError) {
			this.fatalError = message;
			this.started = false;
			this.clearTimers();
			this.markOffline();
			return;
		}
		if (this.failures >= FAILURES_BEFORE_OFFLINE) this.markOffline();
	}

	// ---------------------------------------------------------------------
	// Timers
	// ---------------------------------------------------------------------

	private clearTimers(): void {
		if (this.tickTimer !== null) window.clearTimeout(this.tickTimer);
		if (this.flushTimer !== null) window.clearTimeout(this.flushTimer);
		this.tickTimer = null;
		this.flushTimer = null;
	}

	private nextDelay(): number {
		if (this.failures === 0) return this.opts.pollIntervalMs;
		const backoff = MIN_BACKOFF_MS * 2 ** Math.min(this.failures - 1, 10);
		return Math.min(this.opts.maxBackoffMs, backoff);
	}

	private scheduleTick(): void {
		if (!this.opts.autoTimers || !this.started || this.destroyed || this.fatalError) return;
		if (this.tickTimer !== null) window.clearTimeout(this.tickTimer);
		this.tickTimer = window.setTimeout(() => {
			this.tickTimer = null;
			void this.syncNow().then(() => this.scheduleTick());
		}, this.nextDelay());
	}

	private scheduleFlush(): void {
		if (!this.opts.autoTimers || !this.started || this.destroyed || this.flushTimer !== null) return;
		this.flushTimer = window.setTimeout(() => {
			this.flushTimer = null;
			void this.syncNow();
		}, this.opts.batchMs);
	}

	// ---------------------------------------------------------------------
	// Serialisation: one Drive operation sequence at a time
	// ---------------------------------------------------------------------

	private serial<T>(task: () => Promise<T>): Promise<T> {
		const run = this.chain.then(task, task);
		this.chain = run.catch(() => undefined);
		return run;
	}

	// ---------------------------------------------------------------------
	// Folder and meta
	// ---------------------------------------------------------------------

	private async prepareFolder(): Promise<void> {
		let folders = await this.api.findFolders(this.opts.folderName);
		if (folders.length === 0) {
			const created = await this.api.createFolder(this.opts.folderName);
			folders = await this.api.findFolders(this.opts.folderName);
			if (!folders.some((f) => f.id === created.id)) folders.push(created);
		}
		// Two devices may have created the folder at the same moment: everyone picks the
		// same one (oldest, then lowest id), and an empty duplicate is removed.
		folders.sort((a, b) => a.createdTime - b.createdTime || (a.id < b.id ? -1 : 1));
		const chosen = folders[0];
		if (!chosen) throw new DriveError(500, "Could not create the vault folder");
		this.folderId = chosen.id;
		await this.ensureMeta(chosen.id);
	}

	private async ensureMeta(folderId: string): Promise<void> {
		const files = await this.api.listFiles(folderId);
		const metas = files.filter((f) => f.name === META_NAME).sort((a, b) => a.createdTime - b.createdTime);
		const first = metas[0];
		if (!first) {
			const body = JSON.stringify({ app: "yaos-drive", schema: DRIVE_LAYOUT_SCHEMA, vaultId: this.opts.vaultId });
			await this.api.createFile(folderId, META_NAME, new TextEncoder().encode(body));
			return;
		}
		const raw = new TextDecoder().decode(await this.api.readFile(first.id));
		let schema: unknown;
		try {
			const parsed: unknown = JSON.parse(raw);
			schema = typeof parsed === "object" && parsed !== null && "schema" in parsed ? parsed.schema : undefined;
		} catch {
			schema = undefined;
		}
		if (schema !== DRIVE_LAYOUT_SCHEMA) {
			throw new LayoutMismatchError(
				`This vault folder on Drive uses layout ${String(schema)}, but this plugin understands layout ${DRIVE_LAYOUT_SCHEMA}. Update the plugin on all devices.`,
			);
		}
	}

	// ---------------------------------------------------------------------
	// Sending
	// ---------------------------------------------------------------------

	private async flushLocked(): Promise<void> {
		if (this.pending.length === 0) return;
		if (this.folderId === null) await this.prepareFolder();
		const batch = this.pending;
		this.pending = [];
		try {
			await this.uploadUpdate(KIND_SEGMENT, Y.mergeUpdates(batch));
		} catch (err) {
			// Keep the edits (ahead of anything typed meanwhile) and let the caller back off.
			this.pending = [...batch, ...this.pending];
			throw err;
		}
	}

	private async uploadUpdate(kind: FileKind, update: Uint8Array): Promise<DriveFileInfo> {
		const folderId = this.folderId;
		if (folderId === null) throw new DriveError(500, "No vault folder");
		const data = await encodeFile(kind, update);
		const now = this.opts.now();
		const name = kind === KIND_SEGMENT
			? segmentName(now, this.opts.deviceId, this.counter++)
			: snapshotName(now, this.opts.deviceId, this.counter++);
		const info = await this.api.createFile(folderId, name, data);
		if (info.size !== data.length) {
			// Drive reported a different size than we sent: do not trust this upload.
			await this.api.deleteFile(info.id).catch(() => undefined);
			throw new DriveError(502, `Upload of ${name} was stored with a different size (${info.size} != ${data.length})`);
		}
		this.known.set(name, {
			id: info.id,
			size: info.size,
			kind: kind === KIND_SEGMENT ? "segment" : "snapshot",
			state: "applied",
			payload: update,
		});
		this.mergeRemote(update);
		return info;
	}

	private rebuildRemoteIfDirty(): void {
		if (!this.remoteDirty) return;
		const parts: Uint8Array[] = [];
		for (const f of this.known.values()) {
			if (f.state === "applied" && f.payload) parts.push(f.payload);
		}
		this.remoteState = parts.length > 0 ? Y.mergeUpdates(parts) : null;
		this.remoteDirty = false;
	}

	private mergeRemote(update: Uint8Array): void {
		this.remoteState = this.remoteState ? Y.mergeUpdates([this.remoteState, update]) : update;
	}

	// ---------------------------------------------------------------------
	// Receiving
	// ---------------------------------------------------------------------

	private async pollLocked(): Promise<void> {
		const folderId = this.folderId;
		if (folderId === null) throw new DriveError(500, "No vault folder");
		const listing = await this.api.listFiles(folderId);

		const present = new Set<string>();
		const fresh: { name: string; info: DriveFileInfo; kind: "segment" | "snapshot" }[] = [];
		for (const info of listing) {
			const kind = classifyName(info.name);
			if (kind !== "segment" && kind !== "snapshot") continue;
			present.add(info.name);
			if (!this.known.has(info.name)) fresh.push({ name: info.name, info, kind });
		}
		fresh.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		this.pollSawGone = false;
		for (let i = 0; i < fresh.length; i += DOWNLOAD_PARALLELISM) {
			const group = fresh.slice(i, i + DOWNLOAD_PARALLELISM);
			const downloaded = await Promise.all(group.map((f) => this.download(f.info)));
			// Apply in name order so progress is deterministic.
			group.forEach((f, idx) => {
				const result = downloaded[idx];
				if (!result) return;
				this.applyDownloaded(f.name, f.info, f.kind, result);
			});
		}

		// Forget files that left Drive (compaction by any device, or the user). Only after the new
		// files above were applied, so a snapshot that replaces them is already in.
		for (const [name, file] of Array.from(this.known.entries())) {
			if (present.has(name)) continue;
			this.known.delete(name);
			if (file.state === "applied") this.remoteDirty = true;
		}
	}

	private async download(info: DriveFileInfo): Promise<{ state: "ok"; payload: Uint8Array; kind: FileKind } | { state: "gone" } | { state: "corrupt"; reason: string }> {
		let bytes: Uint8Array;
		try {
			bytes = await this.api.readFile(info.id);
		} catch (err) {
			if (err instanceof DriveError && err.notFound) return { state: "gone" };
			throw err;
		}
		try {
			const decoded = await decodeFile(bytes);
			return { state: "ok", payload: decoded.payload, kind: decoded.kind };
		} catch (err) {
			if (err instanceof CorruptFileError) return { state: "corrupt", reason: err.message };
			throw err;
		}
	}

	private applyDownloaded(
		name: string,
		info: DriveFileInfo,
		nameKind: "segment" | "snapshot",
		result: { state: "ok"; payload: Uint8Array; kind: FileKind } | { state: "gone" } | { state: "corrupt"; reason: string },
	): void {
		if (result.state === "gone") {
			// Compacted away between listing and reading; a snapshot covers it.
			this.known.set(name, { id: info.id, size: info.size, kind: nameKind, state: "gone" });
			this.pollSawGone = true;
			return;
		}
		if (result.state === "corrupt") {
			this.opts.log(`drive carrier: skipping damaged file ${name}: ${result.reason}`);
			this.known.set(name, { id: info.id, size: info.size, kind: nameKind, state: "corrupt" });
			return;
		}
		const expected = nameKind === "segment" ? KIND_SEGMENT : KIND_SNAPSHOT;
		if (result.kind !== expected) {
			this.opts.log(`drive carrier: skipping ${name}: kind does not match its name`);
			this.known.set(name, { id: info.id, size: info.size, kind: nameKind, state: "corrupt" });
			return;
		}
		try {
			Y.applyUpdate(this.doc, result.payload, this);
		} catch (err) {
			this.opts.log(`drive carrier: skipping ${name}: update could not be applied (${err instanceof Error ? err.message : String(err)})`);
			this.known.set(name, { id: info.id, size: info.size, kind: nameKind, state: "corrupt" });
			return;
		}
		try {
			this.mergeRemote(result.payload);
		} catch {
			// The update applied but could not be merged into the cache; reconcile will cover it.
		}
		this.known.set(name, { id: info.id, size: info.size, kind: nameKind, state: "applied", payload: result.payload });
	}

	// ---------------------------------------------------------------------
	// Repair: make sure Drive holds everything this device holds
	// ---------------------------------------------------------------------

	private async maybeReconcileLocked(): Promise<void> {
		const every = this.opts.reconcileIntervalMs;
		if (every <= 0) return;
		if (this.opts.now() - this.lastReconcileAt < every) return;
		await this.reconcileLocked();
	}

	private async reconcileLocked(): Promise<void> {
		if (this.folderId === null) await this.prepareFolder();
		await this.flushLocked();
		if (this.pollSawGone) return;
		this.lastReconcileAt = this.opts.now();
		this.rebuildRemoteIfDirty();
		const remote = new Y.Doc();
		try {
			if (this.remoteState) Y.applyUpdate(remote, this.remoteState);
			if (Y.equalSnapshots(Y.snapshot(this.doc), Y.snapshot(remote))) return;
			const missing = Y.encodeStateAsUpdate(this.doc, Y.encodeStateVector(remote));
			this.opts.log("drive carrier: Drive lacks local state, uploading the difference");
			await this.uploadUpdate(KIND_SEGMENT, missing);
		} finally {
			remote.destroy();
		}
	}

	// ---------------------------------------------------------------------
	// Compaction
	// ---------------------------------------------------------------------

	private async maybeCompactLocked(): Promise<void> {
		let count = 0;
		let bytes = 0;
		for (const f of this.known.values()) {
			if (f.kind === "segment" && f.state === "applied") {
				count++;
				bytes += f.size;
			}
		}
		if (count <= this.opts.compactSegmentCount && bytes <= this.opts.compactSegmentBytes) return;
		if (this.opts.now() - this.lastCompactAt < MIN_COMPACT_GAP_MS) return;
		this.lastCompactAt = this.opts.now();
		await this.compactLocked();
	}

	/**
	 * Write a full snapshot, then delete the segments it covers and surplus old snapshots.
	 * Only files this device has applied are ever deleted. If another device compacts at the
	 * same moment both snapshots are valid and the extra deletes are harmless.
	 */
	private async compactLocked(): Promise<void> {
		const covered: [string, KnownFile][] = [];
		for (const entry of this.known.entries()) {
			if (entry[1].kind === "segment" && entry[1].state === "applied") covered.push(entry);
		}
		if (covered.length === 0) return;
		await this.uploadUpdate(KIND_SNAPSHOT, Y.encodeStateAsUpdate(this.doc));
		for (const [name, file] of covered) {
			if (await this.deleteQuiet(file.id)) this.known.delete(name);
		}
		const snaps = Array.from(this.known.entries())
			.filter(([, f]) => f.kind === "snapshot" && f.state === "applied")
			.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
		for (const [name, file] of snaps.slice(0, Math.max(0, snaps.length - KEEP_SNAPSHOTS))) {
			if (await this.deleteQuiet(file.id)) this.known.delete(name);
		}
	}

	private async deleteQuiet(id: string): Promise<boolean> {
		try {
			await this.api.deleteFile(id);
			return true;
		} catch (err) {
			if (err instanceof DriveError && err.notFound) return true;
			this.opts.log(`drive carrier: could not delete an old file: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}
}

class LayoutMismatchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LayoutMismatchError";
	}
}

import * as Y from "yjs";
import { ObservableV2 } from "lib0/observable";
import { Awareness } from "y-protocols/awareness";
import type { SyncTransport } from "../sync/transport";
import { makeSvEchoMessage } from "../sync/svEchoMessage";
import { DriveError, type DriveApi, type DriveFileInfo } from "./driveApi";
import { resolveVaultFolder } from "./driveFolders";
import { EncryptionError } from "./driveCrypto";
import { DriveOperation, DriveOperationStopped } from "./driveOperation";
import { DRIVE_LAYOUT_SCHEMA, DriveKeyring, FatalCarrierError } from "./driveKeyring";
import type { ActivityEvent, ActivitySource } from "./activity";
import {
	CorruptFileError,
	KIND_SEGMENT,
	KIND_SNAPSHOT,
	classifyName,
	decodeFile,
	encodeFile,
	segmentName,
	snapshotName,
	type FileKind,
} from "./fileFormat";

export { DRIVE_LAYOUT_SCHEMA };

export interface DriveTransportOptions {
	vaultId: string;
	/** Random per-install id; keeps file names from different devices apart. */
	deviceId: string;
	/** Drive folder name. Defaults to `YAOS <vaultId>`. */
	folderName?: string;
	/** Delay between polls while everything works. */
	pollIntervalMs?: number;
	/**
	 * Request budget. After this long without a local edit, a remote change or the
	 * window coming to the front, polling slows down to `idlePollIntervalMs`.
	 * Unset: never slow down.
	 */
	idleAfterMs?: number;
	idlePollIntervalMs?: number;
	/**
	 * Polling interval while the window is hidden (needs `activity`). 0 stops polling
	 * until the window is visible again (phones suspend apps anyway). Unset: same as normal.
	 */
	backgroundPollIntervalMs?: number;
	/** Tells the transport when the window is shown, hidden, or the network returns. */
	activity?: ActivitySource;
	/** Checks the vault folder's meta file and holds the encryption key. Default: not encrypted. */
	keyring?: DriveKeyring;
	/** Called once when the carrier stops for a reason retrying cannot fix. */
	onFatal?: (message: string) => void;
	/** Local edits are batched for this long before one segment is uploaded. */
	batchMs?: number;
	/** Compact when this many segment files exist... */
	compactSegmentCount?: number;
	/** ...or when they total this many bytes. */
	compactSegmentBytes?: number;
	/** Check that Drive holds everything we hold, this often (ms). 0 disables. */
	reconcileIntervalMs?: number;
	/** F6: how many snapshots to keep when compacting (2-10). Default 4; 2 is 2.1.22 exactly. */
	keepSnapshots?: number;
	/**
	 * F6: read a replacement file back from Drive and check it before any file it
	 * covers is deleted. Default true (safety); false skips the readback and
	 * restores 2.1.22's byte behaviour for metered connections.
	 */
	verifyBeforePrune?: boolean;
	/**
	 * F1: how compaction works. "adaptive" (default) merges the change files into
	 * one and only writes a full snapshot when it is actually smaller; "legacy" is
	 * 2.1.22: a full snapshot at the first trigger, whatever it costs. See
	 * DEFAULT_COMPACTION_MODE.
	 */
	compaction?: CompactionMode;
	/**
	 * F1: the largest snapshot compaction will write, in bytes. Above it the
	 * change files are merged instead. Default 64 MB.
	 */
	snapshotMaxBytes?: number;
	/**
	 * F7: how many bytes of applied update payloads may be held in memory.
	 * Default 32 MB; the oldest are dropped first and re-read from Drive if a
	 * rebuild ever needs them.
	 */
	maxRetainedPayloadBytes?: number;
	/** Largest wait after repeated failures. */
	maxBackoffMs?: number;
	/** One whole cycle (upload, poll, repair, compact) may take this long before it counts as a failure. Default 5 minutes (a large first snapshot on a slow link must still fit). */
	cycleTimeoutMs?: number;
	/** How long a file this device just uploaded may be missing from the listing before it is forgotten. Default 60 s. */
	listingGraceMs?: number;
	/** false: no timers at all; the owner drives the transport with syncNow(). */
	autoTimers?: boolean;
	/** Origins whose Y.Doc updates are NOT local edits (e.g. the IndexedDB persistence). */
	ignoreOrigin?: (origin: unknown) => boolean;
	/**
	 * F2: CRDT schema admission. Returns the reason this device must not read or
	 * write this vault (null when it may). Cloudflare refuses a newer-schema room
	 * at socket admission; a carrier with no server has to ask the engine, both
	 * after a poll (remote data can raise the document's version) and before any
	 * upload. Unset: no check, exactly as before.
	 */
	guardSchema?: () => string | null;
	/**
	 * F5: a device that saved a folder id for this vault keeps using that folder
	 * even after it was renamed in Drive, and a newly resolved id is handed back
	 * to be saved. Unset: the folder is found by name every start, exactly as
	 * before.
	 */
	folderIdentity?: {
		saved(): string | undefined;
		remember(id: string): void;
	};
	/**
	 * Told once per session about something the user should know but that is not
	 * an error (a duplicate vault folder, an empty folder about to receive a
	 * large local document). Unset: only the log line.
	 */
	onNotice?: (message: string) => void;
	/** Local state above this many bytes in an empty vault folder is worth the F5 warning. Default 1 MB. */
	splitBrainWarnBytes?: number;
	now?: () => number;
	log?: (message: string) => void;
}

type FileState = "applied" | "corrupt" | "gone";

interface KnownFile {
	id: string;
	size: number;
	/** Drive's own creation time. Never a device clock, so it is safe to order by. */
	created?: number;
	/** When this device uploaded it (this device's clock; only used for the listing grace). */
	uploadedAt?: number;
	kind: "segment" | "snapshot";
	state: FileState;
	/**
	 * The Yjs update the file holds, while it is retained (F7: applied payloads
	 * may be dropped once a later file covers them, or when the memory bound is
	 * reached; a rebuild then re-reads them from Drive).
	 */
	payload?: Uint8Array;
	/** The state vector of `payload`, computed once when a coverage test needs it. */
	sv?: Uint8Array;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

const MIN_BACKOFF_MS = 1000;
const FAILURES_BEFORE_OFFLINE = 2;
const DOWNLOAD_PARALLELISM = 4;
/**
 * F6: how many snapshots are kept by one compaction. Four is the default: the
 * snapshot just written, plus three older ones to fall back on, at the cost of
 * one extra document-sized file per compaction. 2 restores 2.1.22 exactly.
 */
export const DEFAULT_KEEP_SNAPSHOTS = 4;
export const KEEP_SNAPSHOTS_MIN = 2;
export const KEEP_SNAPSHOTS_MAX = 10;

/** Clamp the `driveKeepSnapshots` setting into its allowed range. */
export function clampKeepSnapshots(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_KEEP_SNAPSHOTS;
	return Math.min(KEEP_SNAPSHOTS_MAX, Math.max(KEEP_SNAPSHOTS_MIN, Math.floor(value)));
}
/** F1: the two compaction modes. `adaptive` is the default; `legacy` is 2.1.22. */
export type CompactionMode = "adaptive" | "legacy";
export const DEFAULT_COMPACTION_MODE: CompactionMode = "adaptive";
/** F1: a snapshot is only written when it is at most this share of the change files it replaces. */
const SNAPSHOT_WORTH_RATIO = 0.6;

function stateVectorCovers(cover: Uint8Array, part: Uint8Array): boolean {
	const whole = Y.decodeStateVector(cover);
	for (const [client, clock] of Y.decodeStateVector(part)) {
		if ((whole.get(client) ?? 0) < clock) return false;
	}
	return true;
}

const MAX_PENDING_PARTS = 200;
/** How many times one cycle re-reads Drive while the picture is incomplete. */
const MAX_COMPLETE_POLLS = 3;
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

	private readonly opts: Required<Omit<DriveTransportOptions, "ignoreOrigin" | "log" | "folderName" | "idleAfterMs" | "idlePollIntervalMs" | "backgroundPollIntervalMs" | "activity" | "keyring" | "onFatal" | "guardSchema" | "folderIdentity" | "onNotice">> & {
		idleAfterMs: number | undefined;
		idlePollIntervalMs: number | undefined;
		backgroundPollIntervalMs: number | undefined;
		onFatal: ((message: string) => void) | undefined;
		onNotice: ((message: string) => void) | undefined;
		guardSchema: (() => string | null) | undefined;
		folderIdentity: { saved(): string | undefined; remember(id: string): void } | undefined;
		folderName: string;
		ignoreOrigin: (origin: unknown) => boolean;
		log: (message: string) => void;
	};

	/** Notices already handed to the owner this session (keyed, so a retry does not repeat them). */
	private readonly noticesShown = new Set<string>();

	private folderId: string | null = null;
	private readonly known = new Map<string, KnownFile>();
	/** Merged copy of everything Drive is known to hold (applied or uploaded), as one Yjs update. */
	private remoteState: Uint8Array | null = null;
	/** True when a file vanished from Drive, so `remoteState` must be rebuilt from the payloads still there. */
	private remoteDirty = false;
	/** A file disappeared between listing and reading in the last poll; wait one cycle before repairing. */
	private pollSawGone = false;
	/** F7: bytes of retained update payloads, so the memory bound can be enforced. */
	private retainedBytes = 0;
	private pending: Uint8Array[] = [];
	private counter = 0;
	/** Number of files this session has stored on Drive. Reported as the "persistence generation" in receipts. */
	private storedGeneration = 0;
	/** Names this session's receipts, so a restart re-baselines the receipt tracker instead of confusing it. */
	private readonly receiptEpoch: string;
	private lastReconcileAt = 0;
	private lastCompactAt = -Infinity;

	private started = false;
	private destroyed = false;
	private failures = 0;
	private chain: Promise<unknown> = Promise.resolve();
	private session = 0;
	private activeOperation: DriveOperation | null = null;
	private tickTimer: number | null = null;
	private flushTimer: number | null = null;

	private readonly keyring: DriveKeyring;
	private lastActivityAt: number;
	private visible = true;
	private unsubscribeActivity: (() => void) | null = null;

	private readonly onDocUpdate = (update: Uint8Array, origin: unknown): void => {
		if (origin === this || this.opts.ignoreOrigin(origin)) return;
		this.lastActivityAt = this.opts.now();
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
			idleAfterMs: options.idleAfterMs,
			idlePollIntervalMs: options.idlePollIntervalMs,
			backgroundPollIntervalMs: options.backgroundPollIntervalMs,
			onFatal: options.onFatal,
			onNotice: options.onNotice,
			guardSchema: options.guardSchema,
			folderIdentity: options.folderIdentity,
			splitBrainWarnBytes: options.splitBrainWarnBytes ?? 1_048_576,
			batchMs: options.batchMs ?? 2000,
			cycleTimeoutMs: options.cycleTimeoutMs ?? 300_000,
			listingGraceMs: options.listingGraceMs ?? 60_000,
			// F1: adaptive compaction bounds the file count, so its cap is higher;
			// "legacy" keeps 2.1.22's 50 exactly.
			compactSegmentCount: options.compactSegmentCount ?? (options.compaction === "legacy" ? 50 : 200),
			compactSegmentBytes: options.compactSegmentBytes ?? 1_000_000,
			keepSnapshots: clampKeepSnapshots(options.keepSnapshots),
			verifyBeforePrune: options.verifyBeforePrune ?? true,
			compaction: options.compaction === "legacy" ? "legacy" : "adaptive",
			snapshotMaxBytes: options.snapshotMaxBytes ?? 64 * 1024 * 1024,
			maxRetainedPayloadBytes: options.maxRetainedPayloadBytes ?? 32 * 1024 * 1024,
			reconcileIntervalMs: options.reconcileIntervalMs ?? 5 * 60_000,
			maxBackoffMs: options.maxBackoffMs ?? 60_000,
			autoTimers: options.autoTimers ?? true,
			ignoreOrigin: options.ignoreOrigin ?? (() => false),
			now: options.now ?? (() => Date.now()),
			log: options.log ?? (() => undefined),
		};
		this.receiptEpoch = `drive:${options.deviceId}:${this.opts.now()}`;
		this.lastActivityAt = this.opts.now();
		this.keyring = options.keyring ?? new DriveKeyring(api, {
			vaultId: options.vaultId,
			passphrase: "",
			folderName: this.opts.folderName,
		});
		this.awareness = new Awareness(doc);
		doc.on("update", this.onDocUpdate);
		if (options.activity) {
			this.visible = options.activity.isVisible();
			this.unsubscribeActivity = options.activity.subscribe((event) => this.onActivity(event));
		}
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
		this.session++;
		this.activeOperation?.cancel();
		this.started = false;
		this.clearTimers();
		this.markOffline();
	}

	destroy(): void {
		if (this.destroyed) return;
		this.session++;
		this.activeOperation?.cancel();
		// Preserve the existing best-effort final upload, but detach an immutable
		// batch from the live transport. Its completion cannot touch the document,
		// keyring, queue, receipts, or compaction state of the ended session.
		if (this.started && !this.fatalError && this.pending.length > 0 && this.folderId !== null && this.keyring.isReady) {
			const update = Y.mergeUpdates(this.pending);
			const folderId = this.folderId;
			const sealer = this.keyring.sealer;
			const api = this.api;
			const name = segmentName(this.opts.now(), this.opts.deviceId, this.counter++);
			void (async () => {
				const body = sealer ? await sealer.seal(update, "segment") : update;
				const data = await encodeFile(KIND_SEGMENT, body, sealer !== null);
				await api.createFile(folderId, name, data);
			})().catch(() => undefined);
		}
		this.destroyed = true;
		this.started = false;
		this.clearTimers();
		this.unsubscribeActivity?.();
		this.unsubscribeActivity = null;
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
		return this.cycle(async (op) => {
			this.assertSchemaAdmission();
			if (this.folderId === null) await this.prepareFolder(op);
			op.check();
			await this.flushLocked(op);
			op.check();
			await this.pollCompleteLocked(op);
			op.check();
			await this.maybeReconcileLocked(op);
			op.check();
			await this.maybeCompactLocked(op);
			op.check();
			this.recordSuccess();
			return true;
		});
	}

	/**
	 * Run one cycle under a time limit. A request that never answers (Wi-Fi to
	 * mobile switch, suspended socket) used to hold the serial chain forever;
	 * now the cycle fails, the failure back-off applies, and the next cycle runs.
	 */
	private async cycle(work: (op: DriveOperation) => Promise<boolean>): Promise<boolean> {
		try {
			return await this.runOperation(work);
		} catch (err) {
			if (!(err instanceof DriveOperationStopped) && !this.destroyed) this.recordFailure(err);
			return false;
		}
	}

	/**
	 * Poll, and if the picture is incomplete (a file vanished between listing and
	 * reading, or an update depends on one we have not seen) look again a few
	 * times before the caller reports "synced".
	 */
	private async pollCompleteLocked(op: DriveOperation): Promise<void> {
		for (let attempt = 0; attempt < MAX_COMPLETE_POLLS; attempt++) {
			await this.pollLocked(op);
			// F2: an update we just applied may have raised the document's schema
			// version. Refuse before reconcile, compaction, a receipt or "synced".
			this.assertSchemaAdmission();
			op.check();
			if (this.isComplete()) return;
		}
	}

	/** True when every update this device has read could be applied and nothing is waiting for a missing file. */
	private isComplete(): boolean {
		if (this.pollSawGone || this.unreadableFiles > 0) return false;
		return this.doc.store.pendingStructs === null && this.doc.store.pendingDs === null;
	}

	/** F7: how many bytes of applied update payloads are held in memory right now. */
	get retainedPayloadBytes(): number {
		return this.retainedBytes;
	}

	/** Number of files this device knows about on Drive (applied, damaged or gone). */
	get knownFiles(): number {
		return this.known.size;
	}

	/** Number of files on Drive this device cannot read (damaged, wrong key, plaintext in an encrypted vault). */
	get unreadableFiles(): number {
		let n = 0;
		for (const f of this.known.values()) if (f.state === "corrupt") n++;
		return n;
	}

	/** Upload pending local edits now. Rejects if the upload fails (edits stay queued). */
	flush(): Promise<void> {
		return this.runOperation((op) => this.flushLocked(op));
	}

	/** Check now that Drive holds everything this device holds, and upload what is missing. */
	reconcile(): Promise<void> {
		return this.runOperation((op) => this.reconcileLocked(op));
	}

	/** Number of local edits not yet uploaded. */
	get pendingParts(): number {
		return this.pending.length;
	}

	// ---------------------------------------------------------------------
	// Connection life cycle
	// ---------------------------------------------------------------------

	private async attemptConnect(): Promise<void> {
		const session = this.session;
		this.wsconnecting = true;
		this.emit("status", [{ status: "connecting" }]);
		const ok = await this.cycle(async (op) => {
			this.assertSchemaAdmission();
			await this.prepareFolder(op);
			op.check();
			await this.flushLocked(op);
			op.check();
			await this.pollCompleteLocked(op);
			op.check();
			await this.reconcileLocked(op);
			op.check();
			return true;
		});
		if (this.destroyed || session !== this.session) return;
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
		if (!this.started || this.destroyed) return;
		// Never release bootstrap or retain a complete status with unreadable data.
		if (!this.isComplete()) {
			if (this._synced) {
				this._synced = false;
				this.emit("sync", [false]);
			}
			this.lastError = this.unreadableFiles > 0
				? "Some files on Google Drive are damaged or unreadable. Sync is incomplete; restore the damaged files from a trusted backup before continuing."
				: "Some updates on Google Drive are missing or cannot be applied yet";
			this.opts.log(`drive carrier: ${this.lastError}`);
			return;
		}
		if (!this._synced) {
			this._synced = true;
			this.emit("sync", [true]);
			this.emitReceipt();
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
		if (err instanceof FatalCarrierError) {
			this.failHard(message);
			return;
		}
		if (this.failures >= FAILURES_BEFORE_OFFLINE) this.markOffline();
	}

	/**
	 * Stop the carrier for a reason retrying cannot fix (layout mismatch, wrong
	 * passphrase, unreadable schema). Idempotent: whichever path noticed first,
	 * the owner is told once and the counters/timers end up the same.
	 */
	private failHard(message: string): void {
		if (this.fatalError === message) return;
		this.fatalError = message;
		this.started = false;
		this.clearTimers();
		this.markOffline();
		this.opts.onFatal?.(message);
	}

	/**
	 * F2: refuse a vault whose CRDT schema is newer than this plugin understands.
	 *
	 * The Cloudflare Worker rejects such a room at socket admission. Neither the
	 * Drive carrier nor the Local network carrier has a server, so the check is
	 * made here: after every poll (an applied remote update can raise the
	 * document's version) and before every upload (so no data is ever written
	 * under a schema this device cannot honour). Unset guard: no check at all.
	 */
	private assertSchemaAdmission(): void {
		const problem = this.opts.guardSchema?.() ?? null;
		if (problem === null) return;
		this.lastError = problem;
		this.opts.log(`drive carrier: ${problem}`);
		this.failHard(problem);
		throw new FatalCarrierError(problem);
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

	/**
	 * Change how often this transport talks to Drive while it runs (the settings
	 * screen calls this, so a rate-limited user does not have to restart).
	 * Only the timing values can change; nothing else is touched.
	 */
	applyPace(pace: {
		pollIntervalMs: number;
		idleAfterMs: number;
		idlePollIntervalMs: number;
		backgroundPollIntervalMs: number;
		batchMs: number;
		reconcileIntervalMs: number;
	}): void {
		this.opts.pollIntervalMs = pace.pollIntervalMs;
		this.opts.idleAfterMs = pace.idleAfterMs;
		this.opts.idlePollIntervalMs = pace.idlePollIntervalMs;
		this.opts.backgroundPollIntervalMs = pace.backgroundPollIntervalMs;
		this.opts.batchMs = pace.batchMs;
		this.opts.reconcileIntervalMs = pace.reconcileIntervalMs;
		if (this.started && !this.destroyed) this.scheduleTick();
	}

	/**
	 * How long to wait before the next poll, or null when polling is paused
	 * (window hidden and background polling switched off). This is the
	 * request budget: failures back off, an idle device slows down, a hidden
	 * window slows down or stops.
	 */
	nextPollDelayMs(): number | null {
		if (this.failures > 0) {
			if (!this.visible && this.opts.backgroundPollIntervalMs === 0) return null;
			const backoff = MIN_BACKOFF_MS * 2 ** Math.min(this.failures - 1, 10);
			return Math.min(this.opts.maxBackoffMs, backoff);
		}
		const normal = this.opts.pollIntervalMs;
		if (!this.visible && this.opts.backgroundPollIntervalMs !== undefined) {
			const background = this.opts.backgroundPollIntervalMs;
			return background === 0 ? null : Math.max(normal, background);
		}
		const idleAfter = this.opts.idleAfterMs;
		const idleEvery = this.opts.idlePollIntervalMs;
		if (idleAfter !== undefined && idleEvery !== undefined && this.opts.now() - this.lastActivityAt >= idleAfter) {
			return Math.max(normal, idleEvery);
		}
		return normal;
	}

	private scheduleTick(): void {
		if (!this.opts.autoTimers || !this.started || this.destroyed || this.fatalError) return;
		if (this.tickTimer !== null) window.clearTimeout(this.tickTimer);
		this.tickTimer = null;
		const delay = this.nextPollDelayMs();
		if (delay === null) return;
		this.tickTimer = window.setTimeout(() => {
			this.tickTimer = null;
			void this.syncNow().then(() => this.scheduleTick());
		}, delay);
	}

	private onActivity(event: ActivityEvent): void {
		if (this.destroyed) return;
		if (event === "hidden") {
			this.visible = false;
			if (!this.started) return;
			// Send what is waiting before the app may be suspended, then poll less or not at all.
			if (this.pending.length > 0) void this.flush().catch(() => undefined);
			this.scheduleTick();
			return;
		}
		if (event === "visible" || event === "online") {
			if (event === "visible") this.visible = true;
			this.lastActivityAt = this.opts.now();
			if (!this.started || this.fatalError || !this.visible) return;
			// Back in front or back online: look right now instead of waiting for the next timer.
			if (this.tickTimer !== null) window.clearTimeout(this.tickTimer);
			this.tickTimer = null;
			void this.syncNow().then(() => this.scheduleTick());
		}
	}

	private scheduleFlush(): void {
		if (!this.opts.autoTimers || !this.started || this.destroyed || this.flushTimer !== null) return;
		this.flushTimer = window.setTimeout(() => {
			this.flushTimer = null;
			// A cycle also polls, so restart the poll timer from the (now busy) state.
			void this.syncNow().then(() => this.scheduleTick());
		}, this.opts.batchMs);
	}

	// ---------------------------------------------------------------------
	// Serialisation: one Drive operation sequence at a time
	// ---------------------------------------------------------------------

	private runOperation<T>(task: (op: DriveOperation) => Promise<T>): Promise<T> {
		const session = this.session;
		const start = async (): Promise<T> => {
			if (this.destroyed || session !== this.session) throw new DriveOperationStopped();
			const op = new DriveOperation();
			this.activeOperation = op;
			const ms = this.opts.cycleTimeoutMs;
			const timer = ms > 0 && Number.isFinite(ms)
				? window.setTimeout(() => op.cancel(new DriveError(408, `Timeout (${ms} ms) during a Drive operation`)), ms)
				: null;
			try {
				return await op.wait(() => task(op));
			} finally {
				if (timer !== null) window.clearTimeout(timer);
				op.cancel();
				if (this.activeOperation === op) this.activeOperation = null;
			}
		};
		const run = this.chain.then(start, start);
		this.chain = run.catch(() => undefined);
		return run;
	}

	// ---------------------------------------------------------------------
	// Folder and meta
	// ---------------------------------------------------------------------

	private async prepareFolder(op: DriveOperation): Promise<void> {
		// F5: the remembered folder id wins, so a folder renamed in Drive is used
		// again instead of a second empty folder being created (and the whole vault
		// uploaded into it). Duplicates are reported, never deleted.
		const resolution = await op.wait(() => resolveVaultFolder(this.api, {
			name: this.opts.folderName,
			vaultId: this.opts.vaultId,
			savedId: this.opts.folderIdentity?.saved(),
		}));
		op.check();
		if (!resolution.id) throw new DriveError(500, "Could not create the vault folder");
		if (resolution.warning) this.reportNotice("vault-folder-duplicate", `YAOS: ${resolution.warning}`);
		// Two devices creating the folder in the same moment leave an empty folder
		// behind (the choice already converged on the oldest one). That used to be
		// silent; it is not worth a Notice, but it is worth a line in the log.
		else if (resolution.folders > 1) this.opts.log(`drive carrier: ${String(resolution.folders)} folders are named "${this.opts.folderName}"; using the oldest one`);
		// The folder counts as ready only once the keyring knows whether the vault is
		// encrypted. Setting it first let a later cycle skip this step after one failed
		// meta.json call and upload plaintext into an encrypted vault.
		await op.wait(() => this.keyring.ensureMeta(resolution.id, op.check));
		op.check();
		if (!this.keyring.isReady) throw new DriveError(500, "The vault key is not ready");
		// A folder that held nothing before YAOS wrote its meta file, on a device
		// that already has a large document: check before the first upload.
		if (this.keyring.listedFileCount === 0) this.warnAboutEmptyVaultFolder();
		this.folderId = resolution.id;
		this.opts.folderIdentity?.remember(resolution.id);
	}

	/** One notice per key per session; the log line is written every time. */
	private reportNotice(key: string, message: string): void {
		this.opts.log(`drive carrier: ${message}`);
		if (this.noticesShown.has(key)) return;
		this.noticesShown.add(key);
		this.opts.onNotice?.(message);
	}

	private warnAboutEmptyVaultFolder(): void {
		let bytes: number;
		try {
			bytes = Y.encodeStateAsUpdate(this.doc).length;
		} catch {
			return;
		}
		if (bytes < this.opts.splitBrainWarnBytes) return;
		const size = `${(bytes / 1_048_576).toFixed(1)} MB`;
		this.reportNotice(
			"empty-vault-folder",
			"YAOS: this device found an empty vault folder on Google Drive and is about to upload its own copy of the vault "
			+ `(${size} of notes). If this vault already syncs, that is a sign this device cannot see the folder the other devices use: `
			+ "Google lets a sign-in see only the files it created, so a vault made with a different Google client stays invisible here. "
			+ "Check your Google Drive for a second folder before letting both sides run.",
		);
	}

	// ---------------------------------------------------------------------
	// Sending
	// ---------------------------------------------------------------------

	private async flushLocked(op: DriveOperation): Promise<void> {
		if (this.pending.length === 0) return;
		if (this.folderId === null) await this.prepareFolder(op);
		op.check();
		const batch = this.pending;
		this.pending = [];
		let restored = false;
		const restore = (): void => {
			if (restored) return;
			restored = true;
			this.pending = [...batch, ...this.pending];
		};
		const detach = op.onCancel(restore);
		try {
			await this.uploadUpdate(KIND_SEGMENT, Y.mergeUpdates(batch), op);
			op.check();
		} catch (err) {
			restore();
			throw err;
		} finally {
			detach();
		}
	}

	private async uploadUpdate(kind: FileKind, update: Uint8Array, op: DriveOperation, nameOverride?: string): Promise<DriveFileInfo> {
		// F2: the single choke point for every Drive write (segments from edits,
		// repairs, compaction snapshots). Nothing is written under a schema this
		// device cannot honour, whichever path (cycle, flush, reconcile) asked.
		this.assertSchemaAdmission();
		const folderId = this.folderId;
		if (folderId === null) throw new DriveError(500, "No vault folder");
		if (!this.keyring.isReady) throw new DriveError(500, "The vault key is not ready");
		const sealer = this.keyring.sealer;
		const body = sealer ? await op.wait(() => sealer.seal(update, kind === KIND_SEGMENT ? "segment" : "snapshot")) : update;
		op.check();
		const data = await op.wait(() => encodeFile(kind, body, sealer !== null));
		op.check();
		const now = this.opts.now();
		const name = nameOverride ?? (kind === KIND_SEGMENT
			? segmentName(now, this.opts.deviceId, this.counter++)
			: snapshotName(now, this.opts.deviceId, this.counter++));
		const info = await op.wait(() => this.api.createFile(folderId, name, data));
		op.check();
		if (info.size !== data.length) {
			// Drive reported a different size than we sent: do not trust this upload.
			await op.wait(() => this.api.deleteFile(info.id).catch(() => undefined));
			op.check();
			throw new DriveError(502, `Upload of ${name} was stored with a different size (${info.size} != ${data.length})`);
		}
		this.setKnown(name, {
			id: info.id,
			size: info.size,
			created: info.createdTime,
			uploadedAt: now,
			kind: kind === KIND_SEGMENT ? "segment" : "snapshot",
			state: "applied",
		}, update);
		this.mergeRemote(update);
		this.enforcePayloadBound();
		this.storedGeneration++;
		this.emitReceipt();
		return info;
	}

	/**
	 * Tell the engine what Drive holds, in the same message the Cloudflare
	 * server uses for "saved on server", so the existing status bar and
	 * receipt tracking read "saved to Drive" without any change. Only sent
	 * while the picture of Drive is trustworthy (no file just vanished).
	 */
	private emitReceipt(): void {
		if (!this.started || this.destroyed || this.remoteDirty || !this.isComplete()) return;
		try {
			// An empty Drive still gets a receipt: it gives the tracker its
			// starting point (generation 0) before any edit is uploaded.
			const known = this.remoteState ?? Y.encodeStateAsUpdate(new Y.Doc());
			const message = JSON.parse(makeSvEchoMessage(Y.encodeStateVectorFromUpdate(known))) as Record<string, unknown>;
			// The "stored since you looked" counter is only honest when nothing
			// is waiting to be uploaded; otherwise an earlier upload finishing
			// could be mistaken for the newest edit being safe. Without the
			// counter the receipt falls back to comparing state vectors, which
			// is exact for anything that adds data. (Before this session has
			// stored anything the counter is only a starting point, so it is
			// always safe to send.)
			if (this.pending.length === 0 || this.storedGeneration === 0) {
				message.gen = this.storedGeneration;
				message.genEpoch = this.receiptEpoch;
			}
			this.emit("custom-message", [JSON.stringify(message)]);
		} catch (err) {
			this.opts.log(`Could not build a receipt: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** Remember a file, keeping the payload account (F7) straight. */
	private setKnown(name: string, file: KnownFile, payload?: Uint8Array): void {
		const previous = this.known.get(name);
		if (previous?.payload) this.retainedBytes -= previous.payload.length;
		if (payload !== undefined) {
			file.payload = payload;
			this.retainedBytes += payload.length;
		}
		this.known.set(name, file);
	}

	/** Forget a file and its payload. */
	private forget(name: string): void {
		const previous = this.known.get(name);
		if (previous?.payload) this.retainedBytes -= previous.payload.length;
		this.known.delete(name);
	}

	/**
	 * F7: drop payloads that a later applied file already covers. A snapshot holds
	 * the whole document at the moment it was written, so every file whose state
	 * it contains is no longer needed to rebuild what Drive holds.
	 */
	private dropCoveredPayloads(exceptName: string): void {
		const cover = this.known.get(exceptName);
		if (!cover?.payload) return;
		const coverSv = (cover.sv ??= Y.encodeStateVectorFromUpdate(cover.payload));
		for (const [name, file] of this.known.entries()) {
			if (name === exceptName || !file.payload) continue;
			const sv = (file.sv ??= Y.encodeStateVectorFromUpdate(file.payload));
			if (!stateVectorCovers(coverSv, sv)) continue;
			this.retainedBytes -= file.payload.length;
			delete file.payload;
			delete file.sv;
		}
	}

	/** F7: the hard bound. Oldest by Drive's creation time goes first. */
	private enforcePayloadBound(): void {
		const cap = this.opts.maxRetainedPayloadBytes;
		if (this.retainedBytes <= cap) return;
		const order = Array.from(this.known.entries())
			.filter(([, f]) => f.payload !== undefined)
			.sort((a, b) => ((a[1].created ?? 0) - (b[1].created ?? 0)) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
		for (const [, file] of order) {
			if (this.retainedBytes <= cap) break;
			if (!file.payload) continue;
			this.retainedBytes -= file.payload.length;
			delete file.payload;
			delete file.sv;
		}
	}

	/**
	 * Recompute what Drive holds. Payloads still in memory are merged; payloads
	 * F7 dropped are read back from Drive (only files the last listing showed are
	 * asked for, so this is bounded by one listing). A file that is gone or
	 * unreadable contributes nothing, exactly as before.
	 */
	private async rebuildRemoteIfDirty(op: DriveOperation): Promise<void> {
		if (!this.remoteDirty) return;
		const parts: Uint8Array[] = [];
		for (const [name, file] of Array.from(this.known.entries())) {
			if (file.state !== "applied") continue;
			if (file.payload) {
				parts.push(file.payload);
				continue;
			}
			const info: DriveFileInfo = { id: file.id, name, size: file.size, createdTime: file.created ?? 0 };
			const result = await this.download(info, op);
			op.check();
			if (result.state === "ok") {
				this.setKnown(name, { ...file, kind: result.kind === KIND_SEGMENT ? "segment" : "snapshot", state: "applied" }, result.payload);
				parts.push(result.payload);
			} else {
				this.opts.log(`drive carrier: ${name} could not be read back for the rebuild (${result.state})`);
			}
		}
		this.remoteState = parts.length > 0 ? Y.mergeUpdates(parts) : null;
		this.remoteDirty = false;
		this.enforcePayloadBound();
	}

	private mergeRemote(update: Uint8Array): void {
		this.remoteState = this.remoteState ? Y.mergeUpdates([this.remoteState, update]) : update;
	}

	// ---------------------------------------------------------------------
	// Receiving
	// ---------------------------------------------------------------------

	private async pollLocked(op: DriveOperation): Promise<void> {
		const folderId = this.folderId;
		if (folderId === null) throw new DriveError(500, "No vault folder");
		const listing = await op.wait(() => this.api.listFiles(folderId));
		op.check();

		const present = new Set<string>();
		const fresh: { name: string; info: DriveFileInfo; kind: "segment" | "snapshot" }[] = [];
		for (const info of listing) {
			const kind = classifyName(info.name);
			if (kind !== "segment" && kind !== "snapshot") continue;
			present.add(info.name);
			if (!this.known.has(info.name) || this.known.get(info.name)?.state !== "applied") fresh.push({ name: info.name, info, kind });
		}
		fresh.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		this.pollSawGone = false;
		for (let i = 0; i < fresh.length; i += DOWNLOAD_PARALLELISM) {
			const group = fresh.slice(i, i + DOWNLOAD_PARALLELISM);
			const downloaded = await op.wait(() => Promise.all(group.map((f) => this.download(f.info, op))));
			op.check();
			// Apply in name order so progress is deterministic.
			group.forEach((f, idx) => {
				const result = downloaded[idx];
				if (!result) return;
				this.applyDownloaded(f.name, f.info, f.kind, result, op);
			});
		}

		// Forget files that left Drive (compaction by any device, or the user). Only after the new
		// files above were applied, so a snapshot that replaces them is already in.
		for (const [name, file] of Array.from(this.known.entries())) {
			if (present.has(name)) continue;
			// A listing can lag behind an upload. Keep our own fresh uploads for a short
			// grace period instead of concluding they vanished (which would re-upload them).
			if (file.uploadedAt !== undefined && this.opts.now() - file.uploadedAt < this.opts.listingGraceMs) continue;
			this.forget(name);
			if (file.state === "applied") this.remoteDirty = true;
		}
	}

	private async download(info: DriveFileInfo, op: DriveOperation): Promise<{ state: "ok"; payload: Uint8Array; kind: FileKind } | { state: "gone" } | { state: "corrupt"; reason: string }> {
		let bytes: Uint8Array;
		try {
			bytes = await op.wait(() => this.api.readFile(info.id));
			op.check();
		} catch (err) {
			op.check();
			if (err instanceof DriveError && err.notFound) return { state: "gone" };
			throw err;
		}
		try {
			const decoded = await op.wait(() => decodeFile(bytes));
			op.check();
			const sealer = this.keyring.sealer;
			if (decoded.encrypted !== (sealer !== null)) {
				return { state: "corrupt", reason: decoded.encrypted ? "encrypted file in an unencrypted vault" : "unencrypted file in an encrypted vault" };
			}
			if (!sealer) return { state: "ok", payload: decoded.payload, kind: decoded.kind };
			const plain = await op.wait(() => sealer.open(decoded.payload, decoded.kind === KIND_SEGMENT ? "segment" : "snapshot"));
			op.check();
			return { state: "ok", payload: plain, kind: decoded.kind };
		} catch (err) {
			if (err instanceof CorruptFileError || err instanceof EncryptionError) return { state: "corrupt", reason: err.message };
			throw err;
		}
	}

	private applyDownloaded(
		name: string,
		info: DriveFileInfo,
		nameKind: "segment" | "snapshot",
		result: { state: "ok"; payload: Uint8Array; kind: FileKind } | { state: "gone" } | { state: "corrupt"; reason: string },
		op: DriveOperation,
	): void {
		op.check();
		if (result.state === "gone") {
			// Compacted away between listing and reading; a snapshot covers it.
			this.setKnown(name, { id: info.id, size: info.size, kind: nameKind, state: "gone" });
			this.pollSawGone = true;
			return;
		}
		if (result.state === "corrupt") {
			this.opts.log(`drive carrier: skipping damaged file ${name}: ${result.reason}`);
			this.setKnown(name, { id: info.id, size: info.size, kind: nameKind, state: "corrupt" });
			return;
		}
		const expected = nameKind === "segment" ? KIND_SEGMENT : KIND_SNAPSHOT;
		if (result.kind !== expected) {
			this.opts.log(`drive carrier: skipping ${name}: kind does not match its name`);
			this.setKnown(name, { id: info.id, size: info.size, kind: nameKind, state: "corrupt" });
			return;
		}
		try {
			Y.applyUpdate(this.doc, result.payload, this);
		} catch (err) {
			this.opts.log(`drive carrier: skipping ${name}: update could not be applied (${err instanceof Error ? err.message : String(err)})`);
			this.setKnown(name, { id: info.id, size: info.size, kind: nameKind, state: "corrupt" });
			return;
		}
		op.check();
		this.lastActivityAt = this.opts.now();
		try {
			this.mergeRemote(result.payload);
		} catch {
			// The update applied but could not be merged into the cache; reconcile will cover it.
		}
		this.setKnown(name, { id: info.id, size: info.size, created: info.createdTime, kind: nameKind, state: "applied" }, result.payload);
		// F7: a snapshot covers everything written before it, so those payloads are
		// no longer needed to rebuild what Drive holds.
		if (nameKind === "snapshot") this.dropCoveredPayloads(name);
		this.enforcePayloadBound();
	}

	// ---------------------------------------------------------------------
	// Repair: make sure Drive holds everything this device holds
	// ---------------------------------------------------------------------

	private async maybeReconcileLocked(op: DriveOperation): Promise<void> {
		const every = this.opts.reconcileIntervalMs;
		if (every <= 0) return;
		if (this.opts.now() - this.lastReconcileAt < every) return;
		await this.reconcileLocked(op);
		op.check();
	}

	private async reconcileLocked(op: DriveOperation): Promise<void> {
		if (this.folderId === null) await this.prepareFolder(op);
		op.check();
		await this.flushLocked(op);
		op.check();
		// Repair is an additive upload of locally held state, never deletion of
		// unreadable remote files. Keep it available even while completeness is blocked.
		if (this.pollSawGone) return;
		this.lastReconcileAt = this.opts.now();
		await this.rebuildRemoteIfDirty(op);
		op.check();
		const remote = new Y.Doc();
		try {
			if (this.remoteState) Y.applyUpdate(remote, this.remoteState);
			if (Y.equalSnapshots(Y.snapshot(this.doc), Y.snapshot(remote))) return;
			const missing = Y.encodeStateAsUpdate(this.doc, Y.encodeStateVector(remote));
			this.opts.log("drive carrier: Drive lacks local state, uploading the difference");
			await this.uploadUpdate(KIND_SEGMENT, missing, op);
			op.check();
		} finally {
			remote.destroy();
		}
	}

	// ---------------------------------------------------------------------
	// Compaction
	// ---------------------------------------------------------------------

	private async maybeCompactLocked(op: DriveOperation): Promise<void> {
		if (!this.isComplete()) return;
		let count = 0;
		let bytes = 0;
		for (const f of this.known.values()) {
			if (f.kind === "segment" && f.state === "applied") {
				count++;
				bytes += f.size;
			}
		}
		// F1: the file count is the cap in both modes. 2.1.22 ("legacy") also let
		// the byte total bring compaction forward; adaptively the byte total is the
		// floor that decides whether a snapshot is worth writing at all.
		const bytesTrigger = this.opts.compaction === "legacy" && bytes > this.opts.compactSegmentBytes;
		if (count <= this.opts.compactSegmentCount && !bytesTrigger) return;
		if (this.opts.now() - this.lastCompactAt < MIN_COMPACT_GAP_MS) return;
		this.lastCompactAt = this.opts.now();
		await this.compactLocked(op);
		op.check();
	}

	/**
	 * Replace the segments that have piled up with fewer files. Only files this
	 * device has applied are ever deleted, and only once their replacement has
	 * been read back and checked (F6). If another device compacts at the same
	 * moment both replacements are valid and the extra deletes are harmless.
	 */
	private async compactLocked(op: DriveOperation): Promise<void> {
		const covered: [string, KnownFile][] = [];
		let liveBytes = 0;
		for (const entry of this.known.entries()) {
			if (entry[1].kind === "segment" && entry[1].state === "applied") {
				covered.push(entry);
				liveBytes += entry[1].size;
			}
		}
		if (covered.length < 2) return;
		covered.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
		// The state vector is taken before the encode so it is always a subset of
		// what the snapshot holds, however the user keeps editing while this runs.
		const vector = Y.encodeStateVector(this.doc);
		const raw = Y.encodeStateAsUpdate(this.doc);
		if (this.opts.compaction === "legacy") {
			await this.snapshotLocked(raw, vector, covered, op);
			return;
		}
		// F1 tier B: write a full snapshot only when it is really smaller than the
		// change files it would replace (and not larger than the ceiling).
		const worthIt = liveBytes >= this.opts.compactSegmentBytes
			&& raw.length <= Math.floor(SNAPSHOT_WORTH_RATIO * liveBytes)
			&& raw.length <= this.opts.snapshotMaxBytes;
		if (worthIt) {
			await this.snapshotLocked(raw, vector, covered, op);
			return;
		}
		await this.mergeSegmentsLocked(covered, liveBytes, op);
	}

	/**
	 * F1 tier A: merge change files into one. The bytes written are about the sum
	 * of the inputs, not the size of the document, so this is the cheap tier.
	 *
	 * The *smallest* files are merged, and at least a quarter of them, so the
	 * bytes written per trigger are paid back by the files it removes. A file
	 * that is already large stays out of the way: folding it in would write the
	 * same bytes again for nothing, and doing that every trigger would make the
	 * cost grow with everything ever stored. Files whose payload F7 dropped are
	 * read back first; a file that cannot be read is left in place, so nothing is
	 * ever lost to a merge.
	 */
	private async mergeSegmentsLocked(covered: [string, KnownFile][], liveBytes: number, op: DriveOperation): Promise<void> {
		const excess = covered.length - this.opts.compactSegmentCount;
		const take = Math.max(2, Math.ceil(covered.length / 4), excess + 1);
		const chosen = covered
			.slice()
			.sort((a, b) => (a[1].size - b[1].size) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
			.slice(0, take);
		const parts: Uint8Array[] = [];
		const ready: [string, KnownFile][] = [];
		for (const [name, file] of chosen) {
			let payload = file.payload;
			if (!payload) {
				const result = await this.download({ id: file.id, name, size: file.size, createdTime: file.created ?? 0 }, op);
				op.check();
				if (result.state !== "ok" || result.kind !== KIND_SEGMENT) {
					this.opts.log(`drive carrier: not merging ${name}: ${result.state === "ok" ? "it is not a change file" : result.state}`);
					continue;
				}
				payload = result.payload;
				this.setKnown(name, { ...file, state: "applied" }, payload);
			}
			parts.push(payload);
			ready.push([name, file]);
		}
		if (ready.length < 2) return;
		// Merge in chunks of 50, so one very full folder cannot allocate everything at once.
		let merged = parts[0] as Uint8Array;
		for (let i = 1; i < parts.length; i += 50) {
			merged = Y.mergeUpdates([merged, ...parts.slice(i, i + 50)]);
		}
		// The merged file carries the newest stamp of its inputs, so reading files
		// in name order still ends with the file that holds all of their content.
		const stamp = ready.reduce((newest, [name]) => Math.max(newest, DriveTransport.stampOf(name)), 0);
		const written = await this.uploadUpdate(KIND_SEGMENT, merged, op, segmentName(stamp, this.opts.deviceId, this.counter++));
		op.check();
		if (this.opts.verifyBeforePrune) {
			const verdict = await this.verifyReplacement(written, merged, op);
			op.check();
			if (verdict !== true) {
				const detail = typeof verdict === "string" ? verdict : "the merged file did not read back";
				this.opts.log(`drive carrier: keeping every change file because ${detail}`);
				this.reportNotice(
					"merge-verify-failed",
					`YAOS: a merged sync file could not be read back from Google Drive (${detail}), so no older sync file was removed. Sync keeps working; the plugin will try again.`,
				);
				return;
			}
		}
		this.opts.log(`drive carrier: merged ${ready.length} change file(s) (${liveBytes} bytes live) into one`);
		for (const [name, file] of ready) {
			const deleted = await this.deleteQuiet(file.id, op);
			op.check();
			if (deleted) this.forget(name);
		}
		await this.finishCompaction(op);
	}

	/** Tier B (and every compaction in "legacy"): replace the covered segments with a full snapshot. */
	private async snapshotLocked(raw: Uint8Array, vector: Uint8Array, covered: [string, KnownFile][], op: DriveOperation): Promise<void> {
		// `vector` says exactly which document the snapshot must hold; it is
		// compared after the read back, so it stays right when the user keeps
		// editing while the upload and readback run.
		const written = await this.uploadUpdate(KIND_SNAPSHOT, raw, op);
		op.check();
		if (this.opts.verifyBeforePrune) {
			const verdict = await this.verifySnapshot(written, vector, op);
			op.check();
			if (verdict !== true) {
				// Nothing is deleted on an unproven snapshot: the segments stay, and
				// the next compaction cycle (bounded by MIN_COMPACT_GAP_MS) tries again.
				const detail = typeof verdict === "string" ? verdict : "the snapshot did not read back";
				this.opts.log(`drive carrier: keeping every segment because ${detail}`);
				this.reportNotice(
					"snapshot-verify-failed",
					`YAOS: a full restore point could not be read back from Google Drive (${detail}), so no older sync files were removed. Sync keeps working; the plugin will try again.`,
				);
				return;
			}
		}
		for (const [name, file] of covered) {
			const deleted = await this.deleteQuiet(file.id, op);
			op.check();
			if (deleted) this.forget(name);
		}
		// Keep the newest snapshots by Drive's own creation time. A device name carries
		// the creator's clock, and a clock running ahead used to outrank every later
		// snapshot, so the one just written could be the one deleted.
		const snaps = Array.from(this.known.entries())
			.filter(([, f]) => f.kind === "snapshot" && f.state === "applied" && f.id !== written.id)
			.sort((a, b) => ((a[1].created ?? 0) - (b[1].created ?? 0)) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
		// The snapshot just written always stays; keep the newest of the others beside it.
		const keepOthers = Math.max(0, this.opts.keepSnapshots - 1);
		for (const [name, file] of snaps.slice(0, Math.max(0, snaps.length - keepOthers))) {
			const deleted = await this.deleteQuiet(file.id, op);
			op.check();
			if (deleted) this.forget(name);
		}
		await this.finishCompaction(op);
	}

	/** After a compaction deleted files: the picture of Drive must be rebuilt from what remains. */
	private async finishCompaction(op: DriveOperation): Promise<void> {
		// Files left Drive by this device's own hand, or the repair pass and the
		// "saved" receipt would read stale data.
		this.remoteDirty = true;
		await this.rebuildRemoteIfDirty(op);
		op.check();
	}

	/** The timestamp inside `seg-<13 digits>-…`, 0 when the name is not a segment name. */
	private static stampOf(name: string): number {
		const match = /^seg-(\d{13})-/.exec(name);
		return match ? Number(match[1]) : 0;
	}

	/**
	 * F1/F6: read a merged change file back and compare it byte for byte with
	 * what was sent, before the files it replaces are deleted.
	 */
	private async verifyReplacement(file: DriveFileInfo, expected: Uint8Array, op: DriveOperation): Promise<true | string> {
		let result: Awaited<ReturnType<DriveTransport["download"]>>;
		try {
			result = await this.download(file, op);
		} catch (err) {
			op.check();
			return `the merged file could not be read back (${err instanceof Error ? err.message : String(err)})`;
		}
		if (result.state !== "ok") return result.state === "corrupt" ? `the merged file reads back damaged (${result.reason})` : "the merged file is no longer on Drive";
		if (!sameBytes(result.payload, expected)) return "the merged file does not hold what was written";
		return true;
	}

	/**
	 * F6: read the snapshot just written and prove it holds the document state
	 * that was encoded, before any segment it covers is deleted. Returns true
	 * when the snapshot is proven, or the reason as a string when it is not.
	 */
	private async verifySnapshot(file: DriveFileInfo, vector: Uint8Array, op: DriveOperation): Promise<true | string> {
		let result: Awaited<ReturnType<DriveTransport["download"]>>;
		try {
			result = await this.download(file, op);
		} catch (err) {
			// A failed read is no proof either: keep the segments and try again later.
			op.check();
			return `the snapshot could not be read back (${err instanceof Error ? err.message : String(err)})`;
		}
		op.check();
		if (result.state !== "ok") return result.state === "corrupt" ? `the snapshot reads back damaged (${result.reason})` : "the snapshot is no longer on Drive";
		if (result.kind !== KIND_SNAPSHOT) return "the file is not a snapshot";
		const probe = new Y.Doc();
		try {
			Y.applyUpdate(probe, result.payload, this);
			if (!sameBytes(Y.encodeStateVector(probe), vector)) return "the snapshot does not hold the document that was encoded";
			return true;
		} catch (err) {
			return `the snapshot could not be applied (${err instanceof Error ? err.message : String(err)})`;
		} finally {
			probe.destroy();
		}
	}

	private async deleteQuiet(id: string, op: DriveOperation): Promise<boolean> {
		try {
			await op.wait(() => this.api.deleteFile(id));
			op.check();
			return true;
		} catch (err) {
			op.check();
			if (err instanceof DriveError && err.notFound) return true;
			this.opts.log(`drive carrier: could not delete an old file: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}
}

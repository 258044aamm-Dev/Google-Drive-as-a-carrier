import * as Y from "yjs";
import { ObservableV2 } from "lib0/observable";
import {
	Awareness,
	applyAwarenessUpdate,
	encodeAwarenessUpdate,
	removeAwarenessStates,
} from "y-protocols/awareness";
import type { SyncTransport } from "../sync/transport";
import { encodeBytesBase64, decodeBytesBase64, makeSvEchoMessage } from "../sync/svEchoMessage";
import { LAN_ACK_DELAY_MS } from "./lanConstants";
import { LanLink, type LanHub } from "./lanHub";
import {
	BIN_AWARENESS,
	BIN_BLOB_DATA,
	BIN_BLOB_PUT,
	BIN_SYNC,
	SYNC_STEP1,
	SYNC_STEP2,
	SYNC_UPDATE,
	binaryMessage,
	blobDataMessage,
	blobPutMessage,
	decodeSyncFrame,
	encodeSyncFrame,
	parseBlobData,
	parseBlobPut,
	splitBinary,
	type LanTextMessage,
} from "./lanProtocol";

/** What the attachment store plugs into the transport (see lanBlobStore.ts). */
export interface LanBlobHost {
	/** Another device asks for an attachment. Resolve with its bytes, or null when this device does not have it. */
	serve(hash: string): Promise<Uint8Array | null>;
	/** Another device sent an attachment on its own. The host must check the hash before keeping it. */
	receive(hash: string, bytes: Uint8Array): Promise<void>;
	/** Which of these attachments this device has. */
	has(hashes: string[]): Promise<string[]>;
}

export interface LanHubHooks {
	onLinkReady: (link: LanLink) => void;
	onStatusChanged: () => void;
}

export interface LanTransportOptions {
	createHub: (hooks: LanHubHooks) => LanHub;
	/** Origins whose Y.Doc updates are NOT local edits (e.g. the IndexedDB persistence). */
	ignoreOrigin?: (origin: unknown) => boolean;
	/** Called once per start when the link server cannot start (no key, port in use). */
	onProblem?: (message: string) => void;
	ackDelayMs?: number;
	/** Pause before asking again for updates that could not be applied. */
	resyncDelayMs?: number;
	log?: (message: string) => void;
}

interface TransportEvents {
	status: (event: { status: string }) => void;
	sync: (synced: boolean) => void;
	"custom-message": (payload: string) => void;
	message: (event: MessageEvent) => void;
	/** The set of linked devices changed. */
	peers: () => void;
}

interface PeerState {
	link: LanLink;
	/** This device has received the other's answer to its state-vector request. */
	synced: boolean;
	/** The answer to our state-vector request has arrived (it may still be incomplete). */
	gotStep2: boolean;
	resyncTimer: number | null;
	/** Presence clients that came from this link, so they can be removed when it closes. */
	awarenessClients: Set<number>;
	ackTimer: number | null;
}

interface PendingBlobRequest {
	resolve: (bytes: Uint8Array | null) => void;
	remaining: number;
	timer: number;
}

export interface LanPeerSummary {
	deviceId: string;
	deviceName: string;
	address: string;
	synced: boolean;
}

/**
 * Carries a vault's Y.Doc between devices over secure links on the local network.
 *
 * There is no server: every device keeps the whole document, and any two linked
 * devices exchange what the other lacks (Yjs sync step 1 and 2), then stream
 * their edits. Yjs updates commute and are idempotent, so duplicates, reordering
 * and relaying through a third device are harmless. A device relays what it
 * receives to its other links only when it actually changed its document, so
 * links that form a loop settle.
 *
 * Remote updates are applied with `this` as the Y.Doc origin, as SyncTransport
 * requires.
 */
export class LanTransport extends ObservableV2<TransportEvents> implements SyncTransport {
	readonly awareness: Awareness;
	wsconnected = false;
	wsconnecting = false;
	private _synced = false;

	/** Last problem seen, for diagnostics and the settings screen. */
	lastError: string | null = null;

	readonly hub: LanHub;
	private readonly peers = new Map<LanLink, PeerState>();
	private blobHost: LanBlobHost | null = null;
	private readonly blobRequests = new Map<number, PendingBlobRequest>();
	private readonly hasRequests = new Map<number, { resolve: (hashes: string[]) => void; timer: number }>();
	private nextRequestId = 1;
	private peerWaiters = new Set<() => void>();
	private started = false;
	private destroyed = false;
	/** The link whose data is being applied right now (so it is not echoed back to it). */
	private applyingFrom: LanLink | null = null;

	private readonly options: LanTransportOptions;
	private readonly ignoreOrigin: (origin: unknown) => boolean;
	private readonly ackDelayMs: number;
	private readonly resyncDelayMs: number;
	private readonly log: (message: string) => void;

	private readonly onDocUpdate = (update: Uint8Array, origin: unknown): void => {
		if (origin === this) {
			// Data that arrived from a device: pass it on to the others, never back.
			this.broadcastSync(SYNC_UPDATE, update, this.applyingFrom);
			return;
		}
		if (this.ignoreOrigin(origin)) return;
		this.broadcastSync(SYNC_UPDATE, update, null);
	};

	private readonly onAwarenessUpdate = (
		changes: { added: number[]; updated: number[]; removed: number[] },
		origin: unknown,
	): void => {
		const clients = [...changes.added, ...changes.updated, ...changes.removed];
		const from = origin instanceof LanLink ? origin : null;
		if (from) {
			const peer = this.peers.get(from);
			if (peer) {
				for (const id of changes.added) peer.awarenessClients.add(id);
				for (const id of changes.removed) peer.awarenessClients.delete(id);
			}
		}
		if (origin === this) return;
		// Presence from one device is passed on to the others (not back).
		if (clients.length === 0) return;
		const payload = binaryMessage(BIN_AWARENESS, encodeAwarenessUpdate(this.awareness, clients));
		for (const peer of this.peers.values()) {
			if (peer.link !== from) peer.link.sendBinary(payload);
		}
	};

	constructor(
		private readonly doc: Y.Doc,
		options: LanTransportOptions,
	) {
		super();
		this.ignoreOrigin = options.ignoreOrigin ?? (() => false);
		this.ackDelayMs = options.ackDelayMs ?? LAN_ACK_DELAY_MS;
		this.resyncDelayMs = options.resyncDelayMs ?? 3000;
		this.log = options.log ?? (() => undefined);
		this.options = options;
		this.awareness = new Awareness(doc);
		doc.on("update", this.onDocUpdate);
		this.awareness.on("update", this.onAwarenessUpdate);
		this.hub = options.createHub({
			onLinkReady: (link) => this.onLinkReady(link),
			onStatusChanged: () => this.emit("peers", []),
		});
	}

	get synced(): boolean {
		return this._synced;
	}

	/** The devices this one is linked with right now. */
	peerSummaries(): LanPeerSummary[] {
		return Array.from(this.peers.values()).map((p) => ({
			deviceId: p.link.deviceId,
			deviceName: p.link.deviceName,
			address: p.link.address,
			synced: p.synced,
		}));
	}

	// ---------------------------------------------------------------------
	// SyncTransport
	// ---------------------------------------------------------------------

	async connect(): Promise<void> {
		if (this.destroyed || this.started) return;
		this.started = true;
		this.wsconnecting = true;
		this.emit("status", [{ status: "connecting" }]);
		try {
			await this.hub.start();
		} catch (err) {
			this.lastError = err instanceof Error ? err.message : String(err);
			this.log(`lan carrier: ${this.lastError}`);
		}
		this.wsconnecting = false;
		const problem = this.hub.status().error;
		if (problem) {
			this.lastError = problem;
			this.options.onProblem?.(problem);
		}
		// Linked devices make the carrier "connected"; until one appears it is waiting.
		if (this.peers.size === 0) this.emit("status", [{ status: "disconnected" }]);
	}

	disconnect(): void {
		this.started = false;
		this.hub.stop();
		for (const peer of Array.from(this.peers.values())) this.dropPeer(peer.link);
		this.updateConnectionState();
	}

	destroy(): void {
		if (this.destroyed) return;
		this.disconnect();
		this.destroyed = true;
		this.doc.off("update", this.onDocUpdate);
		this.awareness.off("update", this.onAwarenessUpdate);
		this.awareness.destroy();
		for (const [, pending] of this.blobRequests) {
			window.clearTimeout(pending.timer);
			pending.resolve(null);
		}
		this.blobRequests.clear();
		for (const [, pending] of this.hasRequests) {
			window.clearTimeout(pending.timer);
			pending.resolve([]);
		}
		this.hasRequests.clear();
		super.destroy();
	}

	// ---------------------------------------------------------------------
	// Links
	// ---------------------------------------------------------------------

	private onLinkReady(link: LanLink): void {
		if (this.destroyed || !this.started) {
			link.close("stopped");
			return;
		}
		const peer: PeerState = { link, synced: false, gotStep2: false, resyncTimer: null, awarenessClients: new Set(), ackTimer: null };
		this.peers.set(link, peer);
		link.setHandlers({
			onText: (message) => this.onText(peer, message),
			onBinary: (data) => this.onBinary(peer, data),
			onClose: () => this.dropPeer(link),
		});
		this.updateConnectionState();
		// Ask for what the other has, and tell it who is here.
		this.sendSync(link, SYNC_STEP1, Y.encodeStateVector(this.doc));
		const clients = Array.from(this.awareness.getStates().keys());
		if (clients.length > 0) link.sendBinary(binaryMessage(BIN_AWARENESS, encodeAwarenessUpdate(this.awareness, clients)));
		for (const waiter of Array.from(this.peerWaiters)) waiter();
		this.emit("peers", []);
	}

	private dropPeer(link: LanLink): void {
		const peer = this.peers.get(link);
		if (!peer) return;
		this.peers.delete(link);
		if (peer.ackTimer !== null) window.clearTimeout(peer.ackTimer);
		if (peer.resyncTimer !== null) window.clearTimeout(peer.resyncTimer);
		if (peer.awarenessClients.size > 0) {
			removeAwarenessStates(this.awareness, Array.from(peer.awarenessClients), link);
		}
		if (!link.isClosed) link.close("dropped");
		this.updateConnectionState();
		this.emit("peers", []);
	}

	private updateConnectionState(): void {
		const linked = this.peers.size > 0;
		const anySynced = Array.from(this.peers.values()).some((p) => p.synced);
		const wasConnected = this.wsconnected;
		this.wsconnected = linked && this.started;
		if (this.wsconnected && !wasConnected) this.emit("status", [{ status: "connected" }]);
		if (!this.wsconnected && wasConnected) this.emit("status", [{ status: "disconnected" }]);
		if (anySynced !== this._synced) {
			this._synced = anySynced;
			this.emit("sync", [anySynced]);
		}
	}

	// ---------------------------------------------------------------------
	// Messages
	// ---------------------------------------------------------------------

	private sendSync(link: LanLink, type: number, payload: Uint8Array): void {
		link.sendBinary(binaryMessage(BIN_SYNC, encodeSyncFrame(type, payload)));
	}

	private broadcastSync(type: number, payload: Uint8Array, except: LanLink | null): void {
		if (this.peers.size === 0) return;
		const message = binaryMessage(BIN_SYNC, encodeSyncFrame(type, payload));
		for (const peer of this.peers.values()) {
			if (peer.link !== except) peer.link.sendBinary(message);
		}
	}

	private onBinary(peer: PeerState, data: Uint8Array): void {
		const split = splitBinary(data);
		if (!split) return;
		switch (split.kind) {
			case BIN_SYNC:
				this.onSyncFrame(peer, split.payload);
				break;
			case BIN_AWARENESS:
				try {
					applyAwarenessUpdate(this.awareness, split.payload, peer.link);
				} catch (err) {
					this.log(`lan carrier: bad presence data from ${peer.link.deviceName}: ${String(err)}`);
				}
				break;
			case BIN_BLOB_DATA: {
				const parsed = parseBlobData(split.payload);
				const pending = parsed ? this.blobRequests.get(parsed.id) : undefined;
				if (parsed && pending) this.settleBlobRequest(parsed.id, pending, parsed.bytes);
				break;
			}
			case BIN_BLOB_PUT: {
				const parsed = parseBlobPut(split.payload);
				if (parsed && this.blobHost) void this.blobHost.receive(parsed.hash, parsed.bytes).catch(() => undefined);
				break;
			}
			default:
				break;
		}
	}

	private onSyncFrame(peer: PeerState, frame: Uint8Array): void {
		const decoded = decodeSyncFrame(frame);
		if (!decoded) {
			peer.link.close("unreadable sync data");
			return;
		}
		try {
			if (decoded.type === SYNC_STEP1) {
				this.sendSync(peer.link, SYNC_STEP2, Y.encodeStateAsUpdate(this.doc, decoded.payload));
				return;
			}
			if (decoded.type === SYNC_STEP2 || decoded.type === SYNC_UPDATE) {
				this.applyingFrom = peer.link;
				try {
					Y.applyUpdate(this.doc, decoded.payload, this);
				} finally {
					this.applyingFrom = null;
				}
				if (decoded.type === SYNC_STEP2) peer.gotStep2 = true;
				if (peer.gotStep2 && !peer.synced) this.checkComplete(peer);
				this.scheduleAck(peer);
			}
		} catch (err) {
			this.lastError = `bad sync data from ${peer.link.deviceName}: ${err instanceof Error ? err.message : String(err)}`;
			this.log(`lan carrier: ${this.lastError}`);
			peer.link.close("bad sync data");
		}
	}

	/**
	 * The engine takes "synced" as "I hold everything this device holds". Do not say it while an
	 * update that depends on a missing one is still waiting. Missing data is asked for again after
	 * a pause (never in a tight loop), and later updates may complete it on their own.
	 */
	private checkComplete(peer: PeerState): void {
		if (this.doc.store.pendingStructs === null && this.doc.store.pendingDs === null) {
			peer.synced = true;
			if (peer.resyncTimer !== null) window.clearTimeout(peer.resyncTimer);
			peer.resyncTimer = null;
			this.updateConnectionState();
			return;
		}
		this.lastError = "Some updates from another device are missing or cannot be applied yet";
		if (peer.resyncTimer !== null) return;
		this.log("lan carrier: linked, but some updates are missing; not reporting synced yet");
		peer.resyncTimer = window.setTimeout(() => {
			peer.resyncTimer = null;
			if (peer.link.isClosed || !this.peers.has(peer.link) || peer.synced) return;
			this.sendSync(peer.link, SYNC_STEP1, Y.encodeStateVector(this.doc));
		}, this.resyncDelayMs);
	}

	private scheduleAck(peer: PeerState): void {
		if (peer.ackTimer !== null) return;
		peer.ackTimer = window.setTimeout(() => {
			peer.ackTimer = null;
			if (peer.link.isClosed || !this.peers.has(peer.link)) return;
			peer.link.sendText({ t: "ack", sv: encodeBytesBase64(Y.encodeStateVector(this.doc)) });
		}, this.ackDelayMs);
	}

	private onText(peer: PeerState, message: LanTextMessage): void {
		switch (message.t) {
			case "ack": {
				// "Another device holds at least this" is what the Cloudflare server's receipt means for the engine.
				const sv = decodeBytesBase64(message.sv);
				if (!sv) return;
				try {
					Y.decodeStateVector(sv);
					this.emit("custom-message", [makeSvEchoMessage(sv)]);
				} catch {
					// ignore a malformed receipt
				}
				return;
			}
			case "blob-want": {
				const host = this.blobHost;
				if (!host) {
					peer.link.sendText({ t: "blob-miss", id: message.id });
					return;
				}
				void host.serve(message.hash).then((bytes) => {
					if (peer.link.isClosed) return;
					if (bytes) peer.link.sendBinary(blobDataMessage(message.id, bytes));
					else peer.link.sendText({ t: "blob-miss", id: message.id });
				}, () => {
					if (!peer.link.isClosed) peer.link.sendText({ t: "blob-miss", id: message.id });
				});
				return;
			}
			case "blob-miss": {
				const pending = this.blobRequests.get(message.id);
				if (!pending) return;
				pending.remaining--;
				if (pending.remaining <= 0) this.settleBlobRequest(message.id, pending, null);
				return;
			}
			case "blob-has": {
				const host = this.blobHost;
				if (!host) {
					peer.link.sendText({ t: "blob-has-reply", id: message.id, hashes: [] });
					return;
				}
				void host.has(message.hashes).then((hashes) => {
					if (!peer.link.isClosed) peer.link.sendText({ t: "blob-has-reply", id: message.id, hashes });
				}, () => undefined);
				return;
			}
			case "blob-has-reply": {
				const pending = this.hasRequests.get(message.id);
				if (!pending) return;
				window.clearTimeout(pending.timer);
				this.hasRequests.delete(message.id);
				pending.resolve(message.hashes);
				return;
			}
			default:
				return;
		}
	}

	// ---------------------------------------------------------------------
	// Attachments
	// ---------------------------------------------------------------------

	setBlobHost(host: LanBlobHost | null): void {
		this.blobHost = host;
	}

	private settleBlobRequest(id: number, pending: PendingBlobRequest, bytes: Uint8Array | null): void {
		window.clearTimeout(pending.timer);
		this.blobRequests.delete(id);
		pending.resolve(bytes);
	}

	/** Wait until at least one device is linked (or the time is up). */
	waitForPeer(timeoutMs: number): Promise<boolean> {
		if (this.peers.size > 0) return Promise.resolve(true);
		return new Promise<boolean>((resolve) => {
			const done = (value: boolean): void => {
				window.clearTimeout(timer);
				this.peerWaiters.delete(onPeer);
				resolve(value);
			};
			const onPeer = (): void => done(true);
			const timer = window.setTimeout(() => done(false), timeoutMs);
			this.peerWaiters.add(onPeer);
		});
	}

	/** Ask every linked device for an attachment; the first one that has it answers. Null when none has it. */
	requestBlob(hash: string, timeoutMs: number): Promise<Uint8Array | null> {
		const links = Array.from(this.peers.values()).map((p) => p.link);
		if (links.length === 0) return Promise.resolve(null);
		const id = this.nextRequestId++;
		return new Promise<Uint8Array | null>((resolve) => {
			const timer = window.setTimeout(() => {
				this.blobRequests.delete(id);
				resolve(null);
			}, timeoutMs);
			this.blobRequests.set(id, { resolve, remaining: links.length, timer });
			for (const link of links) link.sendText({ t: "blob-want", id, hash });
		});
	}

	/** Which of these attachments any linked device has. */
	async peersHave(hashes: string[], timeoutMs = 5000): Promise<string[]> {
		const links = Array.from(this.peers.values()).map((p) => p.link);
		if (links.length === 0 || hashes.length === 0) return [];
		const found = new Set<string>();
		await Promise.all(links.map((link) => new Promise<void>((resolve) => {
			const id = this.nextRequestId++;
			const timer = window.setTimeout(() => {
				this.hasRequests.delete(id);
				resolve();
			}, timeoutMs);
			this.hasRequests.set(id, {
				timer,
				resolve: (list) => {
					for (const h of list) found.add(h);
					resolve();
				},
			});
			link.sendText({ t: "blob-has", id, hashes });
		})));
		return hashes.filter((h) => found.has(h));
	}

	/** Send an attachment to every linked device (best effort; they can also ask for it later). */
	pushBlob(hash: string, bytes: Uint8Array): void {
		const message = blobPutMessage(hash, bytes);
		for (const peer of this.peers.values()) peer.link.sendBinary(message);
	}
}

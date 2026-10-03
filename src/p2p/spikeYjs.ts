/**
 * Phase 0 spike — Yjs document sync over a spike link.
 *
 * Wire format on the binary channel: byte-identical to the y-protocols 1.x
 * (y-partyserver) sync frames — `[type: varUint][payload: varUint8Array]`.
 *   type 0  → sync step 1 (state vector)
 *   type 1  → sync step 2 (missing state)
 *   type 2  → Yjs update
 *
 * The envelope is encoded/decoded with a self-contained varuint codec
 * instead of importing lib0 directly (a jiti/loader interop issue makes
 * direct lib0 subpath imports from src/ unreliable in the Node test
 * runner); yjs's own encodeStateVector/decodeStateAsUpdate/applyUpdate
 * produce and consume the payloads, so interop with the canonical
 * implementation is exact. Control frames ride the text channel and never
 * touch this module.
 */

import * as Y from "yjs";

export interface SpikeYjsStats {
	synced: boolean;
	localEdits: number;
	remoteEdits: number;
	receivedBytes: number;
}

// ---------------------------------------------------------------------------
// varuint (LEB128, 7 bits/byte) + varUint8Array envelope
// ---------------------------------------------------------------------------

function readVarUint(buf: Uint8Array, pos: number): { value: number; next: number } {
	let value = 0;
	let shift = 0;
	for (;;) {
		const byte = buf[pos]!;
		value |= (byte & 0x7f) << shift;
		pos++;
		if ((byte & 0x80) === 0) return { value, next: pos };
		shift += 7;
	}
}

function writeVarUint(out: number[], value: number): void {
	for (;;) {
		if (value < 0x80) {
			out.push(value);
			return;
		}
		out.push((value & 0x7f) | 0x80);
		value = Math.floor(value / 128);
	}
}

/** Wrap a payload into a sync frame: `[type: varUint][payload: varUint8Array]`. */
function wrapFrame(type: number, payload: Uint8Array): Uint8Array {
	const out: number[] = [];
	writeVarUint(out, type);
	writeVarUint(out, payload.length);
	for (const b of payload) out.push(b);
	return new Uint8Array(out);
}

/** Unwrap a sync frame; returns null when the frame is malformed. */
function unwrapFrame(
	bytes: Uint8Array,
): { type: number; payload: Uint8Array } | null {
	const head = readVarUint(bytes, 0);
	const len = readVarUint(bytes, head.next);
	const start = len.next;
	if (start + len.value > bytes.length) return null;
	return { type: head.value, payload: bytes.slice(start, start + len.value) };
}

// ---------------------------------------------------------------------------
// Document sync
// ---------------------------------------------------------------------------

/** True iff `doc` already contains every item the peer's state vector references. */
function containsAllLocal(doc: Y.Doc, peerStateVector: Uint8Array): boolean {
	const peerClocks = Y.decodeStateVector(peerStateVector);
	const localClocks = Y.decodeStateVector(Y.encodeStateVector(doc));
	for (const [clientId, clock] of peerClocks) {
		if ((localClocks.get(clientId) ?? 0) < clock) return false;
	}
	return true;
}

export class SpikeYjs {
	readonly doc: Y.Doc;
	readonly text: Y.Text;

	private synced = false;
	private localEdits = 0;
	private remoteEdits = 0;
	private receivedBytes = 0;
	private sendSink: ((bytes: Uint8Array) => void) | null = null;
	private detachFn: (() => void) | null = null;

	/** Origin marking transactions applied from the peer. */
	private readonly peerOrigin = { "yaos-spike-peer": true };

	constructor() {
		this.doc = new Y.Doc();
		this.text = this.doc.getText("spike");
	}

	get isSynced(): boolean {
		return this.synced;
	}

	stats(): SpikeYjsStats {
		return {
			synced: this.synced,
			localEdits: this.localEdits,
			remoteEdits: this.remoteEdits,
			receivedBytes: this.receivedBytes,
		};
	}

	/**
	 * Begin the sync handshake (send sync step 1) and start broadcasting
	 * local updates. Returns a detach function. Must be called once the
	 * link's channel is open. Re-attaching (a re-pair on the same document)
	 * detaches the previous sink first.
	 */
	attach(send: (bytes: Uint8Array) => void): () => void {
		if (this.detachFn) this.detachFn();
		this.sendSink = send;

		send(wrapFrame(0, Y.encodeStateVector(this.doc)));

		const onUpdate = (update: Uint8Array, origin: unknown): void => {
			if (origin === this.peerOrigin) return; // never re-broadcast peer state
			this.localEdits++;
			this.sendSink?.(wrapFrame(2, update));
		};
		this.doc.on("update", onUpdate);

		const detach = (): void => {
			this.doc.off("update", onUpdate);
			if (this.sendSink === send) this.sendSink = null;
			if (this.detachFn === detach) this.detachFn = null;
		};
		this.detachFn = detach;
		return detach;
	}

	/** Handle one binary frame from the peer. */
	onMessage(bytes: Uint8Array): void {
		if (bytes.length === 0 || this.sendSink === null) return;
		const frame = unwrapFrame(bytes);
		if (!frame) return;
		this.receivedBytes += bytes.length;

		if (frame.type === 0) {
			// Peer's state vector: reply with the state the peer is missing.
			// NOTE: yjs 13.x `encodeStateAsUpdate(doc, sv)` takes the ENCODED
			// state vector (Uint8Array), exactly as y-protocols does — never a
			// decoded Map (passing a Map corrupts the diff and throws).
			const missing = Y.encodeStateAsUpdate(this.doc, frame.payload);
			if (missing.length > 0) {
				this.sendSink(wrapFrame(1, missing));
			}
			if (containsAllLocal(this.doc, frame.payload)) {
				// We have everything the peer has, and it now has everything
				// we have: the exchange is complete.
				this.synced = true;
			}
			return;
		}
		if (frame.type === 1 || frame.type === 2) {
			// Peer state applied locally: missing data arrived.
			Y.applyUpdate(this.doc, frame.payload, this.peerOrigin);
			this.remoteEdits++;
			this.synced = true;
			return;
		}
		// Unknown frame type: drop (the spike prefers to survive over strict).
	}

	/** Local test edit used by the spike panel / debug API. */
	edit(replaceText: string): void {
		this.doc.transact(() => {
			this.text.delete(0, this.text.length);
			if (replaceText.length > 0) this.text.insert(0, replaceText);
		});
	}
}

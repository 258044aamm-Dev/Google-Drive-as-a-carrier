/**
 * Messages of a link, after the WebSocket framing.
 *
 * Control messages (sign-in, receipts, attachment requests) are small JSON
 * texts. Bulk data (Yjs sync frames, presence, attachment bytes) travels as
 * binary messages whose first byte says what they are.
 *
 * Nothing here talks to a socket, so it is tested on its own.
 */
import { LAN_PROTOCOL_VERSION } from "./lanConstants";

// ---------------------------------------------------------------------------
// Text messages
// ---------------------------------------------------------------------------

export type LanTextMessage =
	| { t: "hello"; v: number; deviceId: string; deviceName: string; vault: string; nonce: string }
	| { t: "challenge"; v: number; deviceId: string; deviceName: string; nonce: string; proof: string }
	| { t: "auth"; proof: string }
	| { t: "ready" }
	| { t: "refuse"; reason: string }
	/** "I now hold at least this state" (base64 Yjs state vector). */
	| { t: "ack"; sv: string }
	| { t: "blob-want"; id: number; hash: string }
	| { t: "blob-miss"; id: number }
	| { t: "blob-has"; id: number; hashes: string[] }
	| { t: "blob-has-reply"; id: number; hashes: string[] };

const HEX_64 = /^[0-9a-f]{64}$/;

function isString(value: unknown, max = 200): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isHashList(value: unknown): value is string[] {
	return Array.isArray(value) && value.length <= 5000 && value.every((h) => typeof h === "string" && HEX_64.test(h));
}

/** Parse and validate a control message. Anything unexpected gives null. */
export function parseLanText(text: string): LanTextMessage | null {
	if (text.length > 2_000_000) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null) return null;
	const m = raw as Record<string, unknown>;
	switch (m.t) {
		case "hello":
			if (typeof m.v !== "number" || !isString(m.deviceId, 64) || !isString(m.deviceName, 100) || !isString(m.vault, 64) || !isString(m.nonce, 64)) return null;
			return { t: "hello", v: m.v, deviceId: m.deviceId, deviceName: m.deviceName, vault: m.vault, nonce: m.nonce };
		case "challenge":
			if (typeof m.v !== "number" || !isString(m.deviceId, 64) || !isString(m.deviceName, 100) || !isString(m.nonce, 64) || !isString(m.proof, 128)) return null;
			return { t: "challenge", v: m.v, deviceId: m.deviceId, deviceName: m.deviceName, nonce: m.nonce, proof: m.proof };
		case "auth":
			return isString(m.proof, 128) ? { t: "auth", proof: m.proof } : null;
		case "ready":
			return { t: "ready" };
		case "refuse":
			return { t: "refuse", reason: typeof m.reason === "string" ? m.reason.slice(0, 200) : "refused" };
		case "ack":
			return isString(m.sv, 1_500_000) ? { t: "ack", sv: m.sv } : null;
		case "blob-want":
			return typeof m.id === "number" && typeof m.hash === "string" && HEX_64.test(m.hash) ? { t: "blob-want", id: m.id, hash: m.hash } : null;
		case "blob-miss":
			return typeof m.id === "number" ? { t: "blob-miss", id: m.id } : null;
		case "blob-has":
			return typeof m.id === "number" && isHashList(m.hashes) ? { t: "blob-has", id: m.id, hashes: m.hashes } : null;
		case "blob-has-reply":
			return typeof m.id === "number" && isHashList(m.hashes) ? { t: "blob-has-reply", id: m.id, hashes: m.hashes } : null;
		default:
			return null;
	}
}

export function encodeLanText(message: LanTextMessage): string {
	return JSON.stringify(message);
}

export function lanHello(deviceId: string, deviceName: string, vault: string, nonce: string): LanTextMessage {
	return { t: "hello", v: LAN_PROTOCOL_VERSION, deviceId, deviceName, vault, nonce };
}

// ---------------------------------------------------------------------------
// Binary messages
// ---------------------------------------------------------------------------

/** First byte of a binary message. */
export const BIN_SYNC = 1;
export const BIN_AWARENESS = 2;
/** An attachment sent in answer to `blob-want`: [id u32][bytes]. */
export const BIN_BLOB_DATA = 3;
/** An attachment pushed to a peer: [hash 32 bytes][bytes]. */
export const BIN_BLOB_PUT = 4;

export function binaryMessage(kind: number, payload: Uint8Array): Uint8Array {
	const out = new Uint8Array(1 + payload.length);
	out[0] = kind;
	out.set(payload, 1);
	return out;
}

export function splitBinary(data: Uint8Array): { kind: number; payload: Uint8Array } | null {
	if (data.length < 1) return null;
	return { kind: data[0] ?? 0, payload: data.subarray(1) };
}

export function blobDataMessage(id: number, bytes: Uint8Array): Uint8Array {
	const out = new Uint8Array(4 + bytes.length);
	new DataView(out.buffer).setUint32(0, id >>> 0, false);
	out.set(bytes, 4);
	return binaryMessage(BIN_BLOB_DATA, out);
}

export function parseBlobData(payload: Uint8Array): { id: number; bytes: Uint8Array } | null {
	if (payload.length < 4) return null;
	const id = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0, false);
	return { id, bytes: payload.subarray(4) };
}

export function hexToBytes(hex: string): Uint8Array {
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

export function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function blobPutMessage(hash: string, bytes: Uint8Array): Uint8Array {
	const out = new Uint8Array(32 + bytes.length);
	out.set(hexToBytes(hash), 0);
	out.set(bytes, 32);
	return binaryMessage(BIN_BLOB_PUT, out);
}

export function parseBlobPut(payload: Uint8Array): { hash: string; bytes: Uint8Array } | null {
	if (payload.length < 32) return null;
	return { hash: bytesToHex(payload.subarray(0, 32)), bytes: payload.subarray(32) };
}

// ---------------------------------------------------------------------------
// Yjs sync frames: [type: varUint][payload: varUint8Array], the y-protocols layout
// ---------------------------------------------------------------------------

export const SYNC_STEP1 = 0;
export const SYNC_STEP2 = 1;
export const SYNC_UPDATE = 2;

function writeVarUint(out: number[], value: number): void {
	let v = value;
	while (v >= 0x80) {
		out.push((v & 0x7f) | 0x80);
		v = Math.floor(v / 128);
	}
	out.push(v);
}

export function encodeSyncFrame(type: number, payload: Uint8Array): Uint8Array {
	const header: number[] = [];
	writeVarUint(header, type);
	writeVarUint(header, payload.length);
	const out = new Uint8Array(header.length + payload.length);
	out.set(header, 0);
	out.set(payload, header.length);
	return out;
}

export function decodeSyncFrame(frame: Uint8Array): { type: number; payload: Uint8Array } | null {
	let pos = 0;
	const readVarUint = (): number | null => {
		let value = 0;
		let scale = 1;
		for (let i = 0; i < 6; i++) {
			if (pos >= frame.length) return null;
			const byte = frame[pos++] ?? 0;
			value += (byte & 0x7f) * scale;
			if ((byte & 0x80) === 0) return value;
			scale *= 128;
		}
		return null;
	};
	const type = readVarUint();
	const length = readVarUint();
	if (type === null || length === null || pos + length > frame.length) return null;
	return { type, payload: frame.subarray(pos, pos + length) };
}

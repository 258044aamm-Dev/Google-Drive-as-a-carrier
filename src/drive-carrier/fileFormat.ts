/**
 * Binary format of the files the Drive carrier writes.
 *
 *   offset  size  field
 *   0       4     magic "YDS1"
 *   4       1     format version (FORMAT_VERSION)
 *   5       1     kind (1 = update segment, 2 = full snapshot)
 *   6       1     flags (bit 0: the payload is encrypted)
 *   7       1     reserved, zero
 *   8       32    SHA-256 of the payload
 *   40      n     payload: a Yjs update (or, with the encrypted flag, the sealed update)
 *
 * The checksum lets a reader reject a damaged or truncated file instead of
 * applying garbage. An unknown version or kind is rejected the same way.
 */

export const FORMAT_VERSION = 1;
export const KIND_SEGMENT = 1;
export const KIND_SNAPSHOT = 2;

const MAGIC = [0x59, 0x44, 0x53, 0x31];
const HEADER_BYTES = 40;
const FLAG_ENCRYPTED = 1;

export type FileKind = typeof KIND_SEGMENT | typeof KIND_SNAPSHOT;

export class CorruptFileError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CorruptFileError";
	}
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
	const copy = new Uint8Array(bytes.length);
	copy.set(bytes);
	return new Uint8Array(await crypto.subtle.digest("SHA-256", copy));
}

export async function encodeFile(kind: FileKind, payload: Uint8Array, encrypted = false): Promise<Uint8Array> {
	const out = new Uint8Array(HEADER_BYTES + payload.length);
	out.set(MAGIC, 0);
	out[4] = FORMAT_VERSION;
	out[5] = kind;
	if (encrypted) out[6] = FLAG_ENCRYPTED;
	out.set(await sha256(payload), 8);
	out.set(payload, HEADER_BYTES);
	return out;
}

export interface DecodedFile {
	kind: FileKind;
	payload: Uint8Array;
	/** The payload is sealed (see driveCrypto) and must be opened before use. */
	encrypted: boolean;
}

export async function decodeFile(bytes: Uint8Array): Promise<DecodedFile> {
	if (bytes.length < HEADER_BYTES) throw new CorruptFileError("file is shorter than its header");
	for (let i = 0; i < MAGIC.length; i++) {
		if (bytes[i] !== MAGIC[i]) throw new CorruptFileError("bad magic");
	}
	const version = bytes[4];
	if (version !== FORMAT_VERSION) throw new CorruptFileError(`unsupported format version ${String(version)}`);
	const kind = bytes[5];
	if (kind !== KIND_SEGMENT && kind !== KIND_SNAPSHOT) {
		throw new CorruptFileError(`unknown file kind ${String(kind)}`);
	}
	const payload = bytes.subarray(HEADER_BYTES);
	const expected = bytes.subarray(8, HEADER_BYTES);
	const actual = await sha256(payload);
	for (let i = 0; i < 32; i++) {
		if (actual[i] !== expected[i]) throw new CorruptFileError("checksum mismatch");
	}
	return { kind, payload, encrypted: ((bytes[6] ?? 0) & FLAG_ENCRYPTED) !== 0 };
}

// ---------------------------------------------------------------------------
// File names
// ---------------------------------------------------------------------------

export const META_NAME = "meta.json";

export type FileNameKind = "segment" | "snapshot" | "meta" | "other";

function stamp(ms: number): string {
	return String(Math.max(0, Math.floor(ms))).padStart(13, "0");
}

export function segmentName(ms: number, deviceId: string, counter: number): string {
	return `seg-${stamp(ms)}-${deviceId}-${counter}.ydu`;
}

export function snapshotName(ms: number, deviceId: string, counter: number): string {
	return `snap-${stamp(ms)}-${deviceId}-${counter}.yds`;
}

export function classifyName(name: string): FileNameKind {
	if (name === META_NAME) return "meta";
	if (/^seg-\d{13}-.+\.ydu$/.test(name)) return "segment";
	if (/^snap-\d{13}-.+\.yds$/.test(name)) return "snapshot";
	return "other";
}

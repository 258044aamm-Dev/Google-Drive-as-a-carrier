/**
 * Optional encryption for everything the Drive carrier stores.
 *
 * One passphrase protects a vault. The key is derived with PBKDF2-SHA256 from the
 * passphrase and a random salt that is stored (in the clear) in the vault
 * folder's `meta.json`; HKDF then splits it into an AES-256-GCM key and a
 * separate HMAC key that hides attachment names. Everything is done with
 * Web Crypto, which Obsidian (desktop and mobile) provides.
 *
 * A sealed value is   [format 1 byte][iv 12 bytes][AES-GCM ciphertext + tag].
 * GCM authenticates the data, so a damaged or modified file is rejected. The
 * "purpose" (segment, snapshot, ...) and the vault id are bound in as
 * additional authenticated data, so a file cannot be passed off as another
 * kind or moved into another vault.
 *
 * What stays readable on Drive: file names (time stamps, device ids, sizes),
 * the salt and the key-check value. What is protected: note and attachment
 * contents, attachment names (they are keyed hashes), snapshot indexes.
 */

export const SEAL_FORMAT = 1;
export const DEFAULT_KDF_ITERATIONS = 600_000;
const MIN_KDF_ITERATIONS = 1_000;
const MAX_KDF_ITERATIONS = 5_000_000;
const IV_BYTES = 12;
const SALT_BYTES = 16;
const CHECK_TEXT = "yaos-drive-key-check";

/** What a sealed value is for. It is part of what the seal authenticates. */
export type SealPurpose = "segment" | "snapshot" | "blob" | "snapshot-data" | "snapshot-index" | "check";

export class EncryptionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EncryptionError";
	}
}

/** What `meta.json` records about the encryption of a vault folder. */
export interface EncryptionMeta {
	v: 1;
	kdf: "pbkdf2-sha256";
	iterations: number;
	/** base64 */
	salt: string;
	/** base64; the sealed constant text, used to tell a wrong passphrase from damaged data */
	check: string;
}

export interface DriveSealer {
	seal(plain: Uint8Array, purpose: SealPurpose): Promise<Uint8Array>;
	open(sealed: Uint8Array, purpose: SealPurpose): Promise<Uint8Array>;
	/** The file name an attachment with this plaintext SHA-256 gets on Drive (64 hex characters). */
	blobName(plainHash: string): Promise<string>;
}

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
	const binary = atob(text);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

function copyOf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(new ArrayBuffer(bytes.byteLength));
	out.set(bytes);
	return out;
}

function hex(bytes: Uint8Array): string {
	let out = "";
	for (const b of bytes) out += b.toString(16).padStart(2, "0");
	return out;
}

class Sealer implements DriveSealer {
	constructor(
		private readonly vaultId: string,
		private readonly aesKey: CryptoKey,
		private readonly nameKey: CryptoKey,
	) {}

	private context(purpose: SealPurpose): Uint8Array<ArrayBuffer> {
		return copyOf(new TextEncoder().encode(`yaos-drive/v${SEAL_FORMAT}/${this.vaultId}/${purpose}`));
	}

	async seal(plain: Uint8Array, purpose: SealPurpose): Promise<Uint8Array> {
		const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
		const cipher = new Uint8Array(
			await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: this.context(purpose) }, this.aesKey, copyOf(plain)),
		);
		const out = new Uint8Array(1 + IV_BYTES + cipher.length);
		out[0] = SEAL_FORMAT;
		out.set(iv, 1);
		out.set(cipher, 1 + IV_BYTES);
		return out;
	}

	async open(sealed: Uint8Array, purpose: SealPurpose): Promise<Uint8Array> {
		if (sealed.length < 1 + IV_BYTES + 16) throw new EncryptionError("sealed data is too short");
		if (sealed[0] !== SEAL_FORMAT) throw new EncryptionError(`unsupported encryption format ${String(sealed[0])}`);
		const iv = copyOf(sealed.subarray(1, 1 + IV_BYTES));
		try {
			return new Uint8Array(
				await crypto.subtle.decrypt(
					{ name: "AES-GCM", iv, additionalData: this.context(purpose) },
					this.aesKey,
					copyOf(sealed.subarray(1 + IV_BYTES)),
				),
			);
		} catch {
			throw new EncryptionError("could not decrypt (wrong passphrase, or the file is damaged)");
		}
	}

	async blobName(plainHash: string): Promise<string> {
		const mac = await crypto.subtle.sign("HMAC", this.nameKey, copyOf(new TextEncoder().encode(`${this.vaultId}/${plainHash}`)));
		return hex(new Uint8Array(mac));
	}
}

async function deriveKeys(passphrase: string, salt: Uint8Array, iterations: number): Promise<{ aesKey: CryptoKey; nameKey: CryptoKey }> {
	const base = await crypto.subtle.importKey("raw", copyOf(new TextEncoder().encode(passphrase.normalize("NFKC"))), "PBKDF2", false, ["deriveBits"]);
	const master = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", hash: "SHA-256", salt: copyOf(salt), iterations },
		base,
		256,
	);
	const hkdfKey = await crypto.subtle.importKey("raw", master, "HKDF", false, ["deriveKey"]);
	const info = (label: string) => copyOf(new TextEncoder().encode(label));
	const aesKey = await crypto.subtle.deriveKey(
		{ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: info("yaos-drive/aes-gcm/v1") },
		hkdfKey,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
	const nameKey = await crypto.subtle.deriveKey(
		{ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: info("yaos-drive/blob-name/v1") },
		hkdfKey,
		{ name: "HMAC", hash: "SHA-256", length: 256 },
		false,
		["sign"],
	);
	return { aesKey, nameKey };
}

/** Start encrypting a vault: a fresh salt, the sealer for it, and what to record in `meta.json`. */
export async function createEncryption(
	passphrase: string,
	vaultId: string,
	iterations = DEFAULT_KDF_ITERATIONS,
): Promise<{ sealer: DriveSealer; meta: EncryptionMeta }> {
	const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
	const { aesKey, nameKey } = await deriveKeys(passphrase, salt, iterations);
	const sealer = new Sealer(vaultId, aesKey, nameKey);
	const check = await sealer.seal(new TextEncoder().encode(CHECK_TEXT), "check");
	return { sealer, meta: { v: 1, kdf: "pbkdf2-sha256", iterations, salt: toBase64(salt), check: toBase64(check) } };
}

/** Read what `meta.json` says, or null when it is not valid encryption metadata. */
export function parseEncryptionMeta(value: unknown): EncryptionMeta | null {
	if (typeof value !== "object" || value === null) return null;
	const r = value as Record<string, unknown>;
	if (r.v !== 1 || r.kdf !== "pbkdf2-sha256") return null;
	if (typeof r.iterations !== "number" || !Number.isInteger(r.iterations)) return null;
	if (r.iterations < MIN_KDF_ITERATIONS || r.iterations > MAX_KDF_ITERATIONS) return null;
	if (typeof r.salt !== "string" || typeof r.check !== "string") return null;
	try {
		if (fromBase64(r.salt).length < 8) return null;
		fromBase64(r.check);
	} catch {
		return null;
	}
	return { v: 1, kdf: "pbkdf2-sha256", iterations: r.iterations, salt: r.salt, check: r.check };
}

/** Unlock an existing vault. Throws EncryptionError when the passphrase is wrong. */
export async function unlockEncryption(passphrase: string, vaultId: string, meta: EncryptionMeta): Promise<DriveSealer> {
	const { aesKey, nameKey } = await deriveKeys(passphrase, fromBase64(meta.salt), meta.iterations);
	const sealer = new Sealer(vaultId, aesKey, nameKey);
	let text: string;
	try {
		text = new TextDecoder().decode(await sealer.open(fromBase64(meta.check), "check"));
	} catch {
		throw new EncryptionError("The encryption passphrase is wrong.");
	}
	if (text !== CHECK_TEXT) throw new EncryptionError("The encryption passphrase is wrong.");
	return sealer;
}

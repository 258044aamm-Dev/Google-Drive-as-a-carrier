import type { BlobStoreClient } from "../sync/blobSync";
import { sha256Hex, type LanFileStore } from "./lanFileStore";
import type { LanBlobHost, LanTransport } from "./lanTransport";

const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * Attachments without a server. Each device keeps a copy of every attachment it
 * has sent or received in a folder inside the plugin's folder, named by its
 * SHA-256; other devices ask the linked devices for what they are missing.
 *
 * Content addressing means a copy is only trusted after its hash has been
 * checked, whoever sent it.
 */
export class LanBlobStore implements BlobStoreClient, LanBlobHost {
	constructor(
		private readonly files: LanFileStore,
		private readonly transport: LanTransport,
	) {
		transport.setBlobHost(this);
	}

	// -- BlobStoreClient (what the attachment sync uses) -------------------

	async exists(hashes: string[]): Promise<string[]> {
		const wanted = hashes.filter((h) => HEX_64.test(h));
		const have = new Set(await this.has(wanted));
		const missing = wanted.filter((h) => !have.has(h));
		if (missing.length > 0) {
			for (const h of await this.transport.peersHave(missing)) have.add(h);
		}
		return wanted.filter((h) => have.has(h));
	}

	async upload(hash: string, _contentType: string, data: ArrayBuffer, _timeoutMs: number): Promise<void> {
		if (!HEX_64.test(hash)) throw new Error(`blob upload failed: invalid hash ${hash.slice(0, 12)}`);
		const bytes = new Uint8Array(data);
		if ((await sha256Hex(bytes)) !== hash) {
			throw new Error(`blob upload failed: content does not match hash ${hash.slice(0, 12)}`);
		}
		await this.files.write(hash, bytes);
		// Best effort: linked devices get it now; the others ask for it when they need it.
		this.transport.pushBlob(hash, bytes);
	}

	async download(hash: string, timeoutMs: number): Promise<ArrayBuffer> {
		if (!HEX_64.test(hash)) throw new Error(`blob download failed: invalid hash ${hash.slice(0, 12)}`);
		const local = await this.readVerified(hash);
		if (local) return toBuffer(local);
		const deadline = Date.now() + timeoutMs;
		if (!(await this.transport.waitForPeer(Math.max(0, deadline - Date.now())))) {
			throw new Error(`blob download failed: 404 no other device is reachable for attachment ${hash.slice(0, 12)}`);
		}
		const bytes = await this.transport.requestBlob(hash, Math.max(1000, deadline - Date.now()));
		if (!bytes) {
			throw new Error(`blob download failed: 404 attachment ${hash.slice(0, 12)} is not on the linked devices`);
		}
		if ((await sha256Hex(bytes)) !== hash) {
			throw new Error(`blob download failed: attachment ${hash.slice(0, 12)} arrived damaged`);
		}
		await this.files.write(hash, bytes);
		return toBuffer(bytes);
	}

	// -- LanBlobHost (what other devices ask this one) ---------------------

	async serve(hash: string): Promise<Uint8Array | null> {
		return await this.readVerified(hash);
	}

	async receive(hash: string, bytes: Uint8Array): Promise<void> {
		if (!HEX_64.test(hash)) return;
		if ((await sha256Hex(bytes)) !== hash) return;
		if (await this.files.exists(hash)) return;
		await this.files.write(hash, bytes);
	}

	async has(hashes: string[]): Promise<string[]> {
		const out: string[] = [];
		for (const hash of hashes) {
			if (HEX_64.test(hash) && (await this.files.exists(hash))) out.push(hash);
		}
		return out;
	}

	/** A stored copy, checked against its name. A damaged copy is removed so it can be fetched again. */
	private async readVerified(hash: string): Promise<Uint8Array | null> {
		if (!HEX_64.test(hash)) return null;
		const bytes = await this.files.read(hash);
		if (!bytes) return null;
		if ((await sha256Hex(bytes)) !== hash) {
			await this.files.remove(hash).catch(() => undefined);
			return null;
		}
		return bytes;
	}
}

function toBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
}

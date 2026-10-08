import * as Y from "yjs";
import { gunzipSync } from "fflate";
import type { SnapshotIndex } from "../sync/snapshotClient";

/**
 * Both carrier formats have always written a raw-update hash and sizes.
 * Refuse missing/invalid integrity metadata rather than silently restoring
 * unverified bytes. This does not change encryption or the stored format.
 */
export async function verifiedSnapshotDoc(compressed: Uint8Array, index: SnapshotIndex, vaultId: string): Promise<Y.Doc> {
	if (index.vaultId !== vaultId) throw new Error("Snapshot belongs to a different vault");
	if (typeof index.fullUpdateHash !== "string" || !/^[0-9a-f]{64}$/.test(index.fullUpdateHash)) {
		throw new Error("Snapshot integrity hash is missing or invalid; refusing an unverified restore");
	}
	const size = index.crdtRawSizeBytes;
	if (!Number.isSafeInteger(size) || size <= 0 || size > 0xffffffff) {
		throw new Error("Snapshot raw size is invalid for its gzip length declaration");
	}
	if (index.crdtSizeBytes !== compressed.byteLength || compressed.byteLength < 18) {
		throw new Error("Snapshot compressed size does not match its index");
	}
	// gzip ISIZE is a 32-bit uncompressed length. Match it before allocating
	// the declared output buffer; do not introduce a smaller arbitrary vault cap.
	const footer = new DataView(compressed.buffer, compressed.byteOffset, compressed.byteLength);
	if (footer.getUint32(compressed.byteLength - 4, true) !== size) {
		throw new Error("Snapshot raw size does not match its index");
	}
	const raw = gunzipSync(compressed, { out: new Uint8Array(size) });
	const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(raw));
	const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
	if (hash !== index.fullUpdateHash) throw new Error("Snapshot integrity hash does not match its index");
	const doc = new Y.Doc();
	try {
		Y.applyUpdate(doc, raw);
		return doc;
	} catch (err) {
		doc.destroy();
		throw err;
	}
}

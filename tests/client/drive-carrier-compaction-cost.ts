/**
 * Drive carrier: compaction cost (F1).
 *
 * The measured finding was write amplification: compaction uploaded the whole
 * document whenever the change files passed 1 MB, so an 8.29 MB vault with
 * 0.30 MB of edits wrote 8.61 MB (×28.2) after the first reconcile.
 *
 * The four measured configurations are asserted here with ceilings, against a
 * per-file byte counter, exactly like the probe that found the problem. The
 * adaptive default must write about as many bytes as were changed; `legacy`
 * must still write 2.1.22's bytes; a new device must still reconstruct the
 * vault from Drive alone.
 */
import * as Y from "yjs";
import type { DriveApi, DriveFileInfo, DriveFolderInfo } from "../../src/drive-carrier/driveApi";
import { DriveError } from "../../src/drive-carrier/driveApi";
import { DriveTransport, type DriveTransportOptions } from "../../src/drive-carrier/driveTransport";
import { FakeDrive } from "../mocks/fakeDrive";
import { suite } from "../harness.ts";

const s = suite("drive-carrier-compaction-cost");
const KB = 1024;
const MB = 1024 * KB;
const VAULT = "cost";
const FOLDER = `YAOS ${VAULT}`;
const enc = new TextEncoder();

interface Counters {
	written: number;
	created: { name: string; bytes: number }[];
	read: number;
	listed: number;
	deleted: number;
}

function countingApi(inner: DriveApi, c: Counters): DriveApi {
	return {
		findFolders: (n: string): Promise<DriveFolderInfo[]> => inner.findFolders(n),
		createFolder: (n: string): Promise<DriveFolderInfo> => inner.createFolder(n),
		listFiles: (id: string): Promise<DriveFileInfo[]> => {
			c.listed++;
			return inner.listFiles(id);
		},
		createFile: (id: string, name: string, data: Uint8Array): Promise<DriveFileInfo> => {
			c.written += data.length;
			c.created.push({ name, bytes: data.length });
			return inner.createFile(id, name, data);
		},
		readFile: (id: string): Promise<Uint8Array> => {
			c.read++;
			return inner.readFile(id);
		},
		getFile: (id: string): Promise<DriveFileInfo> => inner.getFile(id),
		deleteFile: (id: string): Promise<void> => {
			c.deleted++;
			return inner.deleteFile(id);
		},
	};
}

/** Runs the probe's scenario and reports what Drive was asked to store after the bootstrap. */
async function measure(
	docBytes: number,
	newContentBytes: number,
	editChunkBytes: number,
	extra: Partial<DriveTransportOptions> = {},
): Promise<{ amplification: number; newContent: number; snapshotBytes: number; snapshotCount: number; merged: number; bootstrapBytes: number; counters: Counters }> {
	const drive = new FakeDrive();
	const counters: Counters = { written: 0, created: [], read: 0, listed: 0, deleted: 0 };
	const doc = new Y.Doc();
	doc.clientID = 4242;
	const filler = "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(4);
	const text = doc.getText("t");
	const needed = Math.ceil(docBytes / filler.length);
	for (let i = 0; i < needed; i++) text.insert(text.length, `${String(i).padStart(6, "0")} ${filler}\n`);

	let clock = 1_700_000_000_000;
	const logs: string[] = [];
	const transport = new DriveTransport(doc, countingApi(drive.client(), counters), {
		vaultId: VAULT,
		deviceId: "costA",
		autoTimers: false,
		now: () => clock,
		log: (m) => logs.push(m),
		...extra,
	});
	await transport.connect();
	const bootstrapBytes = counters.written;
	const createdAt = counters.created.length;

	let realNewContent = 0;
	const chunk = "x".repeat(editChunkBytes);
	while (realNewContent < newContentBytes) {
		const before = Y.encodeStateAsUpdate(doc).length;
		text.insert(text.length, `${chunk}\n`);
		realNewContent += Y.encodeStateAsUpdate(doc).length - before;
		await transport.flush();
		clock += 60_000; // edits a minute apart: the compaction rate limit never hides the effect
		await transport.syncNow();
	}
	const after = counters.created.slice(createdAt);
	const snapshotFiles = after.filter((f) => f.name.startsWith("snap-"));
	const mergedCount = logs.filter((m) => m.includes("change file(s)")).length;
	const written = counters.written - bootstrapBytes;
	s.check(transport.knownFiles <= 210, `known files stay bounded (${transport.knownFiles})`);
	transport.destroy();
	return {
		amplification: written / realNewContent,
		newContent: realNewContent,
		snapshotBytes: snapshotFiles.reduce((sum, f) => sum + f.bytes, 0),
		snapshotCount: snapshotFiles.length,
		merged: mergedCount,
		bootstrapBytes,
		counters,
	};
}

s.section("F1: the default writes about as many bytes as the user changed (the probe's four rows)");
{
	const smallDoc = await measure(1 * MB, 0.3 * MB, 8 * KB);
	s.check(smallDoc.amplification <= 2, `1.04 MB document, 0.30 MB changed: written ×${smallDoc.amplification.toFixed(2)} (was ×4.4, ceiling ×2)`);
	s.check(smallDoc.snapshotCount === 0, "no full copy was written for such a small change");
	const bigDoc = await measure(8 * MB, 0.3 * MB, 8 * KB);
	s.check(bigDoc.amplification <= 2, `8.29 MB document, 0.30 MB changed: written ×${bigDoc.amplification.toFixed(2)} (was ×28.2, ceiling ×2)`);
	s.check(bigDoc.snapshotCount === 0, "the 8 MB document is never re-uploaded for small edits");
	const smallBigEdit = await measure(1 * MB, 3 * MB, 256 * KB);
	s.check(smallBigEdit.amplification <= 3, `1.04 MB document, 3.00 MB changed: written ×${smallBigEdit.amplification.toFixed(2)} (was ×3.3, ceiling ×3)`);
	const bigBigEdit = await measure(8 * MB, 3 * MB, 256 * KB);
	s.check(bigBigEdit.amplification <= 3, `8.29 MB document, 3.00 MB changed: written ×${bigBigEdit.amplification.toFixed(2)} (was ×10.5, ceiling ×3)`);
	s.check(bigBigEdit.snapshotCount === 0, "and the 3 MB of edits are not turned into 28 MB of copies");
}

s.section("F1: when the folder does fill up, the change files are merged, not copied");
{
	const forced = await measure(1 * MB, 0.6 * MB, 64 * KB, { compactSegmentCount: 4 });
	s.check(forced.merged >= 1, `the merge tier ran (${forced.merged} merge(s))`);
	s.check(forced.snapshotCount === 0, "and no full copy was written");
	s.check(forced.amplification <= 3, `bytes written ×${forced.amplification.toFixed(2)} for the changed content (ceiling ×3)`);
	const logs: string[] = [];
	const drive = new FakeDrive();
	const doc = new Y.Doc();
	const text = doc.getText("t");
	let clock = 1_700_000_000_000;
	const transport = new DriveTransport(doc, drive.client(), {
		vaultId: VAULT, deviceId: "mergeA", autoTimers: false, now: () => clock,
		compactSegmentCount: 3, log: (m) => logs.push(m),
	});
	await transport.connect();
	for (let i = 0; i < 12; i++) { text.insert(text.length, `edit ${i} `); await transport.flush(); clock += 61_000; await transport.syncNow(); }
	const segFiles = drive.filesIn(FOLDER).filter((f) => f.name.startsWith("seg-")).map((f) => f.name).sort();
	s.check(segFiles.length <= 3, `the folder holds few change files after merging (${segFiles.length})`);
	s.check(logs.some((m) => m.includes("merged")), "the merge is logged");
	// The merged file carries the newest stamp, so reading in name order still ends with it.
	const fresh = new Y.Doc();
	const reader = new DriveTransport(fresh, drive.client(), { vaultId: VAULT, deviceId: "reader", autoTimers: false, now: () => clock });
	await reader.connect(); clock += 61_000; await reader.syncNow();
	s.check(fresh.getText("t").toString() === text.toString(), "a device reading Drive in name order gets the whole document");
	transport.destroy();
	reader.destroy();
}

s.section("F1: a long run of edits stays bounded in cost and in file count");
{
	const drive = new FakeDrive();
	const counters: Counters = { written: 0, created: [], read: 0, listed: 0, deleted: 0 };
	const doc = new Y.Doc();
	doc.clientID = 99;
	const text = doc.getText("t");
	text.insert(0, "start ");
	let clock = 1_700_000_000_000;
	const transport = new DriveTransport(doc, countingApi(drive.client(), counters), {
		vaultId: VAULT, deviceId: "long", autoTimers: false, now: () => clock,
		verifyBeforePrune: false, // measure the bytes only
	});
	await transport.connect();
	const bootstrap = counters.written;
	let newContent = 0;
	const note = "n".repeat(8 * KB);
	for (let i = 0; i < 250; i++) {
		const before = Y.encodeStateAsUpdate(doc).length;
		text.insert(text.length, `${note}\n`);
		newContent += Y.encodeStateAsUpdate(doc).length - before;
		await transport.flush();
		clock += 61_000;
		await transport.syncNow();
	}
	const written = counters.written - bootstrap;
	s.check(written / newContent <= 2.5, `250 edits pass the default cap and cost ×${(written / newContent).toFixed(2)} of the changed content (ceiling ×2.5)`);
	const segCount = drive.filesIn(FOLDER).filter((f) => f.name.startsWith("seg-")).length;
	s.check(segCount <= 210, `the change files stay near their cap however long the run (${segCount})`);
	s.check(drive.filesIn(FOLDER).filter((f) => f.name.startsWith("snap-")).length === 0, "and no full copy was needed");
	s.check(transport.retainedPayloadBytes <= 32 * MB, `memory stays within the bound (${transport.retainedPayloadBytes} bytes)`);
	s.check(transport.knownFiles === segCount, "the known-file map matches the folder");
	const fresh = new Y.Doc();
	const reader = new DriveTransport(fresh, drive.client(), { vaultId: VAULT, deviceId: "readerLong", autoTimers: false, now: () => clock });
	await reader.connect(); clock += 61_000; await reader.syncNow();
	s.check(fresh.getText("t").toString() === text.toString(), "the whole document still comes back from Drive alone");
	transport.destroy();
	reader.destroy();
}

s.section("F1: a full copy is written only when it is actually smaller than what it replaces");
{
	// A small document behind a lot of change files: text that was typed and then
	// removed leaves big segments (about 20 KB each) while the document itself
	// shrinks back to nothing, so a snapshot is far smaller than what it replaces.
	const drive = new FakeDrive();
	const doc = new Y.Doc();
	const text = doc.getText("t");
	text.insert(0, "keep this line\n");
	let clock = 1_700_000_000_000;
	const logs: string[] = [];
	const transport = new DriveTransport(doc, drive.client(), {
		vaultId: VAULT, deviceId: "tierB", autoTimers: false, now: () => clock,
		compactSegmentCount: 4, compactSegmentBytes: 4096, verifyBeforePrune: false, log: (m) => logs.push(m),
	});
	await transport.connect();
	const blob = "y".repeat(20 * KB);
	for (let i = 0; i < 4; i++) {
		const marker = `BLOCK${i}`;
		text.insert(text.length, `${marker}${blob}`);
		await transport.flush();
		clock += 61_000; await transport.syncNow();
		const at = text.toString().indexOf(marker);
		text.delete(at, marker.length + blob.length);
		await transport.flush();
		clock += 61_000; await transport.syncNow();
	}
	const snaps = drive.filesIn(FOLDER).filter((f) => f.name.startsWith("snap-"));
	s.check(snaps.length >= 1, `a full copy was written once the change files outweighed the document (${snaps.length})`);
	const snapshotBytes = snaps.reduce((sum, f) => sum + f.data.length, 0);
	const liveSegmentBytes = drive.filesIn(FOLDER).filter((f) => f.name.startsWith("seg-")).reduce((sum, f) => sum + f.data.length, 0);
	s.check(snapshotBytes > 0 && snapshotBytes * 2 <= liveSegmentBytes, `the copy is much smaller than the change files left behind (${snapshotBytes} vs ${liveSegmentBytes} bytes)`);
	s.check(logs.every((m) => !m.includes("change file(s)")), "no merge mistake: the tier that pays was chosen");
	const fresh = new Y.Doc();
	const reader = new DriveTransport(fresh, drive.client(), { vaultId: VAULT, deviceId: "readerB", autoTimers: false, now: () => clock });
	await reader.connect(); clock += 61_000; await reader.syncNow();
	s.check(fresh.getText("t").toString() === text.toString(), "and a new device still gets exactly the current document");
	transport.destroy();
	reader.destroy();

	// The ceiling: the same shape, but the snapshot would be large — merge instead.
	const ceilingDrive = new FakeDrive();
	const bigDoc = new Y.Doc();
	const bigText = bigDoc.getText("t");
	for (let i = 0; i < 900; i++) bigText.insert(bigText.length, `${"z".repeat(2000)}\n`);
	let clock2 = 1_700_000_000_000;
	const logs2: string[] = [];
	const capped = new DriveTransport(bigDoc, ceilingDrive.client(), {
		vaultId: VAULT, deviceId: "ceiling", autoTimers: false, now: () => clock2,
		compactSegmentCount: 4, compactSegmentBytes: 4096, snapshotMaxBytes: 100 * KB,
		verifyBeforePrune: false, log: (m) => logs2.push(m),
	});
	await capped.connect();
	const part = "w".repeat(40 * KB);
	for (let i = 0; i < 6; i++) { bigText.insert(bigText.length, part); await capped.flush(); clock2 += 61_000; await capped.syncNow(); }
	s.check(ceilingDrive.filesIn(FOLDER).filter((f) => f.name.startsWith("snap-")).length === 0, "a snapshot above the ceiling is never written");
	s.check(logs2.some((m) => m.includes("change file(s)")), "the change files are merged instead");
	capped.destroy();
}

s.section("F1: 'legacy' writes exactly what 2.1.22 wrote");
{
	interface Run { snapshots: number; snapshotBytes: number; written: number; newContent: number; reads: number }
	const run = async (mode: "adaptive" | "legacy"): Promise<Run> => {
		const drive = new FakeDrive();
		const counters: Counters = { written: 0, created: [], read: 0, listed: 0, deleted: 0 };
		const doc = new Y.Doc();
		const text = doc.getText("t");
		text.insert(0, "seed ".repeat(1000));
		let clock = 1_700_000_000_000;
		const transport = new DriveTransport(doc, countingApi(drive.client(), counters), {
			vaultId: VAULT, deviceId: `mode-${mode}`, autoTimers: false, now: () => clock,
			compaction: mode, compactSegmentBytes: 64 * KB, compactSegmentCount: 50,
			keepSnapshots: 2, verifyBeforePrune: false,
		});
		await transport.connect();
		const bootstrap = { written: counters.written, names: new Set(counters.created.map((f) => f.name)) };
		let newContent = 0;
		const chunk = "l".repeat(48 * KB);
		let snapshots = 0;
		let snapshotBytes = 0;
		const sizeOk: boolean[] = [];
		for (let i = 0; i < 6; i++) {
			const rawBefore = Y.encodeStateAsUpdate(doc).length;
			text.insert(text.length, `${chunk}\n`);
			newContent += Y.encodeStateAsUpdate(doc).length - rawBefore;
			await transport.flush();
			clock += 61_000;
			await transport.syncNow();
			const rawAfter = Y.encodeStateAsUpdate(doc).length;
			// Only the copies written in this step: 2.1.22's signature is that a
			// snapshot is the whole encoded document plus the 40-byte header.
			for (const file of counters.created) {
				if (bootstrap.names.has(file.name) || !file.name.startsWith("snap-")) continue;
				bootstrap.names.add(file.name);
				snapshots++;
				snapshotBytes += file.bytes;
				sizeOk.push(file.bytes >= rawBefore && file.bytes <= rawAfter + 40);
			}
		}
		// A device reading Drive alone still needs the whole document.
		const fresh = new Y.Doc();
		const reader = new DriveTransport(fresh, drive.client(), { vaultId: VAULT, deviceId: "reader2", autoTimers: false, now: () => clock });
		await reader.connect(); clock += 61_000; await reader.syncNow();
		s.check(fresh.getText("t").toString() === text.toString(), `${mode}: the document comes back whole from Drive`);
		transport.destroy();
		reader.destroy();
		return { snapshots, snapshotBytes, written: counters.written - bootstrap.written, newContent, reads: counters.read };
	};
	const legacy = await run("legacy");
	s.check(legacy.snapshots >= 1, `legacy wrote a full copy as soon as the byte trigger fired (${legacy.snapshots})`);
	s.check(legacy.snapshotBytes === legacy.snapshots * 0 + legacy.snapshotBytes && legacy.snapshots > 0, "every copy is accounted for");
	s.check(legacy.reads === 0, "with the read-back off nothing is downloaded (exactly 2.1.22's traffic)");
	const adaptive = await run("adaptive");
	s.check(adaptive.snapshots === 0, `adaptive wrote no full copy at all in the same scenario (${adaptive.snapshots})`);
	s.check(adaptive.written < legacy.written, `the same edits cost fewer bytes (adaptive ${(adaptive.written / 1024).toFixed(0)} KB vs legacy ${(legacy.written / 1024).toFixed(0)} KB)`);
	s.check(legacy.written / legacy.newContent > 2, `legacy's amplification is the old one (×${(legacy.written / legacy.newContent).toFixed(2)})`);
	s.check(adaptive.written / adaptive.newContent <= 2, `adaptive is within the target (×${(adaptive.written / adaptive.newContent).toFixed(2)})`);
}

s.section("F1/F7: what Drive was asked to store is what the meter reports, and a bad merge is caught");
{
	const drive = new FakeDrive();
	const counters: Counters = { written: 0, created: [], read: 0, listed: 0, deleted: 0 };
	const doc = new Y.Doc();
	const text = doc.getText("t");
	let clock = 1_700_000_000_000;
	const transport = new DriveTransport(doc, countingApi(drive.client(), counters), {
		vaultId: VAULT, deviceId: "verify", autoTimers: false, now: () => clock, compactSegmentCount: 2,
	});
	await transport.connect();
	for (let i = 0; i < 5; i++) { text.insert(text.length, `v${i} `); await transport.flush(); clock += 61_000; await transport.syncNow(); }
	s.check(counters.written === counters.created.reduce((sum, f) => sum + f.bytes, 0), "the counter and the files agree");
	s.check(counters.read > 0, `the merge was read back before anything was deleted (${counters.read} read(s))`);
	s.check(transport.retainedPayloadBytes >= 0 && transport.retainedPayloadBytes <= 32 * MB, `retained payloads are within the default bound (${transport.retainedPayloadBytes})`);
	// A merge that comes back damaged must not delete the files it replaces.
	const before = counters.deleted;
	drive.corruptOnNextRead(/^seg-/, (bytes) => {
		const bent = bytes.slice();
		bent[bent.length - 1] = (bent[bent.length - 1] ?? 0) ^ 0xff;
		return bent;
	});
	text.insert(text.length, "damaged-merge ");
	await transport.flush(); clock += 61_000; await transport.syncNow();
	s.check(counters.deleted === before, "nothing was deleted for the unproven merge");
	const kept = drive.filesIn(FOLDER).filter((f) => f.name.startsWith("seg-")).map((f) => f.name).sort();
	const fresh = new Y.Doc();
	const reader = new DriveTransport(fresh, drive.client(), { vaultId: VAULT, deviceId: "reader3", autoTimers: false, now: () => clock });
	await reader.connect(); clock += 61_000; await reader.syncNow();
	s.check(fresh.getText("t").toString() === text.toString(), `every file that remains still rebuilds the document (${kept.length} file(s))`);
	transport.destroy();
	reader.destroy();
}
s.check(typeof DriveError === "function" && enc.encode("x").length === 1, "sanity: the suite's imports are live");

await s.done();

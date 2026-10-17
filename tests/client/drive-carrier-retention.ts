/**
 * Drive carrier: retention and deletion safety (F6).
 *
 * Three questions, each with its own section:
 *   - a compaction may only delete the sync files it covers once the restore
 *     point it just wrote has been read back and proven (verify-before-prune);
 *   - how many restore points a compaction keeps is a setting, and the file it
 *     keeps are the newest by Drive's own creation time;
 *   - restore-point cleanup never removes the newest readable snapshot, and the
 *     attachment check is a dry run with no delete path at all.
 */
import * as Y from "yjs";
import { DriveBlobStore } from "../../src/drive-carrier/driveBlobStore";
import { DriveKeyring } from "../../src/drive-carrier/driveKeyring";
import {
	DEFAULT_KEEP_SNAPSHOTS,
	DriveTransport,
	KEEP_SNAPSHOTS_MAX,
	KEEP_SNAPSHOTS_MIN,
	clampKeepSnapshots,
	type DriveTransportOptions,
} from "../../src/drive-carrier/driveTransport";
import { DriveSnapshotBackend, snapshotFolderName } from "../../src/drive-carrier/driveSnapshotBackend";
import { sha256Hex } from "../../src/drive-carrier/driveFolders";
import { FakeDrive } from "../mocks/fakeDrive";
import { suite } from "../harness.ts";

const s = suite("drive-carrier-retention");
const VAULT = "v1";
const FOLDER = `YAOS ${VAULT}`;
const SNAP_FOLDER = snapshotFolderName(VAULT);
const enc = new TextEncoder();

interface Dev { name: string; doc: Y.Doc; text: Y.Text; t: DriveTransport; clock: { now: number }; logs: string[]; notices: string[] }
function dev(drive: FakeDrive, name: string, start: number, extra: Partial<DriveTransportOptions> = {}): Dev {
	const doc = new Y.Doc();
	const clock = { now: start };
	const logs: string[] = [];
	const notices: string[] = [];
	const t = new DriveTransport(doc, drive.client(), {
		vaultId: VAULT,
		deviceId: name,
		autoTimers: false,
		now: () => clock.now,
		log: (m) => logs.push(m),
		onNotice: (m) => notices.push(m),
		// This suite is about restore points (snapshots). F1's adaptive default
		// would merge small folders instead, so the snapshot tier is pinned here;
		// drive-carrier-compaction-cost covers the adaptive default.
		compaction: "legacy",
		...extra,
	});
	return { name, doc, text: doc.getText("t"), t, clock, logs, notices };
}
const cycle = async (d: Dev, adv = 61_000): Promise<void> => { d.clock.now += adv; await d.t.syncNow(); };
const names = (drive: FakeDrive, folder = FOLDER) => drive.namesIn(folder);
const segs = (drive: FakeDrive) => names(drive).filter((n) => n.startsWith("seg-"));
const snaps = (drive: FakeDrive) => names(drive).filter((n) => n.startsWith("snap-"));

s.section("F6.1: a restore point that cannot be read back stops the deletion of every segment");
{
	const drive = new FakeDrive();
	const A = dev(drive, "A", 1_700_000_000_000, { compactSegmentCount: 2, reconcileIntervalMs: 0 });
	await A.t.connect();
	A.text.insert(0, "one ");
	await cycle(A);
	A.text.insert(A.text.length, "two ");
	await cycle(A);
	s.check(segs(drive).length === 2, `two segments are waiting to be compacted (${segs(drive).length})`);
	// The next compaction's snapshot comes back damaged once: a bad download, not a bad file.
	drive.corruptOnNextRead(/^snap-/, (bytes) => {
		const bent = bytes.slice();
		bent[bent.length - 1] = (bent[bent.length - 1] ?? 0) ^ 0xff;
		return bent;
	});
	const deletesBefore = drive.calls.deleteFile;
	A.text.insert(A.text.length, "three");
	await cycle(A);
	s.check(snaps(drive).length === 1, "the snapshot was written");
	s.check(segs(drive).length === 3, "no segment was deleted on the unproven snapshot");
	s.check(drive.calls.deleteFile === deletesBefore, "no delete was even attempted");
	s.check(A.logs.some((m) => m.includes("keeping every segment")), "the reason is logged");
	s.check(A.notices.some((m) => m.includes("could not be read back")), "and surfaced once as a notice");
	s.check(A.t.unreadableFiles === 0, "the vault is not reported as damaged");
	s.check(A.text.toString() === "one two three", "editing continues");
	// Healthy again: the next compaction proves its snapshot and then deletes.
	await cycle(A);
	s.check(segs(drive).length === 0, "the retry deleted the segments it covered");
	s.check(snaps(drive).length === 2, "both restore points are kept (default keeps 4)");
	const C = dev(drive, "C", 1_700_000_900_000, { reconcileIntervalMs: 0 });
	await C.t.connect();
	await cycle(C);
	s.check(C.text.toString() === "one two three", "a new device still reads the whole document");
	A.t.destroy(); C.t.destroy();
}

s.section("F6.2: a delete that fails mid-compaction leaves the rest for the next cycle");
{
	const drive = new FakeDrive();
	const A = dev(drive, "A", 1_700_000_000_000, { compactSegmentCount: 2, reconcileIntervalMs: 0 });
	await A.t.connect();
	for (const word of ["a ", "b "]) { A.text.insert(A.text.length, word); await cycle(A); }
	s.check(segs(drive).length === 2, "two segments waiting, so the next flush compacts");
	drive.failNext("deleteFile", 503, 1);
	A.text.insert(A.text.length, "c ");
	await cycle(A);
	s.check(snaps(drive).length === 1, "the snapshot made it");
	const leftAfterFailure = segs(drive).length;
	s.check(leftAfterFailure === 1, `only the failed delete was left undone (${leftAfterFailure} left)`);
	A.text.insert(A.text.length, "d ");
	await cycle(A);
	A.text.insert(A.text.length, "e ");
	await cycle(A);
	s.check(segs(drive).length === 0, "a later compaction finishes the job");
	const C = dev(drive, "C", 1_700_000_900_000, { reconcileIntervalMs: 0 });
	await C.t.connect();
	await cycle(C);
	s.check(C.text.toString() === "a b c d e ", "the document is whole after the failed delete");
	A.t.destroy(); C.t.destroy();
}

s.section("F6.3: the retention count is a setting, and the newest restore points are the ones kept");
{
	interface Run { kept: string[]; produced: { name: string; created: number }[] }
	const run = async (keep: number | undefined, edits: number): Promise<Run> => {
		const drive = new FakeDrive();
		const A = dev(drive, "A", 1_700_000_000_000, { compactSegmentCount: 1, reconcileIntervalMs: 0, keepSnapshots: keep });
		await A.t.connect();
		const produced = new Map<string, number>();
		for (let i = 0; i < edits; i++) {
			A.text.insert(A.text.length, `${i} `);
			await cycle(A);
			for (const file of drive.filesIn(FOLDER)) if (file.name.startsWith("snap-")) produced.set(file.name, file.createdTime);
		}
		const kept = snaps(drive);
		A.t.destroy();
		const order = Array.from(produced.entries()).map(([name, created]) => ({ name, created })).sort((a, b) => a.created - b.created);
		return { kept, produced: order };
	};
	const two = await run(2, 10);
	s.check(two.kept.length === 2, `keepSnapshots 2 keeps two (${two.kept.length})`);
	s.check(two.produced.length > 2, "the run really wrote more snapshots than were kept");
	s.check(new Set(two.kept).size === 2 && two.kept.every((n) => two.produced.some((p) => p.name === n)), "the kept files are snapshots this run wrote");
	const newestTwo = two.produced.slice(-2).map((p) => p.name);
	s.check(newestTwo.every((n) => two.kept.includes(n)), "the two newest by Drive's creation time are the ones kept");
	const ten = await run(10, 10);
	s.check(ten.kept.length === ten.produced.length && ten.kept.length >= 4, `keepSnapshots 10 keeps everything written (${ten.kept.length})`);
	const four = await run(undefined, 10);
	s.check(four.kept.length === DEFAULT_KEEP_SNAPSHOTS, `the default keeps ${DEFAULT_KEEP_SNAPSHOTS} (${four.kept.length})`);
	s.check(clampKeepSnapshots(undefined) === DEFAULT_KEEP_SNAPSHOTS, "an unset setting means the default");
	s.check(clampKeepSnapshots(0) === KEEP_SNAPSHOTS_MIN && clampKeepSnapshots(99) === KEEP_SNAPSHOTS_MAX, "out-of-range values are clamped to 2..10");
	s.check(KEEP_SNAPSHOTS_MIN === 2, "2 restores exactly what 2.1.22 kept");
}

s.section("F6.4: the escape hatch restores the old behaviour exactly (no read back, size check only)");
{
	const drive = new FakeDrive();
	const A = dev(drive, "A", 1_700_000_000_000, { compactSegmentCount: 2, reconcileIntervalMs: 0, verifyBeforePrune: false });
	await A.t.connect();
	for (const word of ["x ", "y "]) { A.text.insert(A.text.length, word); await cycle(A); }
	s.check(segs(drive).length === 2 && snaps(drive).length === 0, "two segments are waiting, nothing was compacted yet");
	drive.corruptOnNextRead(/^snap-/, (bytes) => {
		const bent = bytes.slice();
		bent[bent.length - 1] = (bent[bent.length - 1] ?? 0) ^ 0xff;
		return bent;
	});
	A.text.insert(A.text.length, "z ");
	const readsBefore = drive.calls.readFile;
	await cycle(A);
	s.check(segs(drive).length === 0, "with the check off the segments are deleted without a read back, as 2.1.22 did");
	s.check(drive.calls.readFile === readsBefore, "and nothing was read back in that cycle");
	A.t.destroy();
}

s.section("F6.5: restore-point cleanup never removes the newest readable snapshot");
{
	const doc = new Y.Doc();
	const makeBackend = (drive: FakeDrive, now: number) =>
		new DriveSnapshotBackend(drive.client(), { vaultId: VAULT, getDoc: () => doc, now: () => now });
	const manufactured = async (drive: FakeDrive, times: number[]): Promise<string> => {
		const backend = makeBackend(drive, times[0] ?? 0);
		await backend.list(); // creates the snapshots folder
		const folder = Array.from(drive.folders.values()).find((f) => f.name === SNAP_FOLDER);
		if (!folder) throw new Error("snapshots folder was not created");
		let n = 0;
		for (const createdAt of times) {
			const id = `s${String(n++).padStart(3, "0")}`;
			const at = new Date(createdAt).toISOString();
			const index = {
				snapshotId: id, vaultId: VAULT, createdAt: at, day: at.slice(0, 10),
				markdownFileCount: 1, blobFileCount: 0, crdtSizeBytes: 10, crdtRawSizeBytes: 10,
				referencedBlobHashes: [] as string[],
			};
			const dataName = `snapdat-${id}.bin`;
			drive.files.set(`f-${id}-data`, { id: `f-${id}-data`, name: dataName, parent: folder.id, data: enc.encode("data"), createdTime: createdAt });
			drive.files.set(`f-${id}-index`, { id: `f-${id}-index`, name: `snapidx-${id}.json`, parent: folder.id, data: enc.encode(JSON.stringify(index)), createdTime: createdAt });
		}
		return folder.id;
	};
	{
		const drive = new FakeDrive();
		const times = Array.from({ length: 16 }, (_, i) => 1_700_000_000_000 + i * 86_400_000);
		await manufactured(drive, times);
		const backend = makeBackend(drive, times[15] ?? 0);
		const res = await backend.prune();
		s.check(res.pruned === 2 && res.kept === 14, `14 unpinned snapshots are kept (${JSON.stringify(res)})`);
		const left = await backend.list();
		const newest = times[15];
		s.check(left.some((x) => x.createdAt === new Date(newest ?? 0).toISOString()), "the newest is still there");
		s.check(new Set(left.map((x) => x.snapshotId)).size === 14, "and it is 14 distinct snapshots");
	}
	{
		// No snapshot is strictly newer than any other (one timestamp for all): the safe answer is to keep every one.
		const drive = new FakeDrive();
		const times = Array.from({ length: 16 }, () => 1_700_000_000_000);
		await manufactured(drive, times);
		const backend = makeBackend(drive, 1_700_000_000_000);
		const res = await backend.prune();
		s.check(res.pruned === 0 && res.kept === 16, `nothing is pruned when no readable snapshot is strictly newer (${JSON.stringify(res)})`);
		s.check((await backend.list()).length === 16, "every restore point survived");
	}
	{
		// The newest index is unreadable: its data file is not orphaned away, and the readable older ones stay.
		const drive = new FakeDrive();
		const times = Array.from({ length: 16 }, (_, i) => 1_700_000_000_000 + i * 86_400_000);
		const folderId = await manufactured(drive, times.slice(0, 15));
		const at = new Date(times[15] ?? 0).toISOString();
		drive.files.set("f-broken-data", { id: "f-broken-data", name: "snapdat-broken.bin", parent: folderId, data: enc.encode("data"), createdTime: times[15] ?? 0 });
		drive.files.set("f-broken-index", { id: "f-broken-index", name: "snapidx-broken.json", parent: folderId, data: enc.encode(`{ not json, ${at}`), createdTime: times[15] ?? 0 });
		const backend = makeBackend(drive, (times[15] ?? 0) + 86_400_000);
		await backend.prune();
		s.check(names(drive, SNAP_FOLDER).includes("snapdat-broken.bin"), "an unreadable index does not lose its data file");
		s.check((await backend.list()).length === 14, "and the newest readable snapshots are kept");
	}
	doc.destroy();
}

s.section("F6.6: the attachment check lists what nothing refers to and deletes nothing");
{
	const drive = new FakeDrive();
	const store = new DriveBlobStore(drive.client(), { vaultId: VAULT });
	const hashes: string[] = [];
	for (const text of ["first attachment", "second attachment", "third attachment"]) {
		const hash = await sha256Hex(enc.encode(text));
		hashes.push(hash);
		await store.upload(hash, "text/plain", enc.encode(text).buffer as ArrayBuffer, 5000);
	}
	const orphaned = hashes[2] as string;
	const audit = await store.audit([hashes[0] as string, hashes[1] as string]);
	s.check(audit.stored === 3 && audit.referenced === 2 && audit.missing === 0, `three stored, two referenced (${JSON.stringify({ stored: audit.stored, referenced: audit.referenced, missing: audit.missing })})`);
	s.check(audit.unused.length === 1 && audit.unused[0]?.name === orphaned, "the unreferenced one is named by its stored name");
	s.check(audit.unusedBytes === audit.unused[0]?.size, "the byte count matches the listed file");
	s.check(drive.calls.deleteFile === 0, "the check deleted nothing");
	const all = await store.audit(hashes);
	s.check(all.unused.length === 0, "with every hash referenced nothing is unused");
	const absent = await store.audit([...hashes, await sha256Hex(enc.encode("never uploaded"))]);
	s.check(absent.missing === 1, "a referenced attachment that is not on Drive is reported missing, not unused");
	// A restore point that still refers to a blob keeps it off the unused list.
	const withSnapshot = await store.audit([hashes[0] as string, orphaned]);
	s.check(withSnapshot.unused.map((u) => u.name).join() === hashes[1], `a blob a retained restore point still refers to is not called unused (unused: ${withSnapshot.unused.length})`);
// Encrypted vault, its own drive: the file is found even though its name is keyed.
const encDrive = new FakeDrive();
const ring = new DriveKeyring(encDrive.client(), { vaultId: VAULT, passphrase: "pw", kdfIterations: 1000 });
const sealed = new DriveBlobStore(encDrive.client(), { vaultId: VAULT, keyring: ring });
const kept = await sha256Hex(enc.encode("kept attachment"));
const gone = await sha256Hex(enc.encode("unreferenced attachment"));
await sealed.upload(kept, "text/plain", enc.encode("kept attachment").buffer as ArrayBuffer, 5000);
await sealed.upload(gone, "text/plain", enc.encode("unreferenced attachment").buffer as ArrayBuffer, 5000);
const sealedAudit = await sealed.audit([kept]);
s.check(sealedAudit.stored === 2 && sealedAudit.referenced === 1 && sealedAudit.unused.length === 1, `the unreferenced encrypted attachment is found (${JSON.stringify({ stored: sealedAudit.stored, referenced: sealedAudit.referenced, unused: sealedAudit.unused.length })})`);
s.check(sealedAudit.unused[0]?.name !== gone && /^[0-9a-f]{64}$/.test(sealedAudit.unused[0]?.name ?? ""), "under its keyed name, never the plain hash");
s.check((await sealed.audit([kept, gone])).unused.length === 0, "referencing both leaves nothing unused");
s.check(encDrive.calls.deleteFile === 0, "still nothing deleted");
}

await s.done();

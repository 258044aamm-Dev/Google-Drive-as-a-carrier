/**
 * Drive carrier: memory bounding (F7).
 *
 * `known` used to keep the payload of every applied file for the whole session,
 * so a vault that had applied 200 MB of updates held 200 MB in memory next to
 * the document and the retained snapshots. Now a payload is kept only while it
 * is needed to rebuild what Drive holds: a later snapshot drops the files it
 * covers, a hard bound (default 32 MB) evicts the oldest, and a rebuild reads an
 * evicted payload back from Drive instead of assuming it is gone.
 */
import * as Y from "yjs";
import { DriveTransport, type DriveTransportOptions } from "../../src/drive-carrier/driveTransport";
import { FakeDrive } from "../mocks/fakeDrive";
import { suite } from "../harness.ts";

const s = suite("drive-carrier-memory");
const KB = 1024;
const MB = 1024 * KB;
const VAULT = "mem";
const FOLDER = `YAOS ${VAULT}`;

interface Dev { name: string; doc: Y.Doc; text: Y.Text; t: DriveTransport; clock: { now: number }; logs: string[] }
function dev(drive: FakeDrive, name: string, start: number, extra: Partial<DriveTransportOptions> = {}): Dev {
	const doc = new Y.Doc();
	const clock = { now: start };
	const logs: string[] = [];
	const t = new DriveTransport(doc, drive.client(), {
		vaultId: VAULT,
		deviceId: name,
		autoTimers: false,
		now: () => clock.now,
		log: (m) => logs.push(m),
		...extra,
	});
	return { name, doc, text: doc.getText("t"), t, clock, logs };
}
const cycle = async (d: Dev, adv = 61_000): Promise<void> => { d.clock.now += adv; await d.t.syncNow(); };
const freshDevice = (drive: FakeDrive, name: string, start: number): Dev => dev(drive, name, start, { reconcileIntervalMs: 0 });

s.section("F7: a tiny bound holds at every step, and nothing else changes");
{
	// Every payload is larger than the whole budget: the carrier must work with an
	// empty payload cache and re-read what it needs.
	const drive = new FakeDrive();
	const A = dev(drive, "A", 1_700_000_000_000, { maxRetainedPayloadBytes: KB, compactSegmentCount: 4, verifyBeforePrune: false });
	await A.t.connect();
	const chunk = "m".repeat(4 * KB);
	for (let i = 0; i < 6; i++) {
		A.text.insert(A.text.length, `${chunk}\n`);
		await cycle(A);
		s.check(A.t.retainedPayloadBytes <= KB, `retained payloads stay under the bound (${A.t.retainedPayloadBytes} bytes after ${i + 1} edit(s))`);
	}
	const segs = drive.filesIn(FOLDER).filter((f) => f.name.startsWith("seg-"));
	s.check(segs.length <= 4, `the folder is still tidied while payloads are thrown away (${segs.length} file(s))`);
	s.check(drive.calls.readFile > 0, `payloads were read back instead of kept (${drive.calls.readFile} read(s))`);
	s.check(A.t.unreadableFiles === 0, "nothing was mistaken for damage");
	const B = freshDevice(drive, "B", 1_700_000_900_000);
	await B.t.connect();
	await cycle(B);
	s.check(B.text.toString() === A.text.toString(), "a new device still receives the whole document");
	A.t.destroy();
	B.t.destroy();
}

s.section("F7: a rebuild reads evicted payloads back, and the repair pass stays quiet");
{
	const drive = new FakeDrive();
	const A = dev(drive, "A", 1_700_000_000_000, { maxRetainedPayloadBytes: 64, compactSegmentCount: 3, verifyBeforePrune: false });
	await A.t.connect();
	const chunk = "r".repeat(2 * KB);
	for (let i = 0; i < 4; i++) {
		A.text.insert(A.text.length, `${chunk}\n`);
		await cycle(A);
	}
	s.check(A.t.retainedPayloadBytes <= 64, `nothing is retained under a 64-byte budget (${A.t.retainedPayloadBytes})`);
	// The next edit pushes the folder over its cap: files are merged (their payloads
	// are read back first), the files they replaced are deleted, and the picture of
	// Drive is rebuilt from what is left.
	const readsBefore = drive.calls.readFile;
	A.text.insert(A.text.length, `${chunk}\n`);
	await cycle(A);
	s.check(drive.calls.readFile > readsBefore, `evicted payloads were read back when they were needed (${drive.calls.readFile - readsBefore} read(s))`);
	const createsBefore = drive.calls.createFile;
	await A.t.reconcile();
	s.check(drive.calls.createFile === createsBefore, "the repair pass then has nothing to upload: the picture of Drive was complete");
	await cycle(A);
	s.check(drive.calls.createFile === createsBefore, "and neither has the next one");
	const B = freshDevice(drive, "B", 1_700_000_900_000);
	await B.t.connect();
	await cycle(B);
	s.check(B.text.toString() === A.text.toString(), "the document still comes back from Drive alone");
	A.t.destroy();
	B.t.destroy();
}

s.section("F7: a snapshot drops the payloads of the files it covers");
{
	// A device writes a snapshot, but every delete fails (a Drive outage right after
	// the upload), so the snapshot and the change files it covers stay on Drive
	// together. A device joining afterwards must not hold both in memory.
	const drive = new FakeDrive();
	const A = dev(drive, "A", 1_700_000_000_000, {
		compactSegmentCount: 2, compactSegmentBytes: 1 * KB, compaction: "legacy", verifyBeforePrune: false,
	});
	await A.t.connect();
	const chunk = "c".repeat(20 * KB);
	drive.failNext("deleteFile", 503, 10);
	for (let i = 0; i < 4; i++) {
		A.text.insert(A.text.length, `${chunk}\n`);
		await cycle(A);
	}
	const snaps = drive.filesIn(FOLDER).filter((f) => f.name.startsWith("snap-"));
	const segs = drive.filesIn(FOLDER).filter((f) => f.name.startsWith("seg-"));
	s.check(snaps.length >= 1 && segs.length >= 2, `the setup really has a snapshot beside the files it covers (${snaps.length} snapshot(s), ${segs.length} segments)`);
	// The newest snapshot is the one a rebuild needs; the older ones are covered by it.
	const snapshotBytes = Math.max(...snaps.map((f) => f.data.length));
	const segBytes = segs.reduce((sum, f) => sum + f.data.length, 0);
	const B = freshDevice(drive, "B", 1_700_000_900_000);
	await B.t.connect();
	await cycle(B);
	s.check(B.text.toString() === A.text.toString(), "the joining device received the whole document");
	s.check(B.t.retainedPayloadBytes <= snapshotBytes + segBytes / 4, `it does not hold the covered files' payloads as well (${B.t.retainedPayloadBytes} bytes; snapshot ${snapshotBytes} + segments ${segBytes})`);
	s.check(B.t.retainedPayloadBytes >= snapshotBytes - 64, `it does hold the newest snapshot, which is what a rebuild needs (${B.t.retainedPayloadBytes} vs ${snapshotBytes})`);
	const createsBefore = drive.calls.createFile;
	await B.t.reconcile();
	s.check(drive.calls.createFile === createsBefore, "and it still needs no repair upload");
	A.t.destroy();
	B.t.destroy();
}

s.section("F7: the defaults, and what the numbers say");
{
	const drive = new FakeDrive();
	const A = dev(drive, "A", 1_700_000_000_000);
	await A.t.connect();
	A.text.insert(0, "hello");
	await cycle(A);
	s.check(A.t.retainedPayloadBytes <= 32 * MB, `the default bound is 32 MB, and a small vault is far below it (${A.t.retainedPayloadBytes} bytes)`);
	s.check(A.t.retainedPayloadBytes > 0, "and it does keep what it can: a rebuild then needs no request");
	s.check(A.t.knownFiles === drive.filesIn(FOLDER).length - 1, `the known-file count matches the folder apart from meta.json (${A.t.knownFiles} vs ${drive.filesIn(FOLDER).length})`);
	s.check(A.t.unreadableFiles === 0, "nothing is unreadable");
	const B = freshDevice(drive, "B", 1_700_000_900_000);
	await B.t.connect();
	await cycle(B);
	s.check(B.text.toString() === "hello" && B.t.retainedPayloadBytes > 0 && B.t.retainedPayloadBytes <= 32 * MB, "a joining device bounds its payloads too");
	A.t.destroy();
	B.t.destroy();
}

await s.done();

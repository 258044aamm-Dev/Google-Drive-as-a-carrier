/**
 * Drive carrier: regressions for the CRDT audit (F1-F6), each reproduced first
 * against the earlier code. See docs/drive-carrier.md ("Hardening").
 */
import * as Y from "yjs";
import { DEFAULT_KEEP_SNAPSHOTS, DriveTransport, type DriveTransportOptions } from "../../src/drive-carrier/driveTransport";
import { DriveKeyring } from "../../src/drive-carrier/driveKeyring";
import { decodeFile } from "../../src/drive-carrier/fileFormat";
import { readPendingState } from "../../src/drive-carrier/yjsPending";
import { FakeDrive } from "../mocks/fakeDrive";
import { suite } from "../harness.ts";

const s = suite("drive-carrier-hardening");
const VAULT = "v1";
const FOLDER = `YAOS ${VAULT}`;

interface Dev { name: string; doc: Y.Doc; text: Y.Text; t: DriveTransport; clock: { now: number }; logs: string[] }
function dev(drive: FakeDrive, name: string, start: number, extra: Partial<DriveTransportOptions> = {}): Dev {
	const doc = new Y.Doc();
	const clock = { now: start };
	const logs: string[] = [];
	const t = new DriveTransport(doc, drive.client(), { vaultId: VAULT, deviceId: name, autoTimers: false, now: () => clock.now, log: (m) => logs.push(m), ...extra });
	return { name, doc, text: doc.getText("t"), t, clock, logs };
}
const cycle = async (d: Dev, adv = 61_000): Promise<void> => { d.clock.now += adv; await d.t.syncNow(); };
const names = (drive: FakeDrive) => drive.namesIn(FOLDER);
const sv = (d: Y.Doc) => JSON.stringify(Array.from(Y.decodeStateVector(Y.encodeStateVector(d)).entries()));

s.section("F1: a failed key check at connect never lets plaintext reach an encrypted vault");
{
	const drive = new FakeDrive();
	const mk = (name: string): Dev => dev(drive, name, 1_700_000_000_000, { reconcileIntervalMs: 0, keyring: new DriveKeyring(drive.client(), { vaultId: VAULT, passphrase: "secret pw", kdfIterations: 1000 }) });
	const A = mk("A");
	await A.t.connect();
	A.text.insert(0, "top secret note");
	await cycle(A);
	const B = mk("B");
	drive.failNext("readFile", 503, 1); // B's first read of meta.json
	await B.t.connect();
	s.check(!B.t.wsconnected, "B is not connected after the failed key check");
	B.text.insert(0, "B's private words");
	await cycle(B); // retries the whole preparation
	await cycle(B);
	let plain = 0;
	for (const f of drive.filesIn(FOLDER)) {
		if (!/^seg-|^snap-/.test(f.name)) continue;
		if (!(await decodeFile(f.data)).encrypted) plain++;
	}
	s.check(plain === 0, `nothing is stored unencrypted in an encrypted vault (plaintext files: ${plain})`);
	await cycle(A);
	s.check(A.text.toString().includes("B's private words"), "A receives B's edit (it was uploaded encrypted after the retry)");
	s.check(B.text.toString().includes("top secret note"), "B receives A's note and does not mark A's files damaged");
	s.check(B.t.unreadableFiles === 0, "no file is counted unreadable");
	A.t.destroy(); B.t.destroy();
}

s.section("F1b: the first meta.json write failing does not leave an unusable vault");
{
	const drive = new FakeDrive();
	const A = dev(drive, "A", 1_700_000_000_000, { reconcileIntervalMs: 0, keyring: new DriveKeyring(drive.client(), { vaultId: VAULT, passphrase: "pw", kdfIterations: 1000 }) });
	drive.failNext("createFile", 503, 1);
	await A.t.connect();
	A.text.insert(0, "first words");
	await cycle(A); await cycle(A);
	const meta = drive.filesIn(FOLDER).filter((f) => f.name === "meta.json").length;
	s.check(meta === 1, `meta.json exists exactly once (${meta})`);
	const C = dev(drive, "C", 1_700_000_100_000, { reconcileIntervalMs: 0, keyring: new DriveKeyring(drive.client(), { vaultId: VAULT, passphrase: "pw", kdfIterations: 1000 }) });
	await C.t.connect(); await cycle(C);
	s.check(C.text.toString() === "first words", "a second device with the passphrase reads the text");
	A.t.destroy(); C.t.destroy();
}

s.section("F2: a device whose clock runs ahead cannot make snapshot pruning delete the newest data");
{
	const drive = new FakeDrive();
	// Snapshots are this test's subject: F1's adaptive default would merge instead,
	// so ask for the tier that always writes one.
	const A = dev(drive, "A", 1_700_000_000_000, { compactSegmentCount: 2, reconcileIntervalMs: 0, compaction: "legacy" });
	const B = dev(drive, "B", 2_200_000_000_000, { compactSegmentCount: 2, reconcileIntervalMs: 0, compaction: "legacy" });
	await A.t.connect(); await B.t.connect();
	for (let i = 0; i < 4; i++) { B.text.insert(B.text.length, `b${i} `); await cycle(B); }
	await cycle(B, 40_000);
	for (let i = 0; i < 4; i++) { B.text.insert(B.text.length, `B${i} `); await cycle(B); }
	await cycle(B, 40_000);
	await cycle(A);
	for (let i = 0; i < 6; i++) { A.text.insert(A.text.length, `a${i} `); await cycle(A); }
	await cycle(A, 40_000);
	const C = dev(drive, "C", 1_700_000_100_000);
	await C.t.connect(); await cycle(C);
	s.check(C.text.toString() === A.text.toString(), "a new device reading only Drive gets everything A and B wrote");
	const before = names(drive).join(",");
	await A.t.reconcile();
	s.check(names(drive).join(",") === before, "after its own deletions A needs no repair upload: its picture of Drive is right");
	const C2 = dev(drive, "C2", 1_700_000_200_000, { compaction: "legacy" });
	await C2.t.connect(); await cycle(C2);
	s.check(sv(C2.doc) === sv(A.doc), "Drive holds everything A holds (receipts rely on it)");
	C2.t.destroy();
	const snaps = names(drive).filter((n) => n.startsWith("snap-"));
	s.check(snaps.length <= DEFAULT_KEEP_SNAPSHOTS && snaps.length >= 1, `snapshots are pruned to the default retention (${snaps.length})`);
	A.t.destroy(); B.t.destroy(); C.t.destroy();
}

s.section("F3: 'synced' is not reported with an incomplete document");
{
	// a) a file vanishes between listing and reading during the first connect
	const drive = new FakeDrive();
	const A = dev(drive, "A", 1_700_000_000_000, { compactSegmentCount: 100, reconcileIntervalMs: 0 });
	await A.t.connect();
	for (let i = 0; i < 5; i++) { A.text.insert(A.text.length, `n${i} `); await cycle(A, 1000); }
	const C = dev(drive, "C", 1_700_000_500_000);
	let seenAtSync: string | null = null;
	C.t.on("sync", (v: boolean) => { if (v) seenAtSync = C.text.toString(); });
	// Another device compacts while C is part-way through its first read.
	const A2 = dev(drive, "A2", 1_700_000_300_000, { compactSegmentCount: 2, reconcileIntervalMs: 0 });
	let reads = 0; let triggered = false;
	drive.latencyHook = async (op) => {
		if (op === "readFile" && ++reads === 2 && !triggered) {
			triggered = true; drive.latencyHook = null;
			await A2.t.connect();
			await cycle(A2, 40_000);
		}
	};
	await C.t.connect();
	s.check(seenAtSync === A.text.toString(), `the document is complete when 'sync' fires (saw ${JSON.stringify(seenAtSync)})`);
	A.t.destroy(); A2.t.destroy(); C.t.destroy();
}
{
	// b) a segment deleted in the Drive web page: the joiner must not claim to be synced
	const drive = new FakeDrive();
	const A = dev(drive, "A", 1_700_000_000_000, { compactSegmentCount: 100, reconcileIntervalMs: 0 });
	await A.t.connect();
	for (let i = 0; i < 4; i++) { A.text.insert(A.text.length, `w${i} `); await cycle(A, 1000); }
	const segs = names(drive).filter((n) => n.startsWith("seg-"));
	drive.remove(segs[1] as string);
	A.t.destroy();
	const C = dev(drive, "C", 1_700_000_900_000);
	let synced = false;
	C.t.on("sync", (v: boolean) => { if (v) synced = true; });
	await C.t.connect(); await cycle(C);
	const pending = C.doc.store.pendingStructs;
	s.check(pending !== null, "the test setup really leaves an update that cannot be applied");
	s.check(!synced && !C.t.synced, "an incomplete device does not claim to be synced");
	s.check(C.t.wsconnected, "it stays connected, so its own edits still upload");
	s.check(typeof C.t.lastError === "string" && C.t.lastError.length > 0, "and the reason is available as the last error");
	C.text.insert(0, "mine ");
	await cycle(C);
	s.check(names(drive).some((n) => n.includes("-C-")), "its edit reached Drive");
	C.t.destroy();
}

s.section("F3b: damaged or unreadable files are counted");
{
	const drive = new FakeDrive();
	const A = dev(drive, "A", 1_700_000_000_000, { reconcileIntervalMs: 0 });
	await A.t.connect();
	A.text.insert(0, "hello"); await cycle(A);
	const seg = names(drive).find((n) => n.startsWith("seg-")) as string;
	drive.corrupt(seg, (d) => { d[d.length - 1] = (d[d.length - 1] ?? 0) ^ 0xff; return d; });
	const B = dev(drive, "B", 1_700_000_100_000, { reconcileIntervalMs: 0 });
	await B.t.connect(); await cycle(B);
	s.check(B.t.unreadableFiles === 1, `one damaged file is reported (${B.t.unreadableFiles})`);
	A.t.destroy(); B.t.destroy();
}

s.section("F4: a request that never answers cannot freeze the carrier");
{
	const drive = new FakeDrive();
	const A = dev(drive, "A", 1_700_000_000_000, { reconcileIntervalMs: 0, cycleTimeoutMs: 80 });
	await A.t.connect();
	let hung = false;
	drive.latencyHook = async (op) => { if (op === "listFiles" && !hung) { hung = true; await new Promise<never>(() => undefined); } };
	const stuck = A.t.syncNow();
	A.text.insert(0, "typed after the hang");
	const later = A.t.syncNow();
	const outcome = await Promise.race([later.then(() => "finished"), new Promise<string>((r) => setTimeout(() => r("still waiting"), 1500))]);
	s.check(outcome === "finished", "a later cycle runs although one request never answered");
	s.check((await stuck) === false, "the hung cycle is reported as failed");
	s.check(typeof A.t.lastError === "string" || names(drive).some((n) => n.startsWith("seg-")), "the failure was recorded or the next cycle already recovered");
	await cycle(A);
	s.check(names(drive).some((n) => n.startsWith("seg-")), "the edit made after the hang reaches Drive");
	A.t.destroy();
}

s.section("F5: a file listing that lags behind our own upload causes no duplicate upload");
{
	const drive = new FakeDrive();
	const A = dev(drive, "A", 1_700_000_000_000, { reconcileIntervalMs: 1 });
	await A.t.connect();
	A.text.insert(0, "hello");
	await cycle(A, 1000);
	drive.hideFromListing = (name) => name.startsWith("seg-");
	await cycle(A, 1000); await cycle(A, 1000);
	drive.hideFromListing = null;
	await cycle(A, 1000); await cycle(A, 1000);
	const segs = names(drive).filter((n) => n.startsWith("seg-")).length;
	s.check(segs === 1, `still one segment after the lag (${segs})`);
	A.t.destroy();
}

s.section("F6: closing the app sends what is still waiting");
{
	const drive = new FakeDrive();
	const A = dev(drive, "A", 1_700_000_000_000, { reconcileIntervalMs: 0 });
	await A.t.connect();
	A.text.insert(0, "typed just before closing");
	A.t.destroy();
	await new Promise((r) => setTimeout(r, 50));
	const B = dev(drive, "B", 1_700_000_100_000, { reconcileIntervalMs: 0 });
	await B.t.connect(); await cycle(B);
	s.check(B.text.toString() === "typed just before closing", "another device sees the last edit without waiting for A's next start");
	B.t.destroy();
}

s.section("F9a: completeness survives a Yjs that no longer shows its internals");
{
	// The guard: this fails in CI if a Yjs upgrade stops exposing the internals,
	// instead of quietly calling a waiting document complete (see yjsPending.ts).
	const fresh = new Y.Doc();
	s.check(readPendingState(fresh).known, "this Yjs still exposes pendingStructs/pendingDs");
	s.check(!readPendingState(fresh).pending, "a caught-up document reports nothing pending");

	// A document that really is waiting for an update it never received.
	const source = new Y.Doc();
	source.getText("t").insert(0, "first");
	const base = Y.encodeStateAsUpdate(source);
	source.getText("t").insert(5, " second");
	const dependent = Y.encodeStateAsUpdate(source, Y.encodeStateVectorFromUpdate(base));
	const waiting = new Y.Doc();
	Y.applyUpdate(waiting, dependent);
	const state = readPendingState(waiting);
	s.check(state.known && state.pending, "a document missing an update is reported as pending");
	Y.applyUpdate(waiting, base);
	s.check(!readPendingState(waiting).pending && waiting.getText("t").toString() === "first second", "and is complete once the missing update arrives");

	// The fallback path (what a future Yjs would get) must give the same answer as
	// the internals path on a real half-synced vault.
	const drive = new FakeDrive();
	const A = dev(drive, "A", 1_700_000_000_000, { compactSegmentCount: 100, reconcileIntervalMs: 0 });
	await A.t.connect();
	for (let i = 0; i < 4; i++) { A.text.insert(A.text.length, `w${i} `); await cycle(A, 1000); }
	const segs = names(drive).filter((n) => n.startsWith("seg-"));
	drive.remove(segs[1] as string);
	A.t.destroy();
	const internals = dev(drive, "R", 1_700_000_900_000, { pendingState: readPendingState });
	const fallback = dev(drive, "F", 1_700_000_900_000, { pendingState: () => ({ known: false, pending: false }) });
	await internals.t.connect(); await cycle(internals);
	await fallback.t.connect(); await cycle(fallback);
	s.check(!internals.t.synced && !fallback.t.synced, "both readers agree: a device missing an update is not synced");
	s.check(internals.text.toString() === fallback.text.toString(), `and both hold the same document (${internals.text.toString()})`);
	internals.t.destroy(); fallback.t.destroy();
}

s.section("F9a2: the state-vector fallback converges like the internals path");
{
	const drive = new FakeDrive();
	const a = dev(drive, "A", 1_700_000_000_000, { reconcileIntervalMs: 0 });
	const b = dev(drive, "B", 1_700_000_000_000, { reconcileIntervalMs: 0, pendingState: () => ({ known: false, pending: false }) });
	await a.t.connect();
	a.text.insert(0, "from A");
	await cycle(a);
	await b.t.connect();
	await cycle(b);
	s.check(a.text.toString() === "from A" && b.text.toString() === "from A", "the fallback device receives the update");
	s.check(a.t.synced && b.t.synced, "and both are reported synced");
	b.text.insert(b.text.length, " plus B");
	await cycle(b);
	await cycle(a);
	s.check(a.text.toString() === "from A plus B", "and an edit from the fallback device comes back to the other one");
	a.t.destroy(); b.t.destroy();
}

s.section("F9c: the carrier runs on the host's scheduler, not on window");
{
	const drive = new FakeDrive();
	const scheduled: { handler: () => void; at: number; id: number }[] = [];
	let nextId = 1;
	let clock = 1_700_000_000_000;
	const run = async (): Promise<void> => {
		for (let i = 0; i < 40 && scheduled.length > 0; i++) {
			scheduled.sort((x, y) => x.at - y.at || x.id - y.id);
			const next = scheduled.shift() as { handler: () => void; at: number; id: number };
			clock = Math.max(clock, next.at);
			next.handler();
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	};
	const scheduler = {
		setTimeout: (handler: () => void, ms: number): number => {
			const id = nextId++;
			scheduled.push({ handler, at: clock + ms, id });
			return id;
		},
		clearTimeout: (id: number): void => {
			const at = scheduled.findIndex((s) => s.id === id);
			if (at >= 0) scheduled.splice(at, 1);
		},
	};
	const doc = new Y.Doc();
	const t = new DriveTransport(doc, drive.client(), { vaultId: VAULT, deviceId: "S", now: () => clock, scheduler, log: () => undefined });
	s.check(scheduled.length === 0, "nothing is scheduled before connecting");
	await t.connect();
	s.check(scheduled.length > 0, "connecting schedules its first poll through the host scheduler");
	doc.getText("t").insert(0, "scheduled edit");
	await run();
	s.check(drive.namesIn(FOLDER).some((n) => n.startsWith("seg-")), "the scheduled work uploads the edit");
	t.destroy();
	s.check(scheduled.length === 0, "destroying clears everything through the same scheduler");
}

s.section("F9b: two runs starting in the same millisecond do not collide on a name");
{
	const drive = new FakeDrive();
	const start = 1_700_000_000_000;
	const one = dev(drive, "same", start, { reconcileIntervalMs: 0 });
	const two = dev(drive, "same", start, { reconcileIntervalMs: 0 });
	await one.t.connect();
	one.text.insert(0, "one");
	await cycle(one, 1000);
	await two.t.connect();
	two.text.insert(0, "two");
	await cycle(two, 1000);
	const segs = names(drive).filter((n) => n.startsWith("seg-"));
	s.check(segs.length === 2, `both runs stored a change file (${segs.join()})`);
	s.check(new Set(segs).size === 2, "with two different names");
	s.check(segs.every((n) => n.startsWith("seg-1700000001000-same-")), "both keep the device and the 13-digit stamp in the name");
	one.t.destroy(); two.t.destroy();
}


s.section("F8: the fake can model Drive's listing lag (off by default)");
{
	const plain = new FakeDrive();
	const plainClient = plain.client();
	const plainFolder = await plainClient.createFolder("YAOS v1");
	await plainClient.createFile(plainFolder.id, "seg-0000000000001-a-0.ydu", new Uint8Array([1]));
	s.check((await plainClient.listFiles(plainFolder.id)).length === 1, "by default a created file is listed immediately, as before");

	const drive = new FakeDrive();
	drive.listingLagTicks = 100;
	const client = drive.client();
	const folder = await client.createFolder("YAOS v1");
	const file = await client.createFile(folder.id, "seg-0000000000002-a-0.ydu", new Uint8Array([1, 2]));
	s.check((await client.listFiles(folder.id)).length === 0, "inside the lag a created file is not listed yet");
	s.check((await client.readFile(file.id)).length === 2, "but a read by id already works, like Drive");
	drive.clock += 100;
	s.check((await client.listFiles(folder.id)).length === 1, "once the lag has passed it appears");
	await client.deleteFile(file.id);
	s.check((await client.listFiles(folder.id)).length === 1, "a just-deleted file is still listed for the lag");
	drive.clock += 100;
	s.check((await client.listFiles(folder.id)).length === 0, "and disappears afterwards");
}


await s.done();

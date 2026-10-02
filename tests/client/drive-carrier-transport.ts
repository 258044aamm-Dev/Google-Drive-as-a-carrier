/**
 * Drive carrier: DriveTransport against an in-memory Drive.
 *
 * Every scenario drives the transport deterministically with syncNow()
 * (autoTimers off); one scenario at the end uses the real timers.
 */

import * as Y from "yjs";
import { DriveTransport, type DriveTransportOptions } from "../../src/drive-carrier/driveTransport";
import { KIND_SEGMENT, classifyName, encodeFile } from "../../src/drive-carrier/fileFormat";
import { FakeDrive } from "../mocks/fakeDrive";
import { suite } from "../harness.ts";

const s = suite("drive-carrier-transport");
const VAULT = "v1";
const FOLDER = `YAOS ${VAULT}`;

interface Device {
	name: string;
	doc: Y.Doc;
	text: Y.Text;
	map: Y.Map<string>;
	transport: DriveTransport;
	statuses: string[];
	syncs: boolean[];
}

let clock = 10_000_000;

function makeDevice(
	drive: FakeDrive,
	name: string,
	extra: Partial<DriveTransportOptions> = {},
	doc = new Y.Doc(),
	clientOptions: { reverseFolders?: boolean } = {},
): Device {
	const text = doc.getText("t");
	const map = doc.getMap<string>("m");
	const transport = new DriveTransport(doc, drive.client(clientOptions), {
		vaultId: VAULT,
		deviceId: name,
		autoTimers: false,
		now: () => clock,
		...extra,
	});
	const statuses: string[] = [];
	const syncs: boolean[] = [];
	transport.on("status", (e: { status: string }) => statuses.push(e.status));
	transport.on("sync", (v: boolean) => syncs.push(v));
	return { name, doc, text, map, transport, statuses, syncs };
}

/** Run enough full cycles on every device for edits to travel everywhere. */
async function settle(...devices: Device[]): Promise<void> {
	for (let round = 0; round < 3; round++) {
		for (const d of devices) {
			clock += 61_000;
			await d.transport.syncNow();
		}
	}
}

function same(devices: Device[]): boolean {
	const first = devices[0];
	if (!first) return true;
	return devices.every((d) => d.text.toString() === first.text.toString() && JSON.stringify(d.map.toJSON()) === JSON.stringify(first.map.toJSON()));
}

function segCount(drive: FakeDrive): number {
	return drive.namesIn(FOLDER).filter((n) => classifyName(n) === "segment").length;
}
function snapCount(drive: FakeDrive): number {
	return drive.namesIn(FOLDER).filter((n) => classifyName(n) === "snapshot").length;
}

s.section("Test 1: two devices converge and the first connect creates the folder and meta");
{
	const drive = new FakeDrive();
	const a = makeDevice(drive, "A");
	const b = makeDevice(drive, "B");
	await a.transport.connect();
	await b.transport.connect();
	s.check(drive.namesIn(FOLDER).includes("meta.json"), "meta.json written");
	s.check(drive.folders.size === 1, "exactly one vault folder");
	a.text.insert(0, "hello");
	await settle(a, b);
	s.check(b.text.toString() === "hello", "B received A's text");
	b.text.insert(5, " world");
	await settle(a, b);
	s.check(a.text.toString() === "hello world", "A received B's text");
	s.check(same([a, b]), "documents identical");
}

s.section("Test 2: events: connecting, connected, sync; disconnect; destroy");
{
	const drive = new FakeDrive();
	const a = makeDevice(drive, "A");
	s.check(!a.transport.wsconnected && !a.transport.synced, "starts offline");
	await a.transport.connect();
	s.check(a.statuses.join() === "connecting,connected", `status events (${a.statuses.join()})`);
	s.check(a.syncs.join() === "true" && a.transport.synced && a.transport.wsconnected, "sync event and flags");
	s.check(!a.transport.wsconnecting, "not connecting any more");
	a.transport.disconnect();
	s.check(a.statuses.at(-1) === "disconnected" && !a.transport.wsconnected, "disconnect reported");
	s.check(a.syncs.at(-1) === false && !a.transport.synced, "sync lost on disconnect");
	a.transport.destroy();
	const before = drive.calls.createFile;
	a.text.insert(0, "after destroy");
	await a.transport.syncNow();
	s.check(drive.calls.createFile === before, "a destroyed transport uploads nothing");
}

s.section("Test 3: three devices editing at once converge, nothing lost");
{
	const drive = new FakeDrive();
	const [a, b, c] = [makeDevice(drive, "A"), makeDevice(drive, "B"), makeDevice(drive, "C")] as [Device, Device, Device];
	for (const d of [a, b, c]) await d.transport.connect();
	a.text.insert(0, "base");
	await settle(a, b, c);
	a.text.insert(0, "[a]");
	b.text.insert(4, "[b]");
	c.text.insert(2, "[c]");
	await settle(a, b, c);
	const result = a.text.toString();
	s.check(same([a, b, c]), `identical (${result})`);
	s.check(["[a]", "[b]", "[c]"].every((x) => result.includes(x)), "every insert is present");
	s.check(result.replace(/\[[abc]\]/g, "") === "base", "original text intact");
}

s.section("Test 4: same-line concurrent edits at the same position");
{
	const drive = new FakeDrive();
	const a = makeDevice(drive, "A");
	const b = makeDevice(drive, "B");
	await a.transport.connect();
	await b.transport.connect();
	a.text.insert(0, "hello world");
	await settle(a, b);
	a.text.insert(5, "AAA");
	b.text.insert(5, "BBB");
	await settle(a, b);
	s.check(same([a, b]), `identical (${a.text.toString()})`);
	s.check(a.text.toString().includes("AAA") && a.text.toString().includes("BBB"), "both edits kept, no conflict copy");
}

s.section("Test 5: edit vs delete converges");
{
	const drive = new FakeDrive();
	const a = makeDevice(drive, "A");
	const b = makeDevice(drive, "B");
	await a.transport.connect();
	await b.transport.connect();
	a.map.set("note.md", "id-1");
	a.text.insert(0, "line one line two");
	await settle(a, b);
	a.map.delete("note.md");
	a.text.delete(0, 9);
	b.map.set("note.md", "id-1-edited");
	b.text.insert(9, "!!");
	await settle(a, b);
	s.check(same([a, b]), `identical (${JSON.stringify(a.map.toJSON())} / ${a.text.toString()})`);
}

s.section("Test 6: offline edits on both sides merge when they come back");
{
	const drive = new FakeDrive();
	const a = makeDevice(drive, "A");
	const b = makeDevice(drive, "B");
	await a.transport.connect();
	await b.transport.connect();
	a.text.insert(0, "start");
	await settle(a, b);
	drive.offline = true;
	a.text.insert(0, "A-offline ");
	b.text.insert(b.text.length, " B-offline");
	const failed = await a.transport.syncNow();
	await b.transport.syncNow();
	s.check(!failed, "sync fails while offline");
	s.check(a.transport.pendingParts > 0, "offline edits stay queued");
	drive.offline = false;
	await settle(a, b);
	s.check(same([a, b]), `identical (${a.text.toString()})`);
	s.check(a.text.toString().includes("A-offline") && a.text.toString().includes("B-offline"), "both offline edits survived");
	s.check(a.transport.pendingParts === 0, "queue drained");
}

s.section("Test 7: no echo: applying remote data never uploads it again, and idle cycles are cheap");
{
	const drive = new FakeDrive();
	const a = makeDevice(drive, "A", { reconcileIntervalMs: 1 });
	const b = makeDevice(drive, "B", { reconcileIntervalMs: 1 });
	await a.transport.connect();
	await b.transport.connect();
	a.text.insert(0, "one two three");
	a.text.delete(3, 4);
	a.map.set("k", "v");
	a.map.delete("k");
	await settle(a, b);
	const filesBefore = drive.namesIn(FOLDER).length;
	{
		// B must not send A's edit back: one more edit from A, then B reads it.
		a.text.insert(0, "x");
		await a.transport.syncNow();
		const afterA = drive.namesIn(FOLDER).length;
		await b.transport.syncNow();
		s.check(drive.namesIn(FOLDER).length === afterA, "B read A's segment and uploaded nothing in return");
	}
	const settledCount = drive.namesIn(FOLDER).length;
	for (let i = 0; i < 6; i++) await settle(a, b);
	s.check(filesBefore <= settledCount, "baseline recorded");
	s.check(drive.namesIn(FOLDER).length === settledCount, `no new files from repeated reconciles (${settledCount} -> ${drive.namesIn(FOLDER).length})`);
	const reads = drive.calls.readFile;
	const creates = drive.calls.createFile;
	const lists = drive.calls.listFiles;
	await a.transport.syncNow();
	s.check(drive.calls.listFiles === lists + 1, "an idle cycle lists once");
	s.check(drive.calls.readFile === reads && drive.calls.createFile === creates, "an idle cycle reads and writes nothing");
}

s.section("Test 8: remote updates carry the transport as origin; ignored origins are not uploaded");
{
	const drive = new FakeDrive();
	const persistence = { kind: "persistence" };
	const a = makeDevice(drive, "A");
	const origins: unknown[] = [];
	const bDoc = new Y.Doc();
	bDoc.on("update", (_u: Uint8Array, origin: unknown) => origins.push(origin));
	const b = makeDevice(drive, "B", { ignoreOrigin: (o) => o === persistence }, bDoc);
	await a.transport.connect();
	await b.transport.connect();
	a.text.insert(0, "from A");
	await settle(a, b);
	s.check(origins.includes(b.transport), "B applied A's update with its transport as origin");
	const loaded = new Y.Doc();
	loaded.getText("t").insert(0, "from disk cache");
	const files = drive.namesIn(FOLDER).length;
	Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(loaded), persistence);
	s.check(b.transport.pendingParts === 0, "an ignored origin queues nothing");
	await b.transport.syncNow();
	s.check(drive.namesIn(FOLDER).length === files, "and uploads nothing");
}

s.section("Test 9: a response lost after the upload landed causes a retry, not a duplicate edit");
{
	const drive = new FakeDrive();
	const a = makeDevice(drive, "A");
	const b = makeDevice(drive, "B");
	await a.transport.connect();
	await b.transport.connect();
	drive.loseResponseNext(1);
	a.text.insert(0, "once");
	const ok = await a.transport.syncNow();
	s.check(!ok && a.transport.pendingParts > 0, "the failed attempt keeps the edit queued");
	await settle(a, b);
	s.check(a.text.toString() === "once" && b.text.toString() === "once", `content not doubled (${b.text.toString()})`);
}

s.section("Test 10: rate limits and server errors back off without losing edits");
{
	const drive = new FakeDrive();
	const a = makeDevice(drive, "A");
	const b = makeDevice(drive, "B");
	await a.transport.connect();
	await b.transport.connect();
	drive.failNext("createFile", 429, 2);
	drive.failNext("listFiles", 503, 1);
	a.text.insert(0, "survives");
	const results: boolean[] = [];
	for (let i = 0; i < 5; i++) results.push(await a.transport.syncNow());
	s.check(results.includes(false) && results.at(-1) === true, `fails first, then recovers (${results.join()})`);
	await settle(a, b);
	s.check(b.text.toString() === "survives", "edit arrived after the errors");
	s.check(a.transport.lastError === null, "error cleared after recovery");
}

s.section("Test 11: going offline and back is reported; a 401 storm is just failures");
{
	const drive = new FakeDrive();
	const a = makeDevice(drive, "A");
	await a.transport.connect();
	drive.failNext("listFiles", 401, 3);
	await a.transport.syncNow();
	s.check(a.transport.wsconnected, "one failure does not flip the state");
	await a.transport.syncNow();
	s.check(!a.transport.wsconnected && a.statuses.at(-1) === "disconnected", "second failure in a row reports disconnected");
	s.check(!a.transport.synced, "sync flag cleared");
	await a.transport.syncNow();
	const ok = await a.transport.syncNow();
	s.check(ok && a.transport.wsconnected && a.statuses.at(-1) === "connected", "recovery reports connected again");
	s.check(a.syncs.join() === "true,false,true", `sync events (${a.syncs.join()})`);
}

s.section("Test 12: a large paste travels intact");
{
	const drive = new FakeDrive();
	const a = makeDevice(drive, "A");
	const b = makeDevice(drive, "B");
	await a.transport.connect();
	await b.transport.connect();
	const big = "0123456789abcdef".repeat(130_000);
	a.text.insert(0, big);
	await settle(a, b);
	s.check(b.text.length === big.length && b.text.toString() === big, `2 MB paste identical (${b.text.length} chars)`);
}

s.section("Test 13: restart with unsent edits: the difference is found and uploaded");
{
	const drive = new FakeDrive();
	const a = makeDevice(drive, "A");
	const b = makeDevice(drive, "B");
	await a.transport.connect();
	await b.transport.connect();
	a.text.insert(0, "saved");
	await settle(a, b);
	drive.offline = true;
	a.text.insert(5, " + typed while offline");
	await a.transport.syncNow();
	const persisted = Y.encodeStateAsUpdate(a.doc); // what the local database holds
	a.transport.destroy(); // the app is closed; the queue in memory is gone
	drive.offline = false;
	const restoredDoc = new Y.Doc();
	Y.applyUpdate(restoredDoc, persisted);
	const a2 = makeDevice(drive, "A", {}, restoredDoc);
	await a2.transport.connect();
	await settle(a2, b);
	s.check(b.text.toString() === "saved + typed while offline", `B got the unsent edit (${b.text.toString()})`);
}

s.section("Test 14: a new device with its own content joins an existing vault");
{
	const drive = new FakeDrive();
	const a = makeDevice(drive, "A");
	await a.transport.connect();
	a.text.insert(0, "from A");
	await settle(a);
	const bDoc = new Y.Doc();
	bDoc.getMap<string>("m").set("local", "yes");
	const b = makeDevice(drive, "B", {}, bDoc);
	await b.transport.connect();
	await settle(a, b);
	s.check(same([a, b]), "identical");
	s.check(a.map.get("local") === "yes" && b.text.toString() === "from A", "both sides' content kept");
}

s.section("Test 15: compaction writes a snapshot, deletes covered segments, a fresh device still loads everything");
{
	const drive = new FakeDrive();
	const opts = { compactSegmentCount: 3 };
	const a = makeDevice(drive, "A", opts);
	const b = makeDevice(drive, "B", opts);
	await a.transport.connect();
	await b.transport.connect();
	for (let i = 0; i < 10; i++) {
		a.text.insert(a.text.length, `line ${i}\n`);
		await settle(a, b);
	}
	s.check(snapCount(drive) >= 1 && snapCount(drive) <= 2, `a snapshot exists and at most two are kept (${snapCount(drive)})`);
	s.check(segCount(drive) <= 4, `segments were compacted (${segCount(drive)} left)`);
	const fresh = makeDevice(drive, "C", opts);
	await fresh.transport.connect();
	await settle(fresh, a, b);
	s.check(same([a, b, fresh]), "a fresh device equals the others");
	s.check(fresh.text.toString().startsWith("line 0\n") && fresh.text.toString().endsWith("line 9\n"), "and has the whole text");
}

s.section("Test 16: two devices compacting at the same moment lose nothing");
{
	const drive = new FakeDrive();
	const opts = { compactSegmentCount: 2 };
	const a = makeDevice(drive, "A", opts);
	const b = makeDevice(drive, "B", opts);
	await a.transport.connect();
	await b.transport.connect();
	for (let i = 0; i < 5; i++) {
		a.text.insert(a.text.length, `a${i} `);
		b.text.insert(0, `b${i} `);
		clock += 61_000;
		await Promise.all([a.transport.syncNow(), b.transport.syncNow()]);
	}
	await settle(a, b);
	await settle(a, b);
	const want = [0, 1, 2, 3, 4].flatMap((i) => [`a${i}`, `b${i}`]);
	s.check(same([a, b]), "identical");
	s.check(want.every((w) => a.text.toString().includes(w)), `no edit lost (${a.text.toString()})`);
	const late = makeDevice(drive, "L", opts);
	await late.transport.connect();
	await settle(late, a, b);
	s.check(want.every((w) => late.text.toString().includes(w)), "a late joiner sees everything too");
	s.check(snapCount(drive) <= 4, `snapshots stay bounded (${snapCount(drive)})`);
}

s.section("Test 17: a failing cleanup cannot spam snapshots");
{
	const drive = new FakeDrive();
	const a = makeDevice(drive, "A", { compactSegmentCount: 1 });
	await a.transport.connect();
	drive.failNext("deleteFile", 500, 1000);
	for (let i = 0; i < 6; i++) {
		a.text.insert(0, `x${i}`);
		clock += 1000; // far less than the minimum gap between compactions
		await a.transport.syncNow();
	}
	s.check(snapCount(drive) <= 2, `at most a couple of snapshots despite failing deletes (${snapCount(drive)})`);
}

s.section("Test 18: damaged and foreign files are skipped; the owner repairs a lost segment");
{
	const drive = new FakeDrive();
	const a = makeDevice(drive, "A", { reconcileIntervalMs: 1 });
	const logs: string[] = [];
	const b = makeDevice(drive, "B", { log: (m) => logs.push(m) });
	await a.transport.connect();
	await b.transport.connect();
	a.text.insert(0, "first");
	await settle(a, b);
	a.text.insert(5, " second");
	await a.transport.syncNow();
	const seg = drive.namesIn(FOLDER).filter((n) => classifyName(n) === "segment").at(-1) ?? "";
	drive.corrupt(seg, (d) => { d[d.length - 1] = (d[d.length - 1] ?? 0) ^ 0xff; return d; });
	drive.files.set("stranger", { id: "stranger", name: "notes.txt", parent: Array.from(drive.folders.keys())[0] ?? "", data: new Uint8Array([1]), createdTime: 1 });
	const garbage = await encodeFile(KIND_SEGMENT, new Uint8Array([200, 201, 202, 203]));
	drive.files.set("garbage", { id: "garbage", name: `seg-${String(clock).padStart(13, "0")}-X-0.ydu`, parent: Array.from(drive.folders.keys())[0] ?? "", data: garbage, createdTime: 2 });
	await settle(b);
	s.check(b.text.toString() === "first", `B ignored the damaged segment (${b.text.toString()})`);
	s.check(logs.some((l) => l.includes("skipping damaged file")), "damage was logged");
	s.check(logs.some((l) => l.includes("update could not be applied")) || b.text.toString() === "first", "garbage with a valid checksum did not crash B");
	// The user (or a cleanup tool) deletes the damaged file on Drive; A still holds the text.
	drive.remove(seg);
	await settle(a, b);
	s.check(b.text.toString() === "first second", `A re-uploaded what Drive lost (${b.text.toString()})`);
	s.check(same([a, b]), "identical");
}

s.section("Test 19: a layout from the future stops the carrier cleanly");
{
	const drive = new FakeDrive();
	const folder = await drive.client().createFolder(FOLDER);
	await drive.client().createFile(folder.id, "meta.json", new TextEncoder().encode(JSON.stringify({ schema: 99 })));
	const a = makeDevice(drive, "A");
	a.text.insert(0, "mine");
	await a.transport.connect();
	s.check(a.transport.fatalError !== null && /layout 99/.test(a.transport.fatalError), `fatal error set (${a.transport.fatalError ?? ""})`);
	s.check(!a.transport.wsconnected && !a.statuses.includes("connected"), "never reports connected");
	await a.transport.syncNow();
	s.check(drive.namesIn(FOLDER).join() === "meta.json", "writes nothing into the unknown layout");
	const calls = drive.calls.listFiles;
	await a.transport.connect();
	s.check(drive.calls.listFiles === calls, "does not keep retrying");
}

s.section("Test 20: two devices that both created the folder settle on one");
{
	const drive = new FakeDrive();
	const c = drive.client();
	await c.createFolder(FOLDER);
	await c.createFolder(FOLDER); // the race produced a duplicate
	const a = makeDevice(drive, "A");
	// B's Drive lists the two folders in the opposite order; it must still choose the same one.
	const b = makeDevice(drive, "B", {}, new Y.Doc(), { reverseFolders: true });
	await a.transport.connect();
	await b.transport.connect();
	a.text.insert(0, "shared");
	await settle(a, b);
	s.check(b.text.toString() === "shared", "both used the same folder");
	const used = Array.from(drive.folders.values()).filter((f) => drive.filesIn(f.name).length > 0 && drive.files.size > 0);
	const withData = Array.from(drive.folders.keys()).filter((id) => Array.from(drive.files.values()).some((f) => f.parent === id));
	s.check(withData.length === 1 && used.length > 0, `all files live in one folder (${withData.length})`);
}

s.section("Test 21: Drive restarts from empty (everything deleted) and the devices refill it");
{
	const drive = new FakeDrive();
	const a = makeDevice(drive, "A", { reconcileIntervalMs: 1 });
	const b = makeDevice(drive, "B", { reconcileIntervalMs: 1 });
	await a.transport.connect();
	await b.transport.connect();
	a.text.insert(0, "precious");
	await settle(a, b);
	for (const name of drive.namesIn(FOLDER)) if (classifyName(name) !== "meta") drive.remove(name);
	await settle(a, b);
	const fresh = makeDevice(drive, "N", {});
	await fresh.transport.connect();
	await settle(fresh, a, b);
	s.check(fresh.text.toString() === "precious", `a new device gets the data back from the holders (${fresh.text.toString()})`);
}

s.section("Test 22: real timers: edits travel on their own");
{
	const drive = new FakeDrive();
	const fast = { autoTimers: true, pollIntervalMs: 15, batchMs: 5, reconcileIntervalMs: 0 };
	const a = makeDevice(drive, "A", fast);
	const b = makeDevice(drive, "B", fast);
	await a.transport.connect();
	await b.transport.connect();
	a.text.insert(0, "auto");
	const deadline = Date.now() + 3000;
	while (b.text.toString() !== "auto" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
	s.check(b.text.toString() === "auto", "B received the edit without manual syncing");
	b.text.insert(4, "matic");
	while (a.text.toString() !== "automatic" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
	s.check(a.text.toString() === "automatic", "and A received the reply");
	a.transport.destroy();
	b.transport.destroy();
	const before = drive.calls.listFiles;
	await new Promise((r) => setTimeout(r, 80));
	s.check(drive.calls.listFiles === before, "no polling after destroy");
}

await s.done();

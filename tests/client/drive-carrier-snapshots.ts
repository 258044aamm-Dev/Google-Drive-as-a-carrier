/**
 * Drive carrier: restore points (snapshots) stored on Drive, and proof that the
 * default snapshot path still talks to the Worker exactly as before.
 */

import { App } from "obsidian";
import * as obsidian from "obsidian";
import * as Y from "yjs";
import { DriveError, type DriveApi } from "../../src/drive-carrier/driveApi";
import {
	DriveSnapshotBackend,
	KEEP_UNPINNED_SNAPSHOTS,
	snapshotFolderName,
} from "../../src/drive-carrier/driveSnapshotBackend";
import { SnapshotService } from "../../src/snapshots/snapshotService";
import { createServerSnapshotBackend, type SnapshotBackend } from "../../src/snapshots/snapshotBackend";
import { DEFAULT_SETTINGS, type VaultSyncSettings } from "../../src/settings";
import { diffSnapshot, type SnapshotIndex } from "../../src/sync/snapshotClient";
import { VaultSync } from "../../src/sync/vaultSync";
import { FakeDrive } from "../mocks/fakeDrive";
import { suite } from "../harness.ts";

const s = suite("drive-carrier-snapshots");
const VAULT = "v1";
const FOLDER = snapshotFolderName(VAULT);
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 5, 1, 10, 0, 0);

function makeDoc(files: Record<string, string> = {}): Y.Doc {
	const doc = new Y.Doc();
	const ids = doc.getMap<string>("pathToId");
	const texts = doc.getMap<Y.Text>("idToText");
	for (const [path, text] of Object.entries(files)) {
		ids.set(path, `id-${path}`);
		const t = new Y.Text();
		texts.set(`id-${path}`, t);
		t.insert(0, text);
	}
	return doc;
}

async function fails(run: () => Promise<unknown>): Promise<Error | null> {
	try {
		await run();
	} catch (err) {
		return err instanceof Error ? err : new Error(String(err));
	}
	return null;
}

let counter = 0;
function makeBackend(drive: FakeDrive, doc: Y.Doc | null, clock: { t: number }, vaultId = VAULT) {
	return new DriveSnapshotBackend(drive.client(), {
		vaultId,
		getDoc: () => doc,
		now: () => clock.t,
		random: () => (counter++).toString(16).padStart(8, "0"),
	});
}

s.section("Test 1: take, list, fetch");
{
	const drive = new FakeDrive();
	const clock = { t: T0 };
	const doc = makeDoc({ "a.md": "hello", "b.md": "world" });
	doc.getMap<unknown>("pathToBlob").set("pic.png", { hash: "ab".repeat(32), size: 3 });
	const backend = makeBackend(drive, doc, clock);
	const res = await backend.now("laptop");
	s.check(res.status === "created" && res.snapshotId !== undefined, "snapshot created");
	s.check(drive.folders.size === 1 && Array.from(drive.folders.values())[0]?.name === "YAOS v1 snapshots", "in its own 'YAOS <vault> snapshots' folder");
	s.check(drive.namesIn(FOLDER).length === 2, "two files: data and index");
	s.check(drive.namesIn("YAOS v1").length === 0, "the polled sync folder is not touched");
	const idx = res.index;
	s.check(idx?.markdownFileCount === 2 && idx.blobFileCount === 1, "index counts notes and attachments");
	s.check(idx?.referencedBlobHashes?.join() === "ab".repeat(32), "index lists referenced attachments");
	s.check(idx?.pinned === true && idx.reason === "manual" && idx.triggeredBy === "laptop", "manual snapshots are pinned and say who took them");
	s.check(res.snapshotIdenticalToLatest === false, "the first snapshot is not 'identical to latest'");
	const listed = await backend.list();
	s.check(listed.length === 1 && listed[0]?.snapshotId === res.snapshotId, "it is listed");
	const back = await backend.download(listed[0] as SnapshotIndex);
	s.check(back.getMap<string>("pathToId").size === 2, "the downloaded document has the notes");
	const diff = diffSnapshot(back, makeDoc({ "a.md": "hello changed", "c.md": "new" }));
	s.check(diff.deletedSinceSnapshot.some((d) => d.path === "b.md") && diff.contentChanged.some((m) => m.path === "a.md") && diff.createdSinceSnapshot.includes("c.md"),
		"the existing restore comparison understands the downloaded document");
	s.check(Y.equalSnapshots(Y.snapshot(back), Y.snapshot(doc)), "content is identical to what was snapshotted");
	back.destroy();
}

s.section("Test 1b: a current-model document is counted from meta (not from the empty pathToId)");
{
	const drive = new FakeDrive();
	const clock = { t: T0 };
	const doc = new Y.Doc();
	doc.getMap<unknown>("sys").set("schemaVersion", 3);
	const meta = doc.getMap<unknown>("meta");
	for (const [id, path, deleted] of [["i1", "a.md", false], ["i2", "b.md", false], ["i3", "c.md", true]] as const) {
		const m = new Y.Map<unknown>();
		m.set("path", path);
		if (deleted) m.set("deletedAt", 1_700_000_000_000);
		meta.set(id, m);
	}
	const res = await makeBackend(drive, doc, clock).now("laptop");
	s.check(res.index?.markdownFileCount === 2, `two active notes, the deleted one is not counted (got ${String(res.index?.markdownFileCount)})`);
}

s.section("Test 2: daily snapshot");
{
	const drive = new FakeDrive();
	const clock = { t: T0 };
	const doc = makeDoc({ "a.md": "x" });
	const backend = makeBackend(drive, doc, clock);
	const first = await backend.daily("laptop");
	s.check(first.status === "created" && first.index?.pinned === false && first.index.reason === "daily", "first daily is created and not pinned");
	clock.t = T0 + 3_600_000;
	const second = await backend.daily("laptop");
	s.check(second.status === "noop", "a second one the same day is a noop");
	s.check(drive.namesIn(FOLDER).length === 2, "and writes nothing");
	const other = makeBackend(drive, doc, clock);
	s.check((await other.daily("phone")).status === "noop", "another device also sees today's snapshot");
	clock.t = T0 + DAY;
	s.check((await backend.daily("laptop")).status === "created", "the next day creates a new one");
	s.check((await backend.list()).length === 2, "two restore points");
}

s.section("Test 3: unchanged content is flagged");
{
	const drive = new FakeDrive();
	const clock = { t: T0 };
	const doc = makeDoc({ "a.md": "x" });
	const backend = makeBackend(drive, doc, clock);
	await backend.now();
	clock.t += 1000;
	const again = await backend.now();
	s.check(again.snapshotIdenticalToLatest === true, "a second snapshot of the same content says so");
	doc.getMap<string>("pathToId").set("z.md", "idz");
	clock.t += 1000;
	const changed = await backend.now();
	s.check(changed.snapshotIdenticalToLatest === false, "a changed document is not flagged");
}

s.section("Test 4: list order, limit, damaged index files");
{
	const drive = new FakeDrive();
	const clock = { t: T0 };
	const doc = makeDoc({ "a.md": "x" });
	const backend = makeBackend(drive, doc, clock);
	const ids: string[] = [];
	for (let i = 0; i < 3; i++) {
		clock.t = T0 + i * 1000;
		ids.push((await backend.now()).snapshotId ?? "");
	}
	const list = await backend.list();
	s.check(list.map((x) => x.snapshotId).join() === ids.slice().reverse().join(), "newest first");
	const idxName = drive.namesIn(FOLDER).find((n) => n === `snapidx-${ids[1]}.json`) ?? "";
	drive.corrupt(idxName, (d) => d.map(() => 0x7b));
	s.check((await backend.list()).length === 2, "an unreadable index is skipped, the rest still list");
}
{
	const drive = new FakeDrive();
	const clock = { t: T0 };
	const backend = makeBackend(drive, makeDoc({ "a.md": "x" }), clock);
	for (let i = 0; i < 55; i++) {
		clock.t = T0 + i * 1000;
		await backend.now();
	}
	s.check((await backend.list()).length === 50, "at most 50 restore points are listed");
}

s.section("Test 5: interrupted snapshots never show up");
{
	const drive = new FakeDrive();
	const clock = { t: T0 };
	const backend = makeBackend(drive, makeDoc({ "a.md": "x" }), clock);
	await backend.now(); // creates folder and one snapshot
	drive.failNext("createFile", 503, 1);
	const err = await fails(() => backend.now());
	s.check(err instanceof DriveError, "a failure while writing surfaces");
	s.check((await backend.list()).length === 1, "and no half-snapshot is listed");
	const before = drive.namesIn(FOLDER).length;
	const ok = await backend.now();
	s.check(ok.status === "created" && (await backend.list()).length === 2, "the next attempt works");
	s.check(drive.namesIn(FOLDER).length >= before + 2, "files were added");
}
{
	// data written, index failed: orphan data
	const drive = new FakeDrive();
	const clock = { t: T0 };
	const backend = makeBackend(drive, makeDoc({ "a.md": "x" }), clock);
	await backend.now();
	const api = drive.client();
	let n = 0;
	const wrapped: DriveApi = {
		findFolders: (name) => api.findFolders(name),
		createFolder: (name) => api.createFolder(name),
		listFiles: (folder) => api.listFiles(folder),
		readFile: (id) => api.readFile(id),
		deleteFile: (id) => api.deleteFile(id),
		createFile: async (folder, name, data) => {
			if (name.startsWith("snapidx-") && n++ === 0) throw new DriveError(500, "boom");
			return api.createFile(folder, name, data);
		},
	};
	const flaky = new DriveSnapshotBackend(wrapped, {
		vaultId: VAULT,
		getDoc: () => makeDoc({ "a.md": "y" }),
		now: () => clock.t + 5000,
		random: () => "deadbeef",
	});
	const err = await fails(() => flaky.now());
	s.check(err !== null, "index write failed");
	s.check(drive.namesIn(FOLDER).some((x) => x.startsWith("snapdat-") && x.includes("deadbeef")), "the data file is left behind");
	s.check((await flaky.list()).length === 1, "but it is not listed");
	// Too young to remove (a writer may still be about to add its index).
	const youngClock = { t: 5 };
	const young = makeBackend(drive, null, youngClock);
	await young.prune();
	s.check(drive.namesIn(FOLDER).some((x) => x.includes("deadbeef")), "fresh leftovers are not removed");
	// Old enough to remove.
	const later = makeBackend(drive, null, { t: T0 + DAY });
	await later.prune();
	s.check(!drive.namesIn(FOLDER).some((x) => x.includes("deadbeef")), "old leftovers are cleaned up");
	s.check((await later.list()).length === 1 && drive.namesIn(FOLDER).length === 2, "complete snapshots are untouched");
}

s.section("Test 6: damaged or missing snapshot data");
{
	const drive = new FakeDrive();
	const clock = { t: T0 };
	const backend = makeBackend(drive, makeDoc({ "a.md": "x" }), clock);
	const res = await backend.now();
	const index = res.index as SnapshotIndex;
	const name = `snapdat-${index.snapshotId}.bin`;
	drive.corrupt(name, (d) => { d[d.length - 1] = (d[d.length - 1] ?? 0) ^ 0xff; return d; });
	const err = await fails(() => backend.download(index));
	s.check(err !== null, "a damaged snapshot is refused");
	drive.remove(name);
	const gone = await fails(() => backend.download(index));
	s.check(gone !== null && gone.message.includes("404"), "a missing snapshot is reported as 404");
	// A file that is a segment, not a snapshot.
	const other = await fails(() => backend.download({ ...index, snapshotId: "nope" }));
	s.check(other !== null && other.message.includes("404"), "an unknown id is a 404");
}

s.section("Test 7: cleanup keeps pinned and the newest 14");
{
	const drive = new FakeDrive();
	const clock = { t: T0 };
	const doc = makeDoc({ "a.md": "x" });
	const backend = makeBackend(drive, doc, clock);
	for (let i = 0; i < 20; i++) {
		clock.t = T0 + i * DAY;
		await backend.daily("laptop");
	}
	clock.t = T0 + 3 * DAY + 1000;
	await backend.now("laptop"); // pinned, old
	clock.t = T0 + 25 * DAY;
	const res = await backend.prune();
	s.check(res.pruned === 6 && res.kept === 15 && res.failed === 0, `6 pruned, 14 daily + 1 pinned kept (got ${JSON.stringify(res)})`);
	const left = await backend.list();
	s.check(left.length === 15, "15 remain");
	s.check(left.filter((x) => x.pinned).length === 1, "the pinned one survived although old");
	s.check(drive.namesIn(FOLDER).length === 30, "data and index files were both removed for pruned snapshots");
	const again = await backend.prune();
	s.check(again.pruned === 0 && again.kept === 15, "a second cleanup removes nothing");
	s.check(KEEP_UNPINNED_SNAPSHOTS === 14, "the retention constant is the documented one");
}
{
	const drive = new FakeDrive();
	const clock = { t: T0 };
	const backend = makeBackend(drive, makeDoc({ "a.md": "x" }), clock);
	for (let i = 0; i < 17; i++) { clock.t = T0 + i * DAY; await backend.daily(); }
	drive.failNext("deleteFile", 500, 1);
	const res = await backend.prune();
	s.check(res.failed === 1 && res.pruned === 2, "one failed delete is counted, the others go on");
	s.check((await backend.list()).length === 15, "the failed one is still there for the next cleanup");
	const next = await backend.prune();
	s.check(next.pruned === 1 && next.kept === 14, "the next cleanup finishes the job");
}

s.section("Test 8: not running, and separate vaults");
{
	const drive = new FakeDrive();
	const clock = { t: T0 };
	const backend = makeBackend(drive, null, clock);
	const res = await backend.now();
	s.check(res.status === "unavailable" && drive.files.size === 0, "without a live document nothing is written");
	const a = makeBackend(drive, makeDoc({ "a.md": "x" }), clock, "vaultA");
	const b = makeBackend(drive, makeDoc({ "b.md": "y" }), clock, "vaultB");
	await a.now();
	await b.now();
	s.check((await a.list()).length === 1 && (await b.list()).length === 1, "each vault has its own restore points");
	s.check(drive.namesIn("YAOS vaultA snapshots").length === 2 && drive.namesIn("YAOS vaultB snapshots").length === 2, "in separate folders");
}

s.section("Test 9: two devices taking the daily snapshot at once");
{
	const drive = new FakeDrive();
	const clock = { t: T0 };
	const doc = makeDoc({ "a.md": "x" });
	const a = makeBackend(drive, doc, clock);
	const b = makeBackend(drive, doc, clock);
	await Promise.all([a.daily("A"), b.daily("B")]);
	const list = await a.list();
	s.check(list.length >= 1 && list.length <= 2, "at most one duplicate (harmless), never lost");
	s.check((await a.daily("A")).status === "noop", "afterwards both see 'already taken'");
	const doc2 = await a.download(list[0] as SnapshotIndex);
	s.check(doc2.getMap("pathToId").size === 1, "and the content is intact");
}

s.section("Test 10: snapshot file layout");
{
	const drive = new FakeDrive();
	const clock = { t: T0 };
	const doc = makeDoc({ "a.md": "x" });
	const backend = makeBackend(drive, doc, clock);
	const res = await backend.now();
	const file = drive.filesIn(FOLDER).find((f) => f.name.startsWith("snapdat-"));
	s.check(file !== undefined && new TextDecoder().decode(file.data.subarray(0, 4)) === "YDS1", "data file has the checksummed header");
	const indexFile = drive.filesIn(FOLDER).find((f) => f.name.startsWith("snapidx-"));
	const parsed = JSON.parse(new TextDecoder().decode(indexFile?.data)) as SnapshotIndex;
	s.check(parsed.snapshotId === res.snapshotId && parsed.fullUpdateHash?.length === 64, "index is plain JSON with the content hash");
	s.check(/^\d{13}-[0-9a-f]{8}$/.test(parsed.snapshotId), "ids sort by time");
}

// ---------------------------------------------------------------------------
// The service: the default stays the Worker, byte for byte
// ---------------------------------------------------------------------------

interface Req { url: string; method?: string; headers?: Record<string, string>; body?: string }
const seen: Req[] = [];
let respond: (r: Req) => { status: number; json: unknown } = () => ({ status: 200, json: { status: "noop" } });
Object.assign(obsidian, { requestUrl: async (r: Req) => {
	seen.push(r);
	const out = respond(r);
	return { status: out.status, json: out.json, text: JSON.stringify(out.json), arrayBuffer: new ArrayBuffer(0) };
} });

const settings: VaultSyncSettings = { ...DEFAULT_SETTINGS, host: "https://w.example", token: "tok", vaultId: VAULT, deviceName: "dev" };

function makeService(opts: { backend?: SnapshotBackend | null; supported?: boolean; withDep?: boolean; connected?: boolean }) {
	const vaultSync = Object.assign(Object.create(VaultSync.prototype) as VaultSync, { ydoc: makeDoc() });
	Object.defineProperty(vaultSync, "connected", { value: opts.connected ?? true });
	const logs: string[] = [];
	const deps = {
		app: Object.create(App.prototype) as App,
		getSettings: () => settings,
		getTraceHttpContext: () => undefined,
		getVaultSync: () => vaultSync,
		getDiskMirror: () => null,
		getBlobSync: () => null,
		getServerSupportsSnapshots: () => opts.supported ?? true,
		log: (m: string) => { logs.push(m); },
		onEditorsNeedReconcile: () => {},
		...(opts.withDep === false ? {} : { getSnapshotBackend: () => opts.backend ?? null }),
	};
	return { service: new SnapshotService(deps), logs };
}

s.section("Test 11: Cloudflare snapshot requests are unchanged");
for (const withDep of [true, false]) {
	const label = withDep ? "(carrier hook present, null)" : "(no carrier hook at all)";
	const { service, logs } = makeService({ withDep });
	seen.length = 0;
	respond = () => ({ status: 200, json: { status: "created", snapshotId: "sid", index: { snapshotId: "sid", markdownFileCount: 1, blobFileCount: 0, crdtSizeBytes: 10 } } });
	await service.triggerDailySnapshot();
	s.check(seen.length === 1 && seen[0]?.url === `https://w.example/vault/${VAULT}/snapshots/maybe` && seen[0]?.method === "POST", `daily: POST .../snapshots/maybe ${label}`);
	s.check(seen[0]?.headers?.Authorization === "Bearer tok" && seen[0]?.body === JSON.stringify({ device: "dev" }), "with the bearer token and the device name");
	s.check(logs.some((l) => l.includes("Daily snapshot created: sid")), "and logs the result as before");
	seen.length = 0;
	await service.takeSnapshotNow();
	s.check(seen.length === 1 && seen[0]?.url === `https://w.example/vault/${VAULT}/snapshots` && seen[0]?.method === "POST", "now: POST .../snapshots");
	seen.length = 0;
	respond = () => ({ status: 200, json: { snapshots: [] } });
	await service.showSnapshotList();
	s.check(seen.length === 1 && seen[0]?.url === `https://w.example/vault/${VAULT}/snapshots?limit=50` && seen[0]?.method === "GET", "list: GET .../snapshots?limit=50");
	seen.length = 0;
	respond = () => ({ status: 200, json: { kept: 3, pruned: 1, failed: 0 } });
	await service.pruneSnapshots();
	s.check(seen.length === 1 && seen[0]?.url === `https://w.example/vault/${VAULT}/snapshots/prune` && seen[0]?.method === "POST", "prune: POST .../snapshots/prune");
	seen.length = 0;
	const unsupported = makeService({ withDep, supported: false });
	await unsupported.service.triggerDailySnapshot();
	await unsupported.service.takeSnapshotNow();
	s.check(seen.length === 0, "a server without snapshot support is not contacted");
}
{
	seen.length = 0;
	respond = () => ({ status: 200, json: {} });
	const backend = createServerSnapshotBackend(() => settings, () => undefined);
	const index = { snapshotId: "sid", vaultId: VAULT } as SnapshotIndex;
	await fails(() => backend.download(index));
	s.check(seen.length >= 1 && seen[0]?.url === `https://w.example/vault/${VAULT}/snapshots/sid` && seen[0]?.method === "GET", "download: GET .../snapshots/<id>");
}

s.section("Test 12: with a Drive backend the service never calls the Worker");
{
	const drive = new FakeDrive();
	const clock = { t: T0 };
	const doc = makeDoc({ "a.md": "x" });
	const backend = makeBackend(drive, doc, clock);
	const { service, logs } = makeService({ backend });
	seen.length = 0;
	await service.triggerDailySnapshot();
	s.check(drive.namesIn(FOLDER).length === 2 && seen.length === 0, "daily goes to Drive only");
	s.check(logs.some((l) => l.startsWith("Daily snapshot created")), "and is logged as before");
	await service.triggerDailySnapshot();
	s.check(logs.some((l) => l.includes("already taken today")), "a second call reports the noop");
	await service.takeSnapshotNow();
	s.check(drive.namesIn(FOLDER).length === 4 && seen.length === 0, "manual snapshot goes to Drive only");
	await service.showSnapshotList();
	await service.pruneSnapshots();
	s.check(seen.length === 0, "listing and cleanup never call the Worker");
	const failing = makeService({ backend, connected: false });
	await failing.service.takeSnapshotNow();
	s.check(drive.namesIn(FOLDER).length === 4, "when sync is not connected nothing is taken");
	drive.offline = true;
	const before = seen.length;
	await service.triggerDailySnapshot();
	s.check(seen.length === before, "a Drive failure in the background is swallowed, as before");
}

await s.done();

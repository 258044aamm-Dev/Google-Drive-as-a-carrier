/**
 * Drive carrier: attachments on Drive (DriveBlobStore), and the way the
 * attachment engine uses it. Includes golden checks that the default
 * (Cloudflare) attachment path still talks to the Worker exactly as before.
 */

import { App, TFile, type FileStats } from "obsidian";
import * as obsidian from "obsidian";
import * as Y from "yjs";
import { DriveError, type DriveApi } from "../../src/drive-carrier/driveApi";
import { createDriveCarrier } from "../../src/drive-carrier/driveCarrierRuntime";
import { DriveBlobStore, blobFolderName } from "../../src/drive-carrier/driveBlobStore";
import { sha256Hex } from "../../src/drive-carrier/driveFolders";
import { AttachmentOrchestrator } from "../../src/runtime/attachmentOrchestrator";
import { BlobSyncManager, type BlobStoreClient } from "../../src/sync/blobSync";
import { VaultSync } from "../../src/sync/vaultSync";
import type { BlobRef } from "../../src/types";
import { FakeDrive } from "../mocks/fakeDrive";
import { suite } from "../harness.ts";

const s = suite("drive-carrier-blobs");
const enc = new TextEncoder();

function buf(text: string): ArrayBuffer {
	const b = enc.encode(text);
	return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}
async function hashOf(text: string): Promise<string> {
	return sha256Hex(enc.encode(text));
}
async function fails(run: () => Promise<unknown>): Promise<Error | null> {
	try {
		await run();
	} catch (err) {
		return err instanceof Error ? err : new Error(String(err));
	}
	return null;
}

const VAULT = "v1";
const BLOBS = blobFolderName(VAULT);
let clock = 50_000_000;

function newStore(drive: FakeDrive, api: DriveApi = drive.client()): DriveBlobStore {
	return new DriveBlobStore(api, { vaultId: VAULT, now: () => clock });
}

s.section("Test 1: store, ask, fetch");
{
	const drive = new FakeDrive();
	const store = newStore(drive);
	const h = await hashOf("picture bytes");
	s.check((await store.exists([h])).length === 0, "nothing stored yet");
	await store.upload(h, "image/png", buf("picture bytes"), 5000);
	s.check(drive.namesIn(BLOBS).join() === h, "one file named by its hash, in the blobs folder");
	s.check(drive.folders.size === 1 && Array.from(drive.folders.values())[0]?.name === "YAOS v1 blobs", "the folder is 'YAOS <vault> blobs'");
	s.check(drive.namesIn("YAOS v1").length === 0, "the polled sync folder is not touched");
	s.check((await store.exists([h])).join() === h, "now it exists");
	const back = await store.download(h, 5000);
	s.check(new TextDecoder().decode(back) === "picture bytes", "bytes come back unchanged");
	const stored = drive.filesIn(BLOBS)[0];
	s.check(stored !== undefined && new TextDecoder().decode(stored.data) === "picture bytes", "file content is the raw attachment (no wrapper)");
	s.check((await store.exists([h, "0".repeat(64)])).join() === h, "exists returns only what is stored");
	s.check((await store.exists(["not-a-hash"])).length === 0, "a malformed hash is never reported as stored");
}

s.section("Test 2: refusing bad input");
{
	const drive = new FakeDrive();
	const store = newStore(drive);
	const h = await hashOf("real");
	const err = await fails(() => store.upload(h, "x/y", buf("something else"), 5000));
	s.check(err !== null && err.message.includes("does not match") && drive.files.size === 0 && drive.folders.size === 0, "content that does not match its hash is rejected before anything is created");
	const err2 = await fails(() => store.upload("zz", "x/y", buf("a"), 5000));
	s.check(err2 !== null && err2.message.includes("invalid hash") && drive.files.size === 0, "an invalid hash is rejected");
	const err3 = await fails(() => store.download("zz", 5000));
	s.check(err3 !== null && err3.message.includes("invalid hash"), "download of an invalid hash is rejected");
}

s.section("Test 3: missing and damaged attachments");
{
	const drive = new FakeDrive();
	const store = newStore(drive);
	const h = await hashOf("will be damaged");
	await store.upload(h, "a/b", buf("will be damaged"), 5000);
	const missing = await fails(() => store.download("a".repeat(64), 5000));
	s.check(missing instanceof DriveError && missing.status === 404 && missing.message.includes("404"), "a missing attachment is reported as 404");
	drive.corrupt(h, (d) => { d[0] = (d[0] ?? 0) ^ 0xff; return d; });
	const bad = await fails(() => store.download(h, 5000));
	s.check(bad instanceof DriveError && bad.status === 502 && bad.message.includes("damaged"), "a damaged attachment is never handed to the vault");
	drive.remove(h);
	const gone = await fails(() => store.download(h, 5000));
	s.check(gone instanceof DriveError && gone.status === 404, "a file deleted on Drive after being listed is reported as missing");
}

s.section("Test 4: upload verification");
{
	const drive = new FakeDrive();
	const real = drive.client();
	const lying: DriveApi = {
		findFolders: (n) => real.findFolders(n),
		createFolder: (n) => real.createFolder(n),
		listFiles: (f) => real.listFiles(f),
		createFile: async (f, n, d) => ({ ...(await real.createFile(f, n, d)), size: d.length - 1 }),
		readFile: (i) => real.readFile(i),
		deleteFile: (i) => real.deleteFile(i),
	};
	const store = newStore(drive, lying);
	const h = await hashOf("short changed");
	const err = await fails(() => store.upload(h, "a/b", buf("short changed"), 5000));
	s.check(err instanceof DriveError && err.status === 502, "a different stored size fails the upload");
	s.check(drive.files.size === 0, "and the bad file is removed");
	s.check((await store.exists([h])).length === 0, "it is not reported as stored");
}

s.section("Test 5: request budget for 'exists'");
{
	const drive = new FakeDrive();
	const store = newStore(drive);
	const h1 = await hashOf("one");
	await store.upload(h1, "a/b", buf("one"), 5000);
	const base = drive.calls.listFiles;
	await store.exists([h1]);
	s.check(drive.calls.listFiles === base, "a hash we uploaded ourselves needs no listing");
	const other = "b".repeat(64);
	await store.exists([other]);
	const afterFirstMiss = drive.calls.listFiles;
	s.check(afterFirstMiss === base + 1, "the first unknown hash triggers one listing");
	for (let i = 0; i < 20; i++) await store.exists([i.toString(16).padStart(64, "c")]);
	s.check(drive.calls.listFiles === afterFirstMiss, "twenty more unknown hashes in a burst cause no further listings");
	clock += 31_000;
	await store.exists([other]);
	s.check(drive.calls.listFiles === afterFirstMiss + 1, "after 30 seconds an unknown hash is re-checked");
}

s.section("Test 6: two devices");
{
	const drive = new FakeDrive();
	const a = newStore(drive);
	const b = newStore(drive);
	const h = await hashOf("shared photo");
	await a.upload(h, "a/b", buf("shared photo"), 5000);
	s.check(new TextDecoder().decode(await b.download(h, 5000)) === "shared photo", "the other device downloads it (listing on demand)");
	clock += 31_000;
	const c = newStore(drive);
	s.check((await c.exists([h])).join() === h, "a third device sees it too");
	// Both upload the same attachment at once: one folder, harmless duplicate, still readable.
	const h2 = await hashOf("same on both");
	await Promise.all([a.upload(h2, "a/b", buf("same on both"), 5000), b.upload(h2, "a/b", buf("same on both"), 5000)]);
	s.check(drive.folders.size === 1, "still one blobs folder");
	s.check(new TextDecoder().decode(await c.download(h2, 5000)) === "same on both", "duplicates resolve to the same bytes");
}

s.section("Test 7: folder creation races and failures");
{
	const drive = new FakeDrive();
	const s1 = newStore(drive, drive.client({ reverseFolders: true }));
	const s2 = newStore(drive);
	const h = await hashOf("race");
	await Promise.all([s1.upload(h, "a/b", buf("race"), 5000), s2.upload(await hashOf("race2"), "a/b", buf("race2"), 5000)]);
	const blobFolders = Array.from(drive.folders.values()).filter((f) => f.name === BLOBS);
	s.check(blobFolders.length >= 1, "folder created");
	clock += 31_000;
	const reader = newStore(drive, drive.client({ reverseFolders: true }));
	const present = await reader.exists([h, await hashOf("race2")]);
	s.check(present.length >= 1, "a reader picks a consistent folder");
}
{
	const drive = new FakeDrive();
	const store = newStore(drive);
	const h = await hashOf("retry");
	drive.failNext("createFolder", 500, 1);
	const err = await fails(() => store.upload(h, "a/b", buf("retry"), 5000));
	s.check(err instanceof DriveError && err.status === 500, "a folder failure surfaces so the engine retries");
	await store.upload(h, "a/b", buf("retry"), 5000);
	s.check(drive.namesIn(BLOBS).join() === h, "and the retry succeeds");
	drive.failNext("createFile", 429, 1);
	const h2 = await hashOf("limited");
	const err2 = await fails(() => store.upload(h2, "a/b", buf("limited"), 5000));
	s.check(err2 instanceof DriveError && err2.retryable, "a rate limit is reported as retryable");
	drive.offline = true;
	const err3 = await fails(() => store.download(h, 5000));
	s.check(err3 instanceof DriveError && err3.status === 0, "offline is a network error");
}

s.section("Test 8: timeouts");
{
	const drive = new FakeDrive();
	drive.latencyHook = async (op) => {
		if (op === "createFile") await new Promise((r) => setTimeout(r, 200));
	};
	const store = newStore(drive);
	const h = await hashOf("slow");
	const err = await fails(() => store.upload(h, "a/b", buf("slow"), 30));
	s.check(err instanceof DriveError && err.status === 408 && err.retryable, "a slow upload times out as a retryable error");
}

// ---------------------------------------------------------------------------
// The real attachment engine on top of the Drive store
// ---------------------------------------------------------------------------

interface StoredFile { file: TFile; data: ArrayBuffer }

function makeVault() {
	let tick = 1;
	const files = new Map<string, StoredFile>();
	const put = (path: string, data: ArrayBuffer): StoredFile => {
		const t = tick++;
		const stat: FileStats = { ctime: t, mtime: t, size: data.byteLength };
		const file = files.get(path)?.file ?? new TFile();
		file.path = path;
		file.stat = stat;
		const stored = { file, data };
		files.set(path, stored);
		return stored;
	};
	const vault = {
		getAbstractFileByPath: (p: string) => files.get(p)?.file ?? null,
		readBinary: async (f: TFile) => files.get(f.path)?.data ?? new ArrayBuffer(0),
		modifyBinary: async (f: TFile, d: ArrayBuffer) => { put(f.path, d); },
		createBinary: async (p: string, d: ArrayBuffer) => { put(p, d); },
		createFolder: async () => {},
		adapter: { stat: async (p: string) => files.get(p)?.file.stat ?? null },
		configDir: ".obsidian",
	};
	return { vault, files, put };
}

function makeSync(): VaultSync {
	const ydoc = new Y.Doc();
	return Object.assign(Object.create(VaultSync.prototype) as VaultSync, {
		ydoc,
		pathToBlob: ydoc.getMap<BlobRef>("pathToBlob"),
		blobTombstones: ydoc.getMap<{ deletedAt: number }>("blobTombstones"),
		blobMeta: ydoc.getMap<unknown>("blobMeta"),
		debug: false,
		_eventRing: [],
	});
}

function makeManager(store: BlobStoreClient, vaultFixture = makeVault(), sync = makeSync()) {
	const app = Object.assign(Object.create(App.prototype) as App, { vault: vaultFixture.vault, fileManager: {} });
	const manager = new BlobSyncManager(
		app,
		sync,
		{ host: "", token: "", vaultId: VAULT, maxAttachmentSizeKB: 1024, attachmentConcurrency: 1, debug: false, blobStore: store },
		{},
	);
	return { manager, ...vaultFixture, sync };
}

const item = (path: string): { path: string; sizeBytes: number; retries: number; status: "pending" | "processing"; readyAt: number; needsRerun: boolean; rerunResets: number } =>
	({ path, sizeBytes: 0, retries: 0, status: "processing", readyAt: 0, needsRerun: false, rerunResets: 0 });

s.section("Test 9: the attachment engine uploads to Drive and another device downloads from it");
{
	const drive = new FakeDrive();
	const storeA = newStore(drive);
	const a = makeManager(storeA);
	a.put("photos/cat.png", buf("cat pixels"));
	await a.manager["processUpload"](item("photos/cat.png") as never);
	const h = await hashOf("cat pixels");
	s.check(drive.namesIn(BLOBS).join() === h, "upload reached Drive");
	const ref = a.sync.getBlobRef("photos/cat.png");
	s.check(ref?.hash === h && ref.size === 10, "the document records the attachment (hash and size)");
	s.check(a.manager["uploadQueue"].size === 0, "the upload is finished (nothing left to retry)");

	// A second device, with the reference arriving through the document.
	const b = makeManager(newStore(drive));
	b.sync.setBlobRef("photos/cat.png", h, 10, "image/png");
	await b.manager["processDownload"]({ path: "photos/cat.png", hash: h, sizeBytes: 10, retries: 0, status: "processing", readyAt: 0, rerunResets: 0 } as never);
	const got = b.files.get("photos/cat.png");
	s.check(got !== undefined && new TextDecoder().decode(got.data) === "cat pixels", "the second device wrote the file from Drive");

	// The same picture under another name is not uploaded twice.
	a.put("photos/cat-copy.png", buf("cat pixels"));
	const creates = drive.calls.createFile;
	await a.manager["processUpload"](item("photos/cat-copy.png") as never);
	s.check(drive.calls.createFile === creates, "an identical attachment is not stored again");
	s.check(a.sync.getBlobRef("photos/cat-copy.png")?.hash === h, "but it still gets its own reference");
}

s.section("Test 10: failures leave the engine to retry");
{
	const drive = new FakeDrive();
	const a = makeManager(newStore(drive));
	a.put("x.png", buf("data"));
	drive.failNext("createFile", 503, 1);
	const it = item("x.png");
	await a.manager["processUpload"](it as never);
	s.check(a.sync.getBlobRef("x.png") === undefined, "no reference is published while the upload failed");
	s.check(it.retries === 1 && it.status === "pending", "the item is queued for a retry");
	a.manager.destroy();
}

// ---------------------------------------------------------------------------
// Orchestrator gating: Drive needs no host/token; Cloudflare is unchanged
// ---------------------------------------------------------------------------

interface Req { url: string; method?: string; headers?: Record<string, string> }
const seen: Req[] = [];
Object.assign(obsidian, { requestUrl: async (r: Req) => {
	seen.push(r);
	return { status: 200, json: { present: [] }, text: "", arrayBuffer: new ArrayBuffer(0) };
} });

function makeOrchestrator(opts: { host: string; token: string; store?: BlobStoreClient | null; supported?: boolean; withDep?: boolean }) {
	const sync = makeSync();
	const app = Object.assign(Object.create(App.prototype) as App, {
		vault: makeVault().vault,
		fileManager: {},
		workspace: { layoutReady: true, onLayoutReady: (cb: () => void) => cb() },
	});
	const logs: string[] = [];
	const deps = {
		app,
		getVaultSync: () => sync,
		getRuntimeConfig: () => ({
			host: opts.host, token: opts.token, vaultId: VAULT, enableAttachmentSync: true,
			maxAttachmentSizeKB: 1024, attachmentConcurrency: 1, debug: false,
		}),
		getServerSupportsAttachments: () => opts.supported ?? true,
		getTraceHttpContext: () => undefined,
		getBlobHashCache: () => ({}),
		getExcludePatterns: () => [] as string[],
		persistBlobQueue: async () => {},
		clearPersistedBlobQueue: async () => {},
		getPreservedUnresolvedEntries: () => [],
		onPreservedUnresolvedChanged: () => {},
		trace: () => {},
		scheduleTraceStateSnapshot: () => {},
		refreshStatusBar: () => {},
		log: (m: string) => { logs.push(m); },
		...(opts.withDep === false ? {} : { getBlobStore: () => opts.store ?? null }),
	};
	return new AttachmentOrchestrator(deps as never);
}

s.section("Test 11: Cloudflare behaviour of the attachment engine is unchanged");
{
	// Not configured: nothing starts (as before).
	const none = makeOrchestrator({ host: "", token: "", store: null });
	none.start("t", false);
	s.check(none.manager === null, "no host and no token: engine does not start");
	const noToken = makeOrchestrator({ host: "https://w.example", token: "", store: null });
	noToken.start("t", false);
	s.check(noToken.manager === null, "host without token: engine does not start");
	const unsupported = makeOrchestrator({ host: "https://w.example", token: "tok", store: null, supported: false });
	unsupported.start("t", false);
	s.check(unsupported.manager === null, "server without attachment support: engine does not start");
	// Configured: starts, and talks to the Worker exactly as before.
	const cf = makeOrchestrator({ host: "https://w.example", token: "tok", store: null });
	cf.start("t", false);
	s.check(cf.manager !== null, "configured: engine starts");
	seen.length = 0;
	const present = await cf.manager?.["blobClient"].exists(["abc"]);
	s.check(present?.length === 0 && seen.length === 1, "one request goes out");
	s.check(seen[0]?.url === `https://w.example/vault/${VAULT}/blobs/exists` && seen[0]?.method === "POST", "to the Worker's blob endpoint");
	s.check(seen[0]?.headers?.Authorization === "Bearer tok", "with the bearer token");
	// An orchestrator built without the new dependency at all behaves the same.
	const legacy = makeOrchestrator({ host: "https://w.example", token: "tok", withDep: false });
	legacy.start("t", false);
	s.check(legacy.manager !== null, "a host that does not know about carriers still works");
	const legacyNoHost = makeOrchestrator({ host: "", token: "", withDep: false });
	legacyNoHost.start("t", false);
	s.check(legacyNoHost.manager === null, "and still refuses to start without a host");
	await Promise.all([none.destroy(), noToken.destroy(), unsupported.destroy(), cf.destroy(), legacy.destroy(), legacyNoHost.destroy()]);
}

s.section("Test 12: with a Drive store the engine starts without a host or token and never calls the Worker");
{
	const drive = new FakeDrive();
	const store = newStore(drive);
	const o = makeOrchestrator({ host: "", token: "", store });
	seen.length = 0;
	o.start("t", false);
	s.check(o.manager !== null, "engine starts");
	s.check(o.manager?.["blobClient"] === store, "and uses the Drive store");
	const h = await hashOf("pdf");
	await o.manager?.["blobClient"].upload(h, "application/pdf", buf("pdf"), 5000);
	s.check(seen.length === 0, "no request went to a Worker");
	await o.destroy();
}

s.section("Test 13: the carrier hands out one store per vault and does nothing until used");
{
	let httpCalls = 0;
	const carrier = createDriveCarrier({
		getSettings: () => ({ carrier: "drive", driveClientId: "i", driveClientSecret: "x", driveRefreshToken: "r", driveDeviceId: "d" }) as never,
		http: (async () => { httpCalls++; throw new Error("no network in this test"); }) as never,
		log: () => {},
		onSignInLost: () => {},
	});
	s.check(httpCalls === 0, "building the carrier makes no request");
	const a1 = carrier.blobStore("a");
	s.check(a1 === carrier.blobStore("a") && a1 !== carrier.blobStore("b"), "one blob store per vault");
	const doc = new Y.Doc();
	const sn = carrier.snapshotBackend("a", () => doc);
	s.check(sn === carrier.snapshotBackend("a", () => doc) && sn !== carrier.snapshotBackend("b", () => doc), "one snapshot backend per vault");
	s.check(httpCalls === 0, "handing them out makes no request either");
}

await s.done();

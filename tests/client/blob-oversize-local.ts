/**
 * Upstream issue #75: an attachment that grew past this device's size limit was
 * dropped from the upload/reconcile set but stayed in the synced list, so the
 * download path overwrote it with the older synced copy without a word.
 * Real BlobSyncManager, in-memory vault and store.
 */
import { App, TFile, type FileStats } from "obsidian";
import * as obsidian from "obsidian";
import * as Y from "yjs";
import { BlobSyncManager, type BlobStoreClient } from "../../src/sync/blobSync";
import { VaultSync } from "../../src/sync/vaultSync";
import type { BlobRef } from "../../src/types";
import { sha256Hex } from "../../src/drive-carrier/driveFolders";
import { suite } from "../harness.ts";

const s = suite("blob-oversize-local");
const enc = new TextEncoder();
const bytes = (text: string): ArrayBuffer => { const b = enc.encode(text); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const hashOf = (text: string): Promise<string> => sha256Hex(enc.encode(text));
const text = (b: ArrayBuffer | undefined): string => (b ? new TextDecoder().decode(b) : "");

let notices = 0;
Object.assign(obsidian, { Notice: class { constructor() { notices++; } } });

interface Rig {
	manager: BlobSyncManager;
	files: Map<string, { file: TFile; data: ArrayBuffer }>;
	sync: VaultSync;
	downloads: string[];
}

function rig(limitKB: number): Rig {
	let tick = 1;
	const files = new Map<string, { file: TFile; data: ArrayBuffer }>();
	const put = (path: string, data: ArrayBuffer) => {
		const stat: FileStats = { ctime: tick, mtime: tick++, size: data.byteLength };
		const file = files.get(path)?.file ?? new TFile();
		file.path = path;
		file.stat = stat;
		files.set(path, { file, data });
	};
	const vault = {
		getAbstractFileByPath: (p: string) => files.get(p)?.file ?? null,
		getFiles: () => [...files.values()].map((f) => f.file),
		readBinary: async (f: TFile) => files.get(f.path)?.data ?? new ArrayBuffer(0),
		modifyBinary: async (f: TFile, d: ArrayBuffer) => { put(f.path, d); },
		createBinary: async (p: string, d: ArrayBuffer) => { put(p, d); },
		createFolder: async () => undefined,
		adapter: { stat: async (p: string) => files.get(p)?.file.stat ?? null },
		configDir: ".obsidian",
	};
	const ydoc = new Y.Doc();
	const sync: VaultSync = Object.assign(Object.create(VaultSync.prototype) as VaultSync, {
		ydoc,
		pathToBlob: ydoc.getMap<BlobRef>("pathToBlob"),
		blobTombstones: ydoc.getMap<{ deletedAt: number }>("blobTombstones"),
		blobMeta: ydoc.getMap<unknown>("blobMeta"),
		debug: false,
		_eventRing: [],
	});
	const downloads: string[] = [];
	const remote = new Map<string, ArrayBuffer>();
	const store: BlobStoreClient = {
		upload: async () => undefined,
		download: async (hash) => { downloads.push(hash); const d = remote.get(hash); if (!d) throw new Error("missing"); return d; },
		exists: async (hashes) => hashes.filter((h) => remote.has(h)),
	};
	const app = Object.assign(Object.create(App.prototype) as App, { vault, fileManager: {} });
	const manager = new BlobSyncManager(app, sync, { host: "", token: "", vaultId: "v", maxAttachmentSizeKB: limitKB, attachmentConcurrency: 1, debug: false, blobStore: store }, {});
	const api = { manager, files, sync, downloads };
	return Object.assign(api, {
		put,
		offer: async (path: string, content: string) => {
			const h = await hashOf(content);
			remote.set(h, bytes(content));
			sync.setBlobRef(path, h, content.length, "image/png");
			return h;
		},
	});
}
type Full = Rig & { put: (p: string, d: ArrayBuffer) => void; offer: (p: string, c: string) => Promise<string> };
const download = (r: Rig, path: string, hash: string) =>
	r.manager["processDownload"]({ path, hash, sizeBytes: 5, retries: 0, status: "processing", readyAt: 0, rerunResets: 0 } as never);

const BIG = "B".repeat(3000); // over a 1 KB limit
const SMALL = "s".repeat(200);

s.section("1: a local file over the limit is not replaced by the synced copy");
{
	const r = rig(1) as Full;
	r.put("pics/photo.png", bytes(BIG));
	const h = await r.offer("pics/photo.png", "old synced version");
	notices = 0;
	await download(r, "pics/photo.png", h);
	s.check(text(r.files.get("pics/photo.png")?.data) === BIG, "the local bytes are untouched");
	s.check(r.downloads.length === 0, "nothing is fetched from the store");
	s.check(r.manager.oversizedLocalSkips === 1, "the skip is counted");
	s.check(notices === 1, `the user gets one notice (got ${notices})`);
	s.check(!r.manager["downloadQueue"].has("pics/photo.png"), "the item leaves the queue, so it is not retried forever");
	await download(r, "pics/photo.png", h);
	s.check(r.manager.oversizedLocalSkips === 2 && notices === 1, "a repeat is counted but the notice is not repeated");
}

s.section("2: everything else behaves as before");
{
	const r = rig(1) as Full;
	r.put("small.png", bytes(SMALL));
	const h = await r.offer("small.png", "newer synced version");
	await download(r, "small.png", h);
	s.check(text(r.files.get("small.png")?.data) === "newer synced version", "a file within the limit is still updated from the synced copy");

	const h2 = await r.offer("fresh.png", "brand new");
	await download(r, "fresh.png", h2);
	s.check(text(r.files.get("fresh.png")?.data) === "brand new", "a missing file is still created");
	s.check(r.manager.oversizedLocalSkips === 0, "no skip was counted");

	const u = rig(0) as Full; // 0 = no limit
	u.put("huge.png", bytes(BIG));
	const h3 = await u.offer("huge.png", "synced");
	await download(u, "huge.png", h3);
	s.check(text(u.files.get("huge.png")?.data) === "synced", "with no limit set, a big file is replaced as before");
}

s.section("3: the same through a reconcile");
{
	const r = rig(1) as Full;
	r.put("pics/photo.png", bytes(BIG));
	await r.offer("pics/photo.png", "old synced version");
	r.manager.reconcile("authoritative", []);
	r.manager.openDownloadGate("test"); // downloads wait for this at startup
	for (let i = 0; i < 100 && r.manager["downloadQueue"].size > 0; i++) await new Promise((res) => setTimeout(res, 10));
	s.check(text(r.files.get("pics/photo.png")?.data) === BIG, "after reconcile and the download drain the local file is still there");
	s.check(r.manager.oversizedLocalSkips >= 1, "and the skip was counted");
	await new Promise((res) => setTimeout(res, 20));
}
await s.done();

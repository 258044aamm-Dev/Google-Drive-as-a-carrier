/**
 * Drive carrier + engine: deletions that must stay deleted.
 *
 * Real VaultSync and DiskMirror (in-memory vault) over the fake Drive. Reproduces
 * the two ways a deleted note used to come back:
 *  1. edit + delete delivered in ONE poll: the receiving device compared its
 *     not-yet-updated disk file with the already-updated document, called the file
 *     "locally modified" and revived the note with the OLD text;
 *  2. two devices created the same path before they saw each other, so one path had
 *     two active ids and a delete only tombstoned one.
 */
import { TFile, type App } from "obsidian";
import * as Y from "yjs";
import { VaultSync } from "../../src/sync/vaultSync";
import { DiskMirror } from "../../src/sync/diskMirror";
import type { EditorBindingManager } from "../../src/sync/editorBinding";
import { DEFAULT_SETTINGS } from "../../src/settings/settingsStore";
import { DriveTransport } from "../../src/drive-carrier/driveTransport";
import { FakeDrive } from "../mocks/fakeDrive";
import { fixtureOf, partialOf } from "../mocks/productFixture.ts";
import { readField } from "../mocks/readField.ts";
import { readSource, suite } from "../harness.ts";

process.on("unhandledRejection", (reason) => {
	if (reason instanceof ReferenceError && /indexedDB/.test(reason.message)) return;
	throw reason instanceof Error ? reason : new Error(String(reason));
});
const s = suite("drive-carrier-engine");
let T = 1_700_000_000_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Device {
	name: string;
	vs: VaultSync;
	tr: DriveTransport;
	mirror: DiskMirror;
	disk: Map<string, string>;
	put: (path: string, content: string) => void;
	trashed: string[];
	flight: string[];
}

function makeDevice(drive: FakeDrive, name: string, useBaseline: boolean): Device {
	const holder: { tr?: DriveTransport } = {};
	const vs = new VaultSync({ ...DEFAULT_SETTINGS, vaultId: "race", deviceName: name }, {
		transportFactory: (ctx) => {
			holder.tr = new DriveTransport(ctx.doc, drive.client(), { vaultId: "race", deviceId: name, autoTimers: false, now: () => T, ignoreOrigin: ctx.isLocalStoreOrigin, reconcileIntervalMs: 1 });
			return holder.tr;
		},
	});
	if (!holder.tr) throw new Error("transport was not created");
	const disk = new Map<string, string>();
	const files = new Map<string, TFile>();
	const trashed: string[] = [];
	const put = (path: string, content: string): void => {
		disk.set(path, content);
		files.set(path, fixtureOf<TFile>(TFile, { path, stat: { ctime: 1, mtime: Date.now(), size: content.length } }));
	};
	const app = partialOf<App>({
		vault: {
			getAbstractFileByPath: (path: string) => files.get(path) ?? null,
			read: async (file: TFile) => disk.get(file.path) ?? "",
			modify: async (file: TFile, content: string) => { put(file.path, content); },
			create: async (path: string, content: string) => { put(path, content); return files.get(path) as TFile; },
		},
		fileManager: { trashFile: async (file) => { disk.delete(file.path); files.delete(file.path); trashed.push(file.path); } },
		workspace: { getActiveViewOfType: () => null },
	});
	const editorBindings = partialOf<EditorBindingManager>({
		unbindByPath: () => undefined,
		getLastEditorActivityForPath: () => null,
	});
	const mirror = new DiskMirror(app, vs, editorBindings, false, undefined, () => false, undefined, () => name);
	const flight: string[] = [];
	mirror.setFlightEventHandler((event) => {
		const reason = readField(event, "data", "reason");
		flight.push(`${String(readField(event, "kind"))}:${typeof reason === "string" ? reason : ""}`);
	});
	const index = new Map<string, string>();
	mirror.setDiskWriteCallback((path, hash) => { index.set(path, hash); });
	if (useBaseline) mirror.setRemoteDeleteBaselineProvider((path) => index.get(path) ?? null);
	mirror.startMapObservers();
	return { name, vs, tr: holder.tr, mirror, disk, put, trashed, flight };
}

const sync = async (...ns: { tr: DriveTransport }[]) => { for (let r = 0; r < 3; r++) for (const n of ns) { T += 61_000; await n.tr.syncNow(); } };
/** Number of active file entries for `path` in the metadata map. */
function activeIdCount(vs: VaultSync, path: string): number {
	let n = 0;
	vs.ydoc.getMap("meta").forEach((entry) => {
		const json: unknown = entry instanceof Y.Map ? entry.toJSON() : entry;
		if (readField(json, "path") === path && readField(json, "deletedAt") === undefined) n++;
	});
	return n;
}

async function run(opts: { baseline: boolean; computerPollsAfterEdit: boolean; localEditOnComputer?: string }) {
	const drive = new FakeDrive();
	const A = makeDevice(drive, "phone", opts.baseline); const B = makeDevice(drive, "computer", opts.baseline);
	await sync(A, B);
	A.vs.ensureFile("n.md", "version 1", "phone"); A.put("n.md", "version 1");
	await sync(A, B); await sleep(500);
	s.check(B.disk.get("n.md") === "version 1", "setup: the computer wrote version 1 to its disk");
	if (opts.localEditOnComputer !== undefined) B.put("n.md", opts.localEditOnComputer);
	const t = A.vs.getTextForPath("n.md")!;
	A.vs.ydoc.transact(() => { t.delete(0, t.length); t.insert(0, "version 2 edited on phone"); }, "user-edit");
	await A.tr.syncNow();
	if (opts.computerPollsAfterEdit) { T += 61_000; await B.tr.syncNow(); await sleep(1800); }
	A.vs.handleDelete("n.md", "phone");
	await A.tr.syncNow();
	T += 61_000; await B.tr.syncNow();
	await sleep(1800);
	await sync(B, A); await sleep(300);
	const result = {
		computerHasFile: B.disk.has("n.md"),
		computerDisk: B.disk.get("n.md") ?? null,
		phoneActive: A.vs.getActiveMarkdownPaths().includes("n.md"),
		phoneText: A.vs.getTextForPath("n.md")?.toString() ?? null,
		flight: B.flight,
	};
	for (const d of [A, B]) await d.vs.destroy().catch(() => undefined);
	return result;
}

s.section("1a: control, the computer polls between the edit and the delete");
{
	const r = await run({ baseline: true, computerPollsAfterEdit: true });
	s.check(!r.computerHasFile && !r.phoneActive, "the note is deleted on both devices");
}

s.section("1b: edit and delete arrive in one poll (the bug), with the baseline wired for Drive");
{
	const r = await run({ baseline: true, computerPollsAfterEdit: false });
	s.check(!r.computerHasFile, `the computer deletes its untouched copy (disk: ${JSON.stringify(r.computerDisk)})`);
	s.check(!r.phoneActive, `the phone's delete is not undone (phone text: ${JSON.stringify(r.phoneText)})`);
	s.check(r.flight.some((k) => k.startsWith("delete.disk.applied")), "the delete was applied, not preserved");
}

s.section("1c: the same, but the user really edited the note on the computer: local work still wins");
{
	const r = await run({ baseline: true, computerPollsAfterEdit: false, localEditOnComputer: "version 1 plus my own words on the computer" });
	s.check(r.computerHasFile && r.computerDisk === "version 1 plus my own words on the computer", "the computer keeps the locally edited file");
	s.check(r.phoneActive && r.phoneText === "version 1 plus my own words on the computer", "and the note is revived with the user's text, not the old text");
	s.check(r.flight.some((k) => k.startsWith("delete.preserved")), "preservation is recorded");
}

s.section("1d: without the Drive baseline provider the engine behaves exactly as before");
{
	const r = await run({ baseline: false, computerPollsAfterEdit: false });
	s.check(r.computerHasFile && r.phoneActive && r.phoneText === "version 1", "the original behaviour is unchanged (characterisation of the Cloudflare path)");
}

s.section("2: two ids for one path: one delete removes the note");
{
	const drive = new FakeDrive();
	const A = makeDevice(drive, "A", true); const B = makeDevice(drive, "B", true);
	await sync(A, B);
	A.vs.ensureFile("Untitled.md", "A text", "A"); T += 5000;
	B.vs.ensureFile("Untitled.md", "B text", "B");
	await A.tr.syncNow(); T += 61_000; await B.tr.syncNow(); T += 61_000; await A.tr.syncNow();
	s.check(activeIdCount(A.vs, "Untitled.md") === 2, "setup: the path has two active ids before any integrity pass");
	A.vs.handleDelete("Untitled.md", "A");
	s.check(activeIdCount(A.vs, "Untitled.md") === 0 && !A.vs.getActiveMarkdownPaths().includes("Untitled.md"), "after one delete no active id is left");
	const files = new Map<string, string>(); const present = new Set<string>();
	const reopen = A.vs.reconcileVault(files, present, "authoritative", "A");
	s.check(reopen.createdOnDisk.length === 0, "a reopen does not write the note back");
	await sync(A, B);
	s.check(!B.vs.getActiveMarkdownPaths().includes("Untitled.md"), "the other device agrees");
	for (const d of [A, B]) await d.vs.destroy().catch(() => undefined);
}

s.section("3: the carrier flag is what enables it (Cloudflare construction keeps the old delete)");
{
	const src = readSource("src/sync/vaultSync.ts");
	s.check(/_tombstoneDuplicateIds = transportFactory !== undefined/.test(src), "duplicate-id tombstoning is tied to a non-Cloudflare transport");
	const main = readSource("src/main.ts");
	s.check(/if \(isDriveCarrier\(this\.settings\)\) \{\s*this\.diskMirror\.setRemoteDeleteBaselineProvider/.test(main), "the baseline provider is only wired in Drive mode");
}

await s.done();

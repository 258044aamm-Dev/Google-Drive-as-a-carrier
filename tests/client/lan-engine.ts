/**
 * Local network carrier + engine: real VaultSync and DiskMirror (in-memory vault) on two
 * devices, joined by real secure links on loopback. Notes must travel, deletes must stay
 * deleted, late and restarted devices must catch up, and concurrent typing must not lose text.
 */
import { TFile, type App } from "obsidian";
import * as Y from "yjs";
import { VaultSync } from "../../src/sync/vaultSync";
import { DiskMirror } from "../../src/sync/diskMirror";
import type { EditorBindingManager } from "../../src/sync/editorBinding";
import { DEFAULT_SETTINGS } from "../../src/settings/settingsStore";
import { LanTransport } from "../../src/lan-carrier/lanTransport";
import { LanHub } from "../../src/lan-carrier/lanHub";
import { fingerprintOfPem } from "../../src/lan-carrier/lanCert";
import { certFor, generateLanKey, sleep, waitFor } from "../mocks/lanRig";
import { fixtureOf, partialOf } from "../mocks/productFixture.ts";
import { suite } from "../harness.ts";

process.on("unhandledRejection", (reason) => {
	if (reason instanceof ReferenceError && /indexedDB/.test(reason.message)) return;
	throw reason instanceof Error ? reason : new Error(String(reason));
});
const s = suite("lan-engine");
const key = generateLanKey();

interface Device {
	name: string;
	vs: VaultSync;
	tr: LanTransport;
	mirror: DiskMirror;
	disk: Map<string, string>;
	put: (path: string, content: string) => void;
	remove: (path: string) => void;
	port: () => number;
}

function makeDevice(name: string, vaultId = "lan-engine"): Device {
	const holder: { tr?: LanTransport } = {};
	const vs = new VaultSync({ ...DEFAULT_SETTINGS, vaultId, deviceName: name }, {
		transportFactory: (ctx) => {
			const pins = new Map<string, string>();
			holder.tr = new LanTransport(ctx.doc, {
				ignoreOrigin: ctx.isLocalStoreOrigin,
				ackDelayMs: 10,
				onProblem: () => undefined,
				createHub: (hooks) => new LanHub({
					deviceId: `dev-${name}`, deviceName: name, vaultId, key, port: 0, discoveryPort: 0, discoveryEnabled: false,
					manualPeers: [], cert: { ...certFor(name), fingerprint: fingerprintOfPem(certFor(name).certPem) },
					getPin: (id) => pins.get(id), setPin: (id, fp) => { pins.set(id, fp); },
					onLinkReady: hooks.onLinkReady, onStatusChanged: hooks.onStatusChanged,
					reconnectBaseMs: 50, reconnectMaxMs: 300, dialDelayMs: 0,
				}),
			});
			return holder.tr;
		},
	});
	if (!holder.tr) throw new Error("transport was not created");
	const tr = holder.tr;
	const disk = new Map<string, string>();
	const files = new Map<string, TFile>();
	const put = (path: string, content: string): void => {
		disk.set(path, content);
		files.set(path, fixtureOf<TFile>(TFile, { path, stat: { ctime: 1, mtime: Date.now(), size: content.length } }));
	};
	const remove = (path: string): void => { disk.delete(path); files.delete(path); };
	const app = partialOf<App>({
		vault: {
			getAbstractFileByPath: (path: string) => files.get(path) ?? null,
			read: async (file: TFile) => disk.get(file.path) ?? "",
			modify: async (file: TFile, content: string) => { put(file.path, content); },
			create: async (path: string, content: string) => { put(path, content); return files.get(path) as TFile; },
		},
		fileManager: { trashFile: async (file) => { remove(file.path); } },
		workspace: { getActiveViewOfType: () => null },
	});
	const editorBindings = partialOf<EditorBindingManager>({ unbindByPath: () => undefined, getLastEditorActivityForPath: () => null });
	const mirror = new DiskMirror(app, vs, editorBindings, false, undefined, () => false, undefined, () => name);
	const index = new Map<string, string>();
	mirror.setDiskWriteCallback((path, hash) => { index.set(path, hash); });
	mirror.setRemoteDeleteBaselineProvider((path) => index.get(path) ?? null);
	mirror.startMapObservers();
	return { name, vs, tr, mirror, disk, put, remove, port: () => tr.hub.status().port ?? 0 };
}

/** VaultSync starts its transport itself; wait until the hubs really listen so their ports are known. */
const listening = async (...ds: Device[]): Promise<void> => { await waitFor(() => ds.every((d) => d.port() > 0), 5000); };
const linkAll = async (a: Device, b: Device): Promise<void> => {
	await a.tr.connect();
	await b.tr.connect();
	await listening(a, b);
	b.tr.hub.setManualPeers([`127.0.0.1:${a.port()}`]);
	await waitFor(() => a.tr.synced && b.tr.synced, 8000);
};
const stop = async (...ds: Device[]): Promise<void> => { for (const d of ds) { d.tr.destroy(); await d.vs.destroy().catch(() => undefined); } };

s.section("1: a note made on one device appears on the other, edits follow, a delete removes it");
{
	const a = makeDevice("A"); const b = makeDevice("B");
	await linkAll(a, b);
	s.check(a.tr.wsconnected && b.tr.wsconnected, "both devices are linked");
	a.vs.ensureFile("Plan.md", "first draft", "A"); a.put("Plan.md", "first draft");
	s.check(await waitFor(() => b.disk.get("Plan.md") === "first draft", 6000), "B wrote the new note to its disk");
	const t = a.vs.getTextForPath("Plan.md")!;
	a.vs.ydoc.transact(() => { t.delete(0, t.length); t.insert(0, "second draft"); }, "user-edit");
	s.check(await waitFor(() => b.vs.getTextForPath("Plan.md")?.toString() === "second draft", 6000), "B receives the edit");
	s.check(await waitFor(() => b.disk.get("Plan.md") === "second draft", 6000), "and writes it to its disk");
	a.vs.handleDelete("Plan.md", "A"); a.remove("Plan.md");
	s.check(await waitFor(() => !b.disk.has("Plan.md") && !b.vs.getActiveMarkdownPaths().includes("Plan.md"), 6000), "B removes the note when A deletes it");
	await sleep(1500);
	s.check(!b.disk.has("Plan.md") && !a.vs.getActiveMarkdownPaths().includes("Plan.md"), "and it stays gone on both");
	await stop(a, b);
}

s.section("2: a device that joins late receives every note and every delete");
{
	const a = makeDevice("A2", "late");
	await a.tr.connect(); await listening(a);
	for (const n of ["one", "two", "three"]) { a.vs.ensureFile(`${n}.md`, `note ${n}`, "A2"); a.put(`${n}.md`, `note ${n}`); }
	a.vs.handleDelete("two.md", "A2"); a.remove("two.md");
	const b = makeDevice("B2", "late");
	await linkAll(a, b);
	s.check(await waitFor(() => b.disk.get("one.md") === "note one" && b.disk.get("three.md") === "note three", 8000), "the late device wrote both live notes");
	await sleep(800);
	s.check(!b.disk.has("two.md"), "and not the deleted one");
	await stop(a, b);
}

s.section("3: both devices type in the same note at once: nothing is lost, both end identical");
{
	const a = makeDevice("A3", "typing"); const b = makeDevice("B3", "typing");
	await linkAll(a, b);
	a.vs.ensureFile("Shared.md", "base. ", "A3"); a.put("Shared.md", "base. ");
	await waitFor(() => b.disk.get("Shared.md") === "base. ", 6000);
	const ta = a.vs.getTextForPath("Shared.md")!; const tb = b.vs.getTextForPath("Shared.md")!;
	a.vs.ydoc.transact(() => { ta.insert(ta.length, "from A. "); }, "user-edit");
	b.vs.ydoc.transact(() => { tb.insert(tb.length, "from B. "); }, "user-edit");
	const merged = (d: Device): string => d.vs.getTextForPath("Shared.md")?.toString() ?? "";
	s.check(await waitFor(() => merged(a) === merged(b) && merged(a).includes("from A.") && merged(a).includes("from B."), 6000), `identical and complete (${JSON.stringify(merged(a))})`);
	s.check(await waitFor(() => a.disk.get("Shared.md") === merged(a) && b.disk.get("Shared.md") === merged(b), 6000), "and both disks hold the merged text");
	await stop(a, b);
}

s.section("4: both devices create the same path before meeting: one note, one delete removes it");
{
	const a = makeDevice("A4", "twins"); const b = makeDevice("B4", "twins");
	await a.tr.connect(); await b.tr.connect(); await listening(a, b);
	a.vs.ensureFile("Untitled.md", "A text", "A4"); b.vs.ensureFile("Untitled.md", "B text", "B4");
	b.tr.hub.setManualPeers([`127.0.0.1:${a.port()}`]);
	await waitFor(() => a.tr.synced && b.tr.synced, 8000);
	await sleep(500);
	a.vs.handleDelete("Untitled.md", "A4");
	s.check(await waitFor(() => !a.vs.getActiveMarkdownPaths().includes("Untitled.md") && !b.vs.getActiveMarkdownPaths().includes("Untitled.md"), 6000), "after one delete neither device lists the note");
	await stop(a, b);
}

s.section("5: a device that was closed while the other kept working catches up when it comes back");
{
	const a = makeDevice("A5", "away"); let b = makeDevice("B5", "away");
	await linkAll(a, b);
	a.vs.ensureFile("Kept.md", "kept", "A5"); a.put("Kept.md", "kept");
	await waitFor(() => b.disk.get("Kept.md") === "kept", 6000);
	const doc = b.vs.ydoc; const saved = Y.encodeStateAsUpdate(doc); // what B had stored locally
	await stop(b);
	a.vs.ensureFile("While.md", "written while B was off", "A5"); a.put("While.md", "written while B was off");
	a.vs.handleDelete("Kept.md", "A5"); a.remove("Kept.md");
	b = makeDevice("B5", "away");
	Y.applyUpdate(b.vs.ydoc, saved, "local-store");
	b.put("Kept.md", "kept");
	await b.tr.connect(); await listening(a, b);
	b.tr.hub.setManualPeers([`127.0.0.1:${a.port()}`]);
	s.check(await waitFor(() => b.disk.get("While.md") === "written while B was off", 8000), "the returning device receives what it missed");
	s.check(await waitFor(() => !b.disk.has("Kept.md"), 8000), "and removes the note that was deleted meanwhile");
	await stop(a, b);
}

s.section("6: a stranger with another key never receives a note");
{
	const a = makeDevice("A6", "secret");
	await a.tr.connect(); await listening(a);
	a.vs.ensureFile("Private.md", "private", "A6"); a.put("Private.md", "private");
	const holder: { tr?: LanTransport } = {};
	const stranger = new VaultSync({ ...DEFAULT_SETTINGS, vaultId: "secret", deviceName: "S" }, {
		transportFactory: (ctx) => {
			holder.tr = new LanTransport(ctx.doc, { ignoreOrigin: ctx.isLocalStoreOrigin, onProblem: () => undefined, createHub: (hooks) => new LanHub({
				deviceId: "dev-stranger", deviceName: "S", vaultId: "secret", key: generateLanKey(), port: 0, discoveryPort: 0, discoveryEnabled: false,
				manualPeers: [], cert: { ...certFor("S"), fingerprint: fingerprintOfPem(certFor("S").certPem) }, getPin: () => undefined, setPin: () => undefined,
				onLinkReady: hooks.onLinkReady, onStatusChanged: hooks.onStatusChanged, reconnectBaseMs: 50, reconnectMaxMs: 300, dialDelayMs: 0,
			}) });
			return holder.tr;
		},
	});
	await holder.tr!.connect(); await listening(a); await waitFor(() => (holder.tr?.hub.status().port ?? 0) > 0, 5000);
	holder.tr!.hub.setManualPeers([`127.0.0.1:${a.port()}`]);
	await sleep(2000);
	s.check(!holder.tr!.synced && stranger.getActiveMarkdownPaths().length === 0, "the stranger holds no notes");
	holder.tr!.destroy(); await stranger.destroy().catch(() => undefined);
	await stop(a);
}
await s.done();

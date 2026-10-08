/**
 * SYNC-01: a note this device had in sync and then lost from disk (deleted while
 * YAOS was off, or before the first reconcile) is recorded as deleted instead of
 * being written back. Real VaultSync and ReconciliationController, fake app.
 */
import { TFile, type App } from "obsidian";
import * as Y from "yjs";
import { ReconciliationController } from "../../src/runtime/reconciliationController";
import type { RuntimeConfig } from "../../src/runtime/runtimeConfig";
import {
	classifyMissingOnDisk,
	evaluateOfflineDeleteBatch,
} from "../../src/runtime/reconcile/offlineDeletePolicy";
import { contentBaselineHash, type DiskIndex } from "../../src/sync/diskIndex";
import type { DiskMirror } from "../../src/sync/diskMirror";
import { VaultSync, type ReconcileMode } from "../../src/sync/vaultSync";
import { DEFAULT_SETTINGS, type VaultSyncSettings } from "../../src/settings/settingsStore";
import { DriveTransport } from "../../src/drive-carrier/driveTransport";
import { FakeDrive } from "../mocks/fakeDrive";
import { fixtureOf, partialOf } from "../mocks/productFixture.ts";
import { suite } from "../harness.ts";

process.on("unhandledRejection", (reason) => {
	if (reason instanceof ReferenceError && /indexedDB/.test(reason.message)) return;
	throw reason instanceof Error ? reason : new Error(String(reason));
});
const s = suite("engine-offline-delete");

// ── policy ──
s.section("policy: classification");
s.check(classifyMissingOnDisk({ baselineHash: "a", crdtHash: "a" }) === "treat-as-local-delete", "same hash: local delete");
s.check(classifyMissingOnDisk({ baselineHash: "a", crdtHash: "b" }) === "write-crdt-to-disk", "different hash: write");
s.check(classifyMissingOnDisk({ baselineHash: undefined, crdtHash: "b" }) === "write-crdt-to-disk", "no baseline: write");
s.check(classifyMissingOnDisk({ baselineHash: "a", crdtHash: null }) === "write-crdt-to-disk", "no CRDT text: write");
s.section("policy: batch brake");
s.check(evaluateOfflineDeleteBatch({ candidateCount: 0, trackedCount: 0, diskPresentCount: 0 }).allowed, "nothing to do is allowed");
s.check(evaluateOfflineDeleteBatch({ candidateCount: 1, trackedCount: 1, diskPresentCount: 0 }).allowed, "deleting the only note is allowed");
s.check(!evaluateOfflineDeleteBatch({ candidateCount: 2, trackedCount: 2, diskPresentCount: 0 }).allowed, "several notes and an empty disk is blocked");
s.check(evaluateOfflineDeleteBatch({ candidateCount: 15, trackedCount: 40, diskPresentCount: 25 }).allowed, "15 of 40 is allowed (below the count threshold)");
s.check(!evaluateOfflineDeleteBatch({ candidateCount: 30, trackedCount: 60, diskPresentCount: 30 }).allowed, "30 of 60 is blocked");
s.check(evaluateOfflineDeleteBatch({ candidateCount: 30, trackedCount: 400, diskPresentCount: 370 }).allowed, "30 of 400 is allowed (below the ratio)");

// ── harness ──
interface Rig {
	vs: VaultSync;
	run: (mode?: ReconcileMode) => Promise<void>;
	flushed: string[];
	traces: string[];
	index: DiskIndex;
	onDisk: Set<string>;
	/** Paths the file system has but the vault's markdown list does not (not yet indexed by Obsidian). */
	hiddenFromList: Set<string>;
	excluded: Set<string>;
}

function makeRig(): Rig {
	const drive = new FakeDrive();
	const vs = new VaultSync({ ...DEFAULT_SETTINGS, vaultId: "sync01", deviceName: "dev" }, {
		transportFactory: (ctx) => new DriveTransport(ctx.doc, drive.client(), { vaultId: "sync01", deviceId: "dev", autoTimers: false, ignoreOrigin: ctx.isLocalStoreOrigin }),
	});
	const flushed: string[] = [];
	const traces: string[] = [];
	const onDisk = new Set<string>();
	const hiddenFromList = new Set<string>();
	const excluded = new Set<string>();
	const rig: Rig = { vs, flushed, traces, index: {}, onDisk, hiddenFromList, excluded, run: async () => undefined };
	const app = partialOf<App>({
		vault: {
			getMarkdownFiles: () => [...onDisk].filter((p) => !hiddenFromList.has(p)).map((path) => fixtureOf<TFile>(TFile, { path })),
			read: async (file: TFile) => `disk ${file.path}`,
			getAbstractFileByPath: () => null,
			adapter: { stat: async (path: string) => (onDisk.has(path) ? { type: "file", ctime: 1, mtime: 1, size: 1 } : null) },
		},
		workspace: { iterateAllLeaves: () => undefined },
	});
	const controller = new ReconciliationController({
		app,
		getSettings: () => partialOf<VaultSyncSettings>({ deviceName: "dev" }),
		getRuntimeConfig: () => partialOf<RuntimeConfig>({ maxFileSizeBytes: 0, maxFileSizeKB: 0, excludePatterns: [] }),
		getVaultSync: () => vs,
		getDiskMirror: () => partialOf<DiskMirror>({ flushWrite: async (path: string) => { flushed.push(path); } }),
		getBlobSync: () => null,
		getEditorBindings: () => null,
		getDiskIndex: () => rig.index,
		setDiskIndex: (next: DiskIndex) => { rig.index = next; },
		isMarkdownPathSyncable: (path: string) => !excluded.has(path),
		shouldBlockFrontmatterIngest: () => false,
		refreshServerCapabilities: async () => undefined,
		validateOpenEditorBindings: () => undefined,
		onReconciled: () => undefined,
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => undefined,
		saveDiskIndex: async () => undefined,
		refreshStatusBar: () => undefined,
		trace: (_source: string, msg: string) => { traces.push(msg); },
		scheduleTraceStateSnapshot: () => undefined,
		log: () => undefined,
	});
	rig.run = async (mode = "authoritative") => { await controller.runReconciliation(mode); };
	return rig;
}

/** A note that is in the CRDT and in the index, with the given disk presence. */
async function addNote(rig: Rig, path: string, text: string, opts: { indexed?: boolean | string; onDisk?: boolean } = {}): Promise<void> {
	rig.vs.ensureFile(path, text, "dev");
	const hash = typeof opts.indexed === "string" ? opts.indexed : await contentBaselineHash(text);
	if (opts.indexed !== false) rig.index[path] = { mtime: 1, size: text.length, contentHash: hash };
	if (opts.onDisk) rig.onDisk.add(path);
}
const active = (rig: Rig, path: string) => rig.vs.getActiveMarkdownPaths().includes(path);
const quiet = async (rig: Rig) => { await rig.vs.destroy().catch(() => undefined); };

s.section("1: a note we had in sync, now gone from disk, is recorded as deleted");
{
	const r = makeRig();
	await addNote(r, "Old.md", "text", {});
	await addNote(r, "Keep.md", "keep", { onDisk: true });
	await r.run();
	s.check(!active(r, "Old.md"), "the note is tombstoned");
	s.check(!r.flushed.includes("Old.md"), "it is not written back");
	s.check(active(r, "Keep.md"), "an untouched note stays");
	s.check(!("Old.md" in r.index), "its index entry is dropped by the same reconcile");
	await r.run();
	s.check(!active(r, "Old.md") && !r.flushed.includes("Old.md"), "a second reconcile (reopen) still does not bring it back");
	// The delete propagates to another device through the CRDT.
	const other = new Y.Doc();
	Y.applyUpdate(other, Y.encodeStateAsUpdate(r.vs.ydoc));
	let stillActive = 0;
	other.getMap("meta").forEach((entry) => {
		const j: unknown = entry instanceof Y.Map ? entry.toJSON() : entry;
		if (typeof j === "object" && j !== null && Reflect.get(j, "path") === "Old.md" && Reflect.get(j, "deletedAt") === undefined) stillActive++;
	});
	s.check(stillActive === 0, "the other device sees the delete");
	await quiet(r);
}

s.section("2: the other cases keep today's behaviour (the note is written)");
{
	const r = makeRig();
	await addNote(r, "Edited.md", "new text", { indexed: await contentBaselineHash("old text") });
	await addNote(r, "Fresh.md", "never here", { indexed: false });
	await addNote(r, "Ignored.md", "ignored", {});
	r.excluded.add("Ignored.md");
	await addNote(r, "Hidden.md", "hidden", { onDisk: true });
	r.hiddenFromList.add("Hidden.md");
	await addNote(r, "Other.md", "other", { onDisk: true });
	await r.run();
	s.check(active(r, "Edited.md") && r.flushed.includes("Edited.md"), "edited remotely meanwhile: written back, not deleted");
	s.check(active(r, "Fresh.md") && r.flushed.includes("Fresh.md"), "never materialised here (no index entry): written");
	s.check(active(r, "Ignored.md"), "an ignored path is never treated as deleted");
	s.check(active(r, "Hidden.md") && r.flushed.includes("Hidden.md"), "the file system still has it (vault list incomplete): not deleted");
	await quiet(r);
}

s.section("3: conservative mode does not delete");
{
	const r = makeRig();
	await addNote(r, "Old.md", "text", {});
	await addNote(r, "Keep.md", "keep", { onDisk: true });
	await r.run("conservative");
	s.check(active(r, "Old.md"), "the note is not tombstoned in conservative mode");
	await quiet(r);
}

s.section("4: a vault that looks emptied is not mass-deleted");
{
	const r = makeRig();
	for (let i = 0; i < 30; i++) await addNote(r, `n${i}.md`, `text ${i}`, { onDisk: i < 5 });
	await r.run();
	s.check(r.vs.getActiveMarkdownPaths().length === 30, "25 of 30 missing: none deleted");
	s.check(r.traces.includes("reconcile-offline-delete-blocked"), "the block is traced");
	await quiet(r);
	const e = makeRig();
	await addNote(e, "a.md", "a", {}); await addNote(e, "b.md", "b", {});
	await e.run();
	s.check(active(e, "a.md") && active(e, "b.md"), "two notes and an empty disk: nothing deleted");
	await quiet(e);
}

await s.done();

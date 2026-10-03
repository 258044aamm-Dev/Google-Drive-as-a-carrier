/**
 * SYNC-02: an editor-bound note whose disk text and CRDT text both changed from
 * the last synced text must not lose one side silently. Real VaultSync and
 * ReconciliationController, fake app and editor.
 */
import { MarkdownView, TFile, type App } from "obsidian";
import * as Y from "yjs";
import { bothSidesChangedFromBaseline } from "../../src/runtime/reconcile/boundDivergencePolicy";
import { ReconciliationController } from "../../src/runtime/reconciliationController";
import type { RuntimeConfig } from "../../src/runtime/runtimeConfig";
import { contentBaselineHash, type DiskIndex } from "../../src/sync/diskIndex";
import type { DiskMirror } from "../../src/sync/diskMirror";
import type { EditorBindingManager } from "../../src/sync/editorBinding";
import { VaultSync } from "../../src/sync/vaultSync";
import { DEFAULT_SETTINGS, type VaultSyncSettings } from "../../src/settings/settingsStore";
import { DriveTransport } from "../../src/drive-carrier/driveTransport";
import { FakeDrive } from "../mocks/fakeDrive";
import { fixtureOf, partialOf } from "../mocks/productFixture.ts";
import { suite } from "../harness.ts";
process.on("unhandledRejection", (r) => { if (r instanceof ReferenceError && /indexedDB/.test(r.message)) return; throw r; });
const s = suite("engine-bound-both-changed");

async function scenario(orig: string, crdt: string, disk: string, editor: string, opts: { baseline?: boolean; twice?: boolean } = {}): Promise<{ crdtAfter: string; artifacts: string[] }> {
	const drive = new FakeDrive();
	const vs = new VaultSync({ ...DEFAULT_SETTINGS, vaultId: "p", deviceName: "dev" }, { transportFactory: (ctx) => new DriveTransport(ctx.doc, drive.client(), { vaultId: "p", deviceId: "dev", autoTimers: false, ignoreOrigin: ctx.isLocalStoreOrigin }) });
	vs.ensureFile("N.md", orig, "dev");
	const ytext = vs.getTextForPath("N.md")!;
	vs.ydoc.transact(() => { ytext.delete(0, ytext.length); ytext.insert(0, crdt); }, "remote");
	const file = fixtureOf<TFile>(TFile, { path: "N.md" });
	const view = Object.assign(Object.create(MarkdownView.prototype) as MarkdownView, { file, editor: { getValue: () => editor } });
	const created: string[] = [];
	let index: DiskIndex = { "N.md": { mtime: 1, size: 1, ...(opts.baseline === false ? {} : { contentHash: await contentBaselineHash(orig) }) } };
	const app = partialOf<App>({
		vault: { getMarkdownFiles: () => [file], read: async () => disk, getAbstractFileByPath: () => null, create: async (p: string) => { created.push(p); return fixtureOf<TFile>(TFile, { path: p }); }, adapter: { stat: async () => ({ type: "file", ctime: 1, mtime: 2, size: disk.length }) } },
		workspace: { iterateAllLeaves: (cb) => { cb({ view } as never); } },
	});
	const controller = new ReconciliationController({
		app, getSettings: () => partialOf<VaultSyncSettings>({ deviceName: "dev" }),
		getRuntimeConfig: () => partialOf<RuntimeConfig>({ maxFileSizeBytes: 0, maxFileSizeKB: 0, excludePatterns: [], externalEditPolicy: "always" }),
		getVaultSync: () => vs, getDiskMirror: () => partialOf<DiskMirror>({ isPreservedUnresolved: () => false, flushWrite: async () => undefined }),
		getBlobSync: () => null,
		getEditorBindings: () => partialOf<EditorBindingManager>({ isBound: () => true, unbindByPath: () => undefined, getLastEditorActivityForPath: () => null, getBindingDebugInfoForView: () => null, getCollabDebugInfoForView: () => null, repair: () => true, rebind: () => undefined }),
		getDiskIndex: () => index, setDiskIndex: (n: DiskIndex) => { index = n; },
		isMarkdownPathSyncable: () => true, shouldBlockFrontmatterIngest: () => false, refreshServerCapabilities: async () => undefined, validateOpenEditorBindings: () => undefined, onReconciled: () => undefined,
		getAwaitingFirstProviderSyncAfterStartup: () => false, setAwaitingFirstProviderSyncAfterStartup: () => undefined, saveDiskIndex: async () => undefined, refreshStatusBar: () => undefined,
		trace: () => undefined, scheduleTraceStateSnapshot: () => undefined, log: () => undefined,
	});
	await controller["syncFileFromDisk"](file, "modify");
	if (opts.twice) {
		// Same divergence again (a repeated modify event): no second copy.
		vs.ydoc.transact(() => { const y = vs.getTextForPath("N.md")!; y.delete(0, y.length); y.insert(0, crdt); }, "remote");
		await controller["syncFileFromDisk"](file, "modify");
	}
	const crdtAfter = vs.getTextForPath("N.md")?.toString() ?? "";
	await vs.destroy().catch(() => undefined);
	return { crdtAfter, artifacts: created };
}

s.section("policy");
s.check(bothSidesChangedFromBaseline({ baselineHash: "b", diskHash: "d", crdtHash: "c" }), "both differ from baseline and from each other");
s.check(!bothSidesChangedFromBaseline({ baselineHash: "b", diskHash: "d", crdtHash: "b" }), "CRDT unchanged: not a conflict");
s.check(!bothSidesChangedFromBaseline({ baselineHash: "b", diskHash: "b", crdtHash: "c" }), "disk unchanged: not a conflict");
s.check(!bothSidesChangedFromBaseline({ baselineHash: "b", diskHash: "d", crdtHash: "d" }), "both made the same change: not a conflict");
s.check(!bothSidesChangedFromBaseline({ baselineHash: null, diskHash: "d", crdtHash: "c" }), "no baseline: no claim");

s.section("1: editor and disk hold the local edit, the CRDT holds a remote edit (local-only branch)");
{
	const r = await scenario("orig", "remote edit", "local edit", "local edit");
	s.check(r.crdtAfter === "local edit", "the editor side still wins (behaviour unchanged)");
	s.check(r.artifacts.length === 1 && r.artifacts[0]!.includes("YAOS conflict - crdt"), `the remote version is kept as a conflict note (${JSON.stringify(r.artifacts)})`);
}
s.section("2: the CRDT matches the editor, the disk holds an external edit (idle branch)");
{
	const r = await scenario("orig", "remote edit", "external edit", "remote edit");
	s.check(r.crdtAfter === "external edit", "the disk side still wins (behaviour unchanged)");
	s.check(r.artifacts.length === 1, "the version about to be overwritten is kept");
}
s.section("3: the ordinary cases make no copy");
{
	const lag = await scenario("orig", "orig", "local edit", "local edit");
	s.check(lag.crdtAfter === "local edit" && lag.artifacts.length === 0, "typing lag (CRDT still at the baseline): no copy");
	const noBase = await scenario("orig", "remote edit", "local edit", "local edit", { baseline: false });
	s.check(noBase.crdtAfter === "local edit" && noBase.artifacts.length === 0, "no baseline: the old behaviour, no copy");
	const same = await scenario("orig", "same", "same", "same");
	s.check(same.artifacts.length === 0, "disk equals CRDT: nothing to do");
}
s.section("4: a repeated event does not pile up copies");
{
	const r = await scenario("orig", "remote edit", "local edit", "local edit", { twice: true });
	s.check(r.artifacts.length === 1, `one copy only (${r.artifacts.length})`);
}
await s.done();

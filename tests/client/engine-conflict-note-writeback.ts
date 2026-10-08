/**
 * A conflict note that is still an active shared entry (it synced in 2.1.0, or an
 * older device sent it) must never be written to disk by DiskMirror, however the
 * write is requested, and a conflict copy with an upper-case extension counts too.
 * Closes the gaps left by the startup-reconcile-only guard (upstream PR #80 covers
 * the same ground).
 */
import { TFile, type App, type TFolder } from "obsidian";
import * as Y from "yjs";
import { DiskMirror } from "../../src/sync/diskMirror";
import type { EditorBindingManager } from "../../src/sync/editorBinding";
import { isMarkdownConflictArtifactPath } from "../../src/sync/markdownConflictArtifact";
import type { VaultSync } from "../../src/sync/vaultSync";
import { isMarkdownSyncable } from "../../src/types";
import { partialOf } from "../mocks/productFixture.ts";
import { suite } from "../harness.ts";

const s = suite("engine-conflict-note-writeback");

s.section("1: which names count as conflict notes");
{
	const stamp = "2026-10-02T18-30-05Z";
	for (const ext of ["md", "MD", "Md", "mD"]) {
		s.check(isMarkdownConflictArtifactPath(`Notes/Idea (YAOS conflict from dev ${stamp}).${ext}`), `.${ext} is a conflict note`);
	}
	s.check(isMarkdownConflictArtifactPath(`Idea (YAOS conflict - disk from dev ${stamp}) 2.MD`), "variants with a source and a counter, upper-case extension");
	s.check(!isMarkdownConflictArtifactPath(`Idea (YAOS conflict from dev ${stamp}).mdx`), ".mdx is not");
	s.check(!isMarkdownConflictArtifactPath(`Idea (YAOS conflict from dev ${stamp}).txt`), ".txt is not");
	s.check(!isMarkdownConflictArtifactPath("Idea (YAOS conflict from dev).md"), "no timestamp: not a conflict note");
	s.check(!isMarkdownConflictArtifactPath(`Idea (yaos conflict from dev ${stamp}).md`), "the words stay case-sensitive");
	s.check(!isMarkdownConflictArtifactPath("Idea.MD") && !isMarkdownConflictArtifactPath("Idea.md"), "ordinary notes are not");
	s.check(!isMarkdownSyncable(`Idea (YAOS conflict from dev ${stamp}).MD`, [], ".obsidian"), "an upper-case conflict copy is not syncable");
	s.check(isMarkdownSyncable("Idea.md", [], ".obsidian"), "an ordinary .md note is still syncable");
}

function makeMirror(paths: string[]) {
	const doc = new Y.Doc();
	const texts = new Map<string, Y.Text>();
	for (const p of paths) {
		const t = doc.getMap<Y.Text>("t").set(p, new Y.Text());
		t.insert(0, `content of ${p}`);
		texts.set(p, t);
	}
	const created: string[] = [];
	const modified: string[] = [];
	const existing = new Map<string, string>();
	const vault = {
		getAbstractFileByPath: (path: string) => {
			if (!existing.has(path)) return null;
			const f = new TFile();
			Object.assign(f, { path });
			return f;
		},
		read: async (f: TFile) => existing.get(f.path) ?? "",
		create: async (path: string, content: string) => {
			created.push(path);
			existing.set(path, content);
			const f = new TFile();
			Object.assign(f, { path });
			return f;
		},
		modify: async (f: TFile, content: string) => { modified.push(f.path); existing.set(f.path, content); },
		createFolder: async (path: string) => partialOf<TFolder>({ path }),
	};
	const vaultSync = partialOf<VaultSync>({
		provider: partialOf<VaultSync["provider"]>({ wsconnected: false }),
		ydoc: doc,
		getTextForPath: (path: string) => texts.get(path) ?? null,
	});
	const mirror = new DiskMirror(partialOf<App>({ vault, workspace: { getActiveViewOfType: () => null } }), vaultSync, partialOf<EditorBindingManager>({ getLastEditorActivityForPath: () => null }), false);
	return { mirror, created, modified, existing };
}

const NOTE = "Notes/Idea.md";
const CN = "Notes/Idea (YAOS conflict - disk from dev 2026-10-02T18-30-05Z).md";
const CN_UPPER = "Notes/Idea (YAOS conflict from dev 2026-10-02T18-30-05Z).MD";

s.section("2: DiskMirror.flushWrite");
{
	const r = makeMirror([NOTE, CN, CN_UPPER]);
	await r.mirror.flushWrite(NOTE);
	s.check(r.created.includes(NOTE), "control: an ordinary note is written as before");
	await r.mirror.flushWrite(CN);
	await r.mirror.flushWrite(CN, true);
	await r.mirror.flushWrite(CN_UPPER);
	await r.mirror.flushWrite(CN_UPPER, true);
	s.check(!r.created.includes(CN) && !r.created.includes(CN_UPPER), "a conflict note is not created on disk, forced or not");
	r.existing.set(CN, "old local text");
	await r.mirror.flushWrite(CN, true);
	s.check(!r.modified.includes(CN) && r.existing.get(CN) === "old local text", "an existing local conflict note is not overwritten either");
	r.existing.set(NOTE, "different text");
	await r.mirror.flushWrite(NOTE);
	s.check(r.modified.includes(NOTE), "control: an ordinary note is still updated");
}

await s.done();

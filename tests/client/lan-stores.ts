/**
 * Local network carrier — the device-local stores: attachments and restore points.
 */
import * as Y from "yjs";
import { suite } from "../harness.ts";
import { generateLanKey, makeNode, waitFor } from "../mocks/lanRig";
import { AdapterFileStore, MemoryFileStore, sha256Hex, type LanAdapterLike } from "../../src/lan-carrier/lanFileStore";
import type { SnapshotIndex, SnapshotResult } from "../../src/sync/snapshotClient";
import { LanBlobStore } from "../../src/lan-carrier/lanBlobStore";
import { LAN_KEEP_UNPINNED_SNAPSHOTS, LanSnapshotBackend } from "../../src/lan-carrier/lanSnapshotBackend";

const s = suite("lan-stores");
const enc = (t: string): Uint8Array => new TextEncoder().encode(t);
const buf = (u: Uint8Array): ArrayBuffer => { const c = new Uint8Array(u.byteLength); c.set(u); return c.buffer; };

function createdIndex(result: SnapshotResult): SnapshotIndex {
	if (result.status !== "created" || !result.index) throw new Error(`expected a created snapshot, got ${result.status}`);
	return result.index;
}

async function fails(run: () => Promise<unknown>): Promise<string | null> {
	try { await run(); return null; } catch (err) { return err instanceof Error ? err.message : String(err); }
}

s.section("1: the adapter-backed file store (what runs in Obsidian)");
{
	const disk = new Map<string, ArrayBuffer>();
	const dirs = new Set<string>();
	const adapter: LanAdapterLike = {
		exists: (p) => Promise.resolve(disk.has(p) || dirs.has(p)),
		mkdir: (p) => { dirs.add(p); return Promise.resolve(); },
		readBinary: (p) => Promise.resolve(disk.get(p) ?? new ArrayBuffer(0)),
		writeBinary: (p, d) => { disk.set(p, d); return Promise.resolve(); },
		remove: (p) => { disk.delete(p); return Promise.resolve(); },
		list: (p) => Promise.resolve({ files: Array.from(disk.keys()).filter((k) => k.startsWith(`${p}/`)), folders: [] }),
	};
	const store = new AdapterFileStore(adapter, ".obsidian/plugins/yaos/lan/blobs");
	s.check(await store.read("abc") === null, "a missing file reads as null");
	await store.write("abc", enc("hello"));
	s.check(dirs.has(".obsidian") && dirs.has(".obsidian/plugins/yaos/lan/blobs"), "the folder chain is created");
	s.check(new TextDecoder().decode((await store.read("abc")) ?? new Uint8Array()) === "hello", "write then read");
	s.check((await store.list()).join() === "abc", "list returns bare names");
	await store.remove("abc");
	s.check(!(await store.exists("abc")), "remove");
	for (const bad of ["../x", "a/b", "", ".", "..", "a b"]) {
		s.check((await fails(() => store.read(bad))) !== null, `path trickery is refused: '${bad}'`);
	}
}

s.section("2: the attachment store keeps verified copies and talks to linked devices");
{
	const key = generateLanKey();
	const a = makeNode("dev-a", key);
	const b = makeNode("dev-b", key);
	const filesA = new MemoryFileStore();
	const filesB = new MemoryFileStore();
	const storeA = new LanBlobStore(filesA, a.transport);
	const storeB = new LanBlobStore(filesB, b.transport);
	try {
		const data = enc("an attachment");
		const hash = await sha256Hex(data);
		const other = enc("something else");
		const otherHash = await sha256Hex(other);

		s.check((await fails(() => storeA.upload(hash, "text/plain", buf(other), 1000)))?.includes("does not match") === true, "an upload whose bytes do not match its hash is refused");
		s.check((await fails(() => storeA.upload("nothex", "x", buf(data), 1000))) !== null, "a malformed hash is refused");
		s.check((await fails(() => storeA.download("nothex", 1000))) !== null, "a malformed hash is refused on download too");

		await storeA.upload(hash, "text/plain", buf(data), 1000);
		s.check(await filesA.exists(hash), "an upload is kept on this device");
		s.check((await storeA.exists([hash, otherHash])).join() === hash, "exists: local copy counts, unknown does not (no peers: no waiting)");
		s.check(new TextDecoder().decode(await storeA.download(hash, 1000)) === "an attachment", "download of a local copy needs no peers");

		const e1 = await fails(() => storeB.download(hash, 300));
		s.check(e1 !== null && /404/.test(e1), `with nobody linked, a missing attachment fails as 'not available' (${e1})`);

		await a.transport.connect();
		await b.transport.connect();
		b.linkTo(a);
		await waitFor(() => a.transport.synced && b.transport.synced);
		s.check((await storeB.exists([hash, otherHash])).join() === hash, "exists: a linked device's copy counts");
		s.check(new TextDecoder().decode(await storeB.download(hash, 3000)) === "an attachment", "download fetches from the linked device");
		s.check(await filesB.exists(hash), "and keeps a verified local copy");

		const pushed = enc("pushed along");
		const pushedHash = await sha256Hex(pushed);
		await storeA.upload(pushedHash, "x", buf(pushed), 1000);
		s.check(await waitFor(() => filesB.files.has(pushedHash)), "an upload is also pushed to linked devices");

		// A damaged copy is never served or trusted.
		filesA.files.set(hash, enc("damaged!"));
		s.check((await storeA.serve(hash)) === null && !(await filesA.exists(hash)), "a damaged copy is not served and is removed");
		filesB.files.delete(hash);
		const fetched = await storeB.download(hash, 3000).catch(() => null);
		s.check(fetched === null, "and another device cannot get it from the damaged one");

		// A peer cannot plant bad data under a hash.
		await storeB.receive(otherHash, enc("not the right bytes"));
		s.check(!(await filesB.exists(otherHash)), "received data with the wrong hash is dropped");
		await storeB.receive(otherHash, other);
		s.check(await filesB.exists(otherHash), "received data with the right hash is kept");
	} finally {
		a.stop();
		b.stop();
	}
}

s.section("3: restore points are local, listed newest first, pinned when manual, pruned when old");
{
	const files = new MemoryFileStore();
	const doc = new Y.Doc();
	let now = Date.UTC(2026, 0, 1, 12);
	let counter = 0;
	const backend = new LanSnapshotBackend(files, { vaultId: "v", getDoc: () => doc, now: () => now, random: () => String(counter++).padStart(4, "0") });
	doc.getMap<string>("pathToId").set("a.md", "id1");
	doc.getMap("sys").set("schemaVersion", 1);

	const first = await backend.daily("phone");
	s.check(first.status === "created" && createdIndex(first).reason === "daily" && createdIndex(first).pinned === false, "the first daily snapshot is created and unpinned");
	s.check((await backend.daily("phone")).status === "noop", "a second daily on the same day does nothing");
	s.check(createdIndex(first).markdownFileCount === 1, "it counts the notes");

	now += 3600_000;
	const manual = await backend.now("phone");
	s.check(manual.status === "created" && createdIndex(manual).pinned === true && manual.snapshotIdenticalToLatest === true, "a manual snapshot is pinned and says it equals the latest");
	doc.getMap<string>("pathToId").set("b.md", "id2");
	now += 3600_000;
	const changed = await backend.now("phone");
	s.check(changed.status === "created" && changed.snapshotIdenticalToLatest === false, "after a change it is no longer identical");

	const listed = await backend.list();
	s.check(listed.length === 3 && listed[0]?.snapshotId === (changed.status === "created" ? changed.snapshotId : ""), "listed newest first");

	const restored = await backend.download(listed[2] ?? listed[0]!);
	s.check(restored.getMap<string>("pathToId").size === 1, "an older snapshot restores the older state");
	s.check((await backend.download(listed[0]!)).getMap<string>("pathToId").size === 2, "the newest restores the newest");
	s.check((await fails(() => backend.download({ ...listed[0]!, snapshotId: "nope" })))?.includes("404") === true, "a missing snapshot says 404");

	// An incomplete snapshot (data without its index) is not listed.
	await files.write("snapdat-0000000000001-zzzz.bin", enc("partial"));
	s.check((await backend.list()).length === 3, "data without an index is not listed");

	// Pruning keeps pinned ones and the newest unpinned ones.
	for (let i = 0; i < LAN_KEEP_UNPINNED_SNAPSHOTS + 4; i++) {
		now += 86400_000;
		doc.getMap<string>("pathToId").set(`n${i}.md`, `i${i}`);
		await backend.daily("phone");
	}
	const pruned = await backend.prune();
	const after = await backend.list();
	s.check(pruned.pruned >= 4 && pruned.failed === 0, `old unpinned snapshots are removed (${pruned.pruned})`);
	s.check(after.filter((i) => i.pinned).length === 2, "pinned ones all survive");
	s.check(after.filter((i) => !i.pinned).length === LAN_KEEP_UNPINNED_SNAPSHOTS, "the newest unpinned ones are kept");
	s.check(!files.files.has(`snapdat-${first.status === "created" ? first.snapshotId : ""}.bin`), "a pruned snapshot's data is removed too");

	const idle = new LanSnapshotBackend(files, { vaultId: "v", getDoc: () => null });
	const unavailable = await idle.now("x");
	s.check(unavailable.status === "unavailable", "with sync not running a snapshot is 'unavailable'");
}
await s.done();

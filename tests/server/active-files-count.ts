/**
 * The snapshot index counts notes from `meta` under the current path model
 * (upstream issue #78 saw `markdownFileCount: 0` for a vault with thousands of
 * notes, because the count read the frozen `pathToId` map).
 */
import * as Y from "yjs";
import { countActiveMarkdownFiles } from "../../server/src/activeFiles";
import { createSnapshot } from "../../server/src/snapshot";
import { FakeR2Bucket } from "../mocks/workerEnv.ts";
import { suite } from "../harness.ts";

const s = suite("active-files-count");

function nested(path: string, deleted: boolean): Y.Map<unknown> {
	const m = new Y.Map<unknown>();
	m.set("path", path);
	if (deleted) m.set("deletedAt", 1_700_000_000_000);
	return m;
}

function v3Doc(): Y.Doc {
	const doc = new Y.Doc();
	doc.getMap("sys").set("schemaVersion", 3);
	const meta = doc.getMap("meta");
	meta.set("id-a", nested("a.md", false));
	meta.set("id-b", nested("b.md", false));
	meta.set("id-gone", nested("gone.md", true));
	return doc;
}

s.section("1: current path model counts active meta entries");
{
	const doc = v3Doc();
	s.check(doc.getMap("pathToId").size === 0, "setup: pathToId is empty, as in a current vault");
	s.check(countActiveMarkdownFiles(doc) === 2, "two active notes, the deleted one is not counted");
}
s.section("2: schema v2 stores flat JSON metadata");
{
	const doc = new Y.Doc();
	doc.getMap("sys").set("schemaVersion", 2);
	const meta = doc.getMap("meta");
	meta.set("id-a", { path: "a.md" });
	meta.set("id-b", { path: "b.md", deletedAt: 1_700_000_000_000 });
	meta.set("id-c", { path: "c.md", deleted: true });
	s.check(countActiveMarkdownFiles(doc) === 1, "flat JSON tombstones (deletedAt or deleted:true) are not counted");
}
s.section("3: a legacy document keeps the pathToId count");
{
	const doc = new Y.Doc();
	const ids = doc.getMap<string>("pathToId");
	ids.set("a.md", "id-a"); ids.set("b.md", "id-b");
	s.check(countActiveMarkdownFiles(doc) === 2, "no schema version: pathToId.size as before");
	doc.getMap("sys").set("schemaVersion", 1);
	s.check(countActiveMarkdownFiles(doc) === 2, "schema v1: pathToId.size as before");
}
s.section("4: the snapshot index carries the right count");
{
	const bucket = new FakeR2Bucket();
	const index = await createSnapshot(v3Doc(), "vault-x", bucket as never, { reason: "manual" });
	s.check(index.markdownFileCount === 2, `markdownFileCount is 2 (got ${index.markdownFileCount})`);
}
await s.done();

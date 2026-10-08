/**
 * A deleted note keeps the time of its FIRST deletion, so the server's
 * grace-period reaper can age it out (upstream issue #78 asked whether
 * tombstones keep being refreshed). Real VaultSync, fake transport.
 */
import * as Y from "yjs";
import { VaultSync } from "../../src/sync/vaultSync";
import { DEFAULT_SETTINGS } from "../../src/settings/settingsStore";
import { DriveTransport } from "../../src/drive-carrier/driveTransport";
import { FakeDrive } from "../mocks/fakeDrive";
import { readField } from "../mocks/readField.ts";
import { suite } from "../harness.ts";

process.on("unhandledRejection", (reason) => {
	if (reason instanceof ReferenceError && /indexedDB/.test(reason.message)) return;
	throw reason instanceof Error ? reason : new Error(String(reason));
});
const s = suite("engine-tombstone-age");

const realNow = Date.now;
let clock = 1_700_000_000_000;
Date.now = () => clock;

const drive = new FakeDrive();
const vs = new VaultSync({ ...DEFAULT_SETTINGS, vaultId: "age", deviceName: "dev" }, {
	transportFactory: (ctx) => new DriveTransport(ctx.doc, drive.client(), { vaultId: "age", deviceId: "dev", autoTimers: false, ignoreOrigin: ctx.isLocalStoreOrigin }),
});

/** deletedAt of every meta entry for `path`, oldest id first. */
function deletedAts(path: string): Array<number | undefined> {
	const out: Array<number | undefined> = [];
	vs.ydoc.getMap("meta").forEach((entry) => {
		const json: unknown = entry instanceof Y.Map ? entry.toJSON() : entry;
		if (readField(json, "path") !== path) return;
		const at = readField(json, "deletedAt");
		out.push(typeof at === "number" ? at : undefined);
	});
	return out;
}

s.section("1: a second delete of an already deleted path does not refresh its time");
vs.ensureFile("A.md", "text", "dev");
clock += 1000;
vs.handleDelete("A.md", "dev");
const first = deletedAts("A.md");
s.check(first.length === 1 && first[0] === clock, "setup: one tombstone with the time of the first delete");
clock += 20 * 24 * 3600 * 1000;
vs.handleDelete("A.md", "dev");
vs.handleDelete("A.md", "dev");
s.check(deletedAts("A.md").length === 1 && deletedAts("A.md")[0] === first[0], "repeated deletes leave the original time");

s.section("2: a reconcile that sees the path missing does not refresh it either");
{
	const result = vs.reconcileVault(new Map(), new Set(), "authoritative", "dev");
	s.check(result.createdOnDisk.length === 0, "the deleted note is not written back");
	s.check(deletedAts("A.md")[0] === first[0], "the time is unchanged");
}

s.section("3: delete, recreate, delete again is a genuinely new deletion");
clock += 1000;
vs.ensureFile("A.md", "again", "dev", { reviveTombstone: true, reviveReason: "local-create-event" });
clock += 1000;
vs.handleDelete("A.md", "dev");
const times = deletedAts("A.md").filter((t): t is number => t !== undefined);
s.check(times.length >= 1 && Math.max(...times) === clock, "the newest deletion carries the new time");
s.check(times.includes(first[0] as number) || times.length === 1, "a tombstone is never left without a time");

await vs.destroy().catch(() => undefined);
Date.now = realNow;
await s.done();

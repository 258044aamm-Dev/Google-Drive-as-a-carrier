/**
 * F5: folder identity, duplicates, and the empty-folder warning.
 *
 * The vault folder used to be found by name only, and its id was never kept:
 * renaming "YAOS <id>" in the Drive web app made the carrier create a second
 * empty folder and upload the whole document into it, and a device whose Google
 * sign-in cannot see the first folder (Drive shows an app only the files it
 * created) produced the same silent split-brain. These cases pin the four
 * pieces of the fix:
 *
 *   a. the folder id resolved once is remembered and used again;
 *   b. several folders with one name are reported, never deleted, and the
 *      choice stays deterministic (oldest, then lowest id);
 *   c. an empty vault folder about to receive a large local document is
 *      announced before the first upload;
 *   d. meta.json carries the installId that tells "same vault, second folder"
 *      apart from "same name, some other vault".
 */

import * as Y from "yjs";
import { DriveTransport, type DriveTransportOptions } from "../../src/drive-carrier/driveTransport";
import { META_NAME } from "../../src/drive-carrier/fileFormat";
import { fingerprintForInstallId, inspectFolderFingerprint } from "../../src/drive-carrier/folderFingerprint";
import { FakeDrive } from "../mocks/fakeDrive";
import { suite } from "../harness.ts";

const s = suite("drive-carrier-folder-identity");
const VAULT = "fid1";
const FOLDER = `YAOS ${VAULT}`;

let clock = 20_000_000;

/** The parsed `meta.json` of a folder, or null when it has none yet. */
async function readMeta(drive: FakeDrive, folderName: string): Promise<Record<string, unknown> | null> {
	const client = drive.client();
	const folder = (await client.findFolders(folderName))[0];
	if (!folder) return null;
	const meta = (await client.listFiles(folder.id)).find((f) => f.name === META_NAME);
	if (!meta) return null;
	const parsed: unknown = JSON.parse(new TextDecoder().decode(await client.readFile(meta.id)));
	return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
}

interface Rig {
	doc: Y.Doc;
	text: Y.Text;
	saved: { value: string | undefined };
	drive: FakeDrive;
}

function makeRig(drive: FakeDrive, savedId?: string): Rig {
	const doc = new Y.Doc();
	doc.clientID = 4242;
	return { doc, text: doc.getText("t"), drive, saved: { value: savedId } };
}

interface Seen {
	transport: DriveTransport;
	notices: string[];
	logs: string[];
}

/** A transport over the rig's document, with the remembered folder id wired the way main.ts wires it. */
function start(rig: Rig, name: string, extra: Partial<DriveTransportOptions> = {}): Seen {
	const notices: string[] = [];
	const logs: string[] = [];
	const transport = new DriveTransport(rig.doc, rig.drive.client(), {
		vaultId: VAULT,
		deviceId: name,
		autoTimers: false,
		now: () => clock,
		onNotice: (message: string) => notices.push(message),
		log: (message: string) => logs.push(message),
		folderIdentity: {
			saved: () => rig.saved.value,
			remember: (id: string) => { rig.saved.value = id; },
		},
		...extra,
	});
	return { transport, notices, logs };
}

// ---------------------------------------------------------------------------
s.section("Fingerprint inspection is stable and does not write to Drive");
{
	const drive = new FakeDrive();
	const api = drive.client();
	const folder = await api.createFolder(FOLDER);
	const empty = await inspectFolderFingerprint(api, folder.id);
	s.check(empty.kind === "empty", "an empty folder is distinct from a broken metadata file");
	await api.createFile(folder.id, META_NAME, new TextEncoder().encode(JSON.stringify({ schema: 1, vaultId: VAULT, installId: "unique-install" })));
	const first = await inspectFolderFingerprint(api, folder.id);
	const second = await inspectFolderFingerprint(api, folder.id);
	const expected = await fingerprintForInstallId("unique-install");
	s.check(first.kind === "identified" && first.vaultId === VAULT && first.fingerprint === expected, "identity comes from the folder's metadata");
	s.check(second.kind === "identified" && second.fingerprint === expected && expected.length === 64, "fingerprint is stable and SHA-256 sized");
	s.check(await fingerprintForInstallId("other-install") !== expected, "different folders have distinct fingerprints");
	s.check(drive.calls.createFile === 1, "inspection never writes metadata");
}

// ---------------------------------------------------------------------------
s.section("Test 1: the resolved folder id is remembered and survives a rename");
{
	const drive = new FakeDrive();
	const rig = makeRig(drive);
	rig.text.insert(0, "first note");
	const first = start(rig, "A");
	await first.transport.connect();
	s.check(rig.saved.value !== undefined, "the resolved folder id is handed back to be saved");
	s.check(drive.folderById(rig.saved.value ?? "")?.name === FOLDER, `the saved id is the vault folder (${String(drive.folderById(rig.saved.value ?? "")?.name)})`);
	s.check(drive.calls.createFolder === 1, "the folder was created once");

	// The user renames the folder in the Drive web app.
	s.check(drive.renameFolder(FOLDER, "My YAOS vault") === 1, "the fake Drive renamed exactly one folder");
	const filesBefore = drive.namesIn("My YAOS vault").length;
	const savedId = rig.saved.value;

	// Same document, next start: it must follow the id, not the name.
	clock += 61_000;
	const again = start(rig, "A");
	await again.transport.connect();
	s.check(rig.saved.value === savedId, "the remembered id is still the one in use");
	s.check(drive.folderById(savedId ?? "")?.name === "My YAOS vault", "and it is the renamed folder");
	s.check(drive.calls.createFolder === 1, `no second folder was created (${drive.calls.createFolder} createFolder calls)`);
	s.check(drive.calls.getFile >= 1, "the saved id was checked with getFile");
	s.check(drive.namesIn("My YAOS vault").length === filesBefore, `nothing was uploaded again (${drive.namesIn("My YAOS vault").length} of ${filesBefore} files)`);
	s.check(again.notices.length === 0, `no warning for a plain rename (${again.notices.join(" | ")})`);
	first.transport.destroy();
	again.transport.destroy();
}

// ---------------------------------------------------------------------------
s.section("Test 2: a saved folder that is gone falls back to the name search");
{
	const drive = new FakeDrive();
	const rig = makeRig(drive);
	rig.text.insert(0, "note");
	const first = start(rig, "A");
	await first.transport.connect();
	const goneId = rig.saved.value ?? "";
	s.check(drive.trashFolder(FOLDER) === 1, "the folder is in the trash");

	clock += 61_000;
	const again = start(rig, "A");
	await again.transport.connect();
	const fresh = drive.folderById(rig.saved.value ?? "");
	s.check(again.transport.fatalError === null, "a trashed folder is not fatal");
	s.check(fresh?.name === FOLDER && rig.saved.value !== goneId, "a fresh folder was made because the remembered one is trashed");
	s.check(fresh?.trashed !== true, "the new folder is not the trashed one");
	s.check(drive.calls.getFile >= 1, "the trashed id was checked before falling back");
	s.check(drive.folderById(goneId)?.trashed === true, "the trashed folder was left where it is");
	s.check(
		again.notices.some((m) => /remembered is gone/.test(m) && /new one was made/.test(m)),
		`the user is told the remembered folder disappeared (${again.notices.join(" | ")})`,
	);
	first.transport.destroy();
	again.transport.destroy();
}

// ---------------------------------------------------------------------------
s.section("Test 3: two folders with one name are reported, and the choice is deterministic");
{
	const drive = new FakeDrive();
	const rig = makeRig(drive);
	rig.text.insert(0, "note");
	const first = start(rig, "A");
	await first.transport.connect();
	const firstId = rig.saved.value ?? "";

	// A second folder for the same vault, the shape a device with a different
	// Google sign-in leaves behind: it has its own meta.json (the other device
	// wrote it there) with the same vault id and its own install id.
	const other = await drive.client().createFolder(FOLDER);
	await drive.client().createFile(other.id, META_NAME, new TextEncoder().encode(JSON.stringify({
		app: "yaos-drive", schema: 1, vaultId: VAULT, installId: "otherinstall00",
	})));

	// A start with no remembered id (as before this fix) still picks the oldest
	// and now says so.
	const rigB = makeRig(drive);
	rigB.text.insert(0, "note");
	const blind = start(rigB, "B");
	clock += 61_000;
	await blind.transport.connect();
	s.check(rigB.saved.value === firstId, "the oldest folder is the one used");
	s.check(drive.folderById(other.id) !== undefined, "the other folder was not deleted");
	s.check(drive.calls.getFile === 0, "with nothing remembered, no getFile call was needed");
	s.check(
		blind.notices.some((m) => /Another folder named "YAOS fid1" exists on Drive/.test(m) && /oldest/.test(m)),
		`a duplicate is reported (${blind.notices.join(" | ")})`,
	);
	s.check(blind.notices.some((m) => /different Google client/.test(m)), "and the report explains the sign-in visibility rule");
	s.check(blind.logs.some((m) => /Another folder named/.test(m)), "the trace line carries the same warning");

	// With a remembered id the duplicate is still reported, and the id kept.
	clock += 61_000;
	const remembered = start({ ...rig }, "C");
	await remembered.transport.connect();
	s.check(rig.saved.value === firstId, "a remembered id is kept when a duplicate exists");
	s.check(remembered.notices.some((m) => /Another folder named "YAOS fid1" exists on Drive/.test(m)), "the duplicate is reported for a remembered folder too");
	s.check(drive.folderById(other.id) !== undefined, "still nothing deleted");
	first.transport.destroy();
	blind.transport.destroy();
	remembered.transport.destroy();
}

// ---------------------------------------------------------------------------
s.section("Test 4: a folder that holds a different vault is refused, not merged");
{
	const drive = new FakeDrive();
	// A folder with our name whose meta.json belongs to another vault: uploading
	// this device's document into it would merge two vaults.
	const stranger = await drive.client().createFolder(FOLDER);
	await drive.client().createFile(stranger.id, META_NAME, new TextEncoder().encode(JSON.stringify({
		app: "yaos-drive", schema: 1, vaultId: "someone-else", installId: "otherinstall",
	})));
	const rig = makeRig(drive);
	rig.text.insert(0, "note");
	const first = start(rig, "A");
	await first.transport.connect();
	s.check(rig.saved.value === undefined, "a refused folder is never remembered as this vault's folder");
	s.check(first.transport.fatalError !== null, "the carrier stops instead of writing there");
	s.check(
		/fatal|different vault/i.test(String(first.transport.fatalError)) && String(first.transport.fatalError).includes("someone-else"),
		`the message names the other vault (${String(first.transport.fatalError)})`,
	);
	s.check(drive.namesIn(FOLDER).every((n) => n === META_NAME), `nothing was uploaded into it (${drive.namesIn(FOLDER).join(", ")})`);
	s.check(drive.folderById(stranger.id) !== undefined, "the folder itself is untouched");
	first.transport.destroy();

	// The same folder, reached through a remembered id, is refused the same way.
	const again = start({ ...rig, saved: { value: stranger.id } }, "A");
	await again.transport.connect();
	s.check(/different vault/i.test(String(again.transport.fatalError)), "a remembered id is checked as well");
	again.transport.destroy();

	// A meta file without the field (an older folder) is still accepted.
	const drive2 = new FakeDrive();
	const old = await drive2.client().createFolder(FOLDER);
	await drive2.client().createFile(old.id, META_NAME, new TextEncoder().encode(JSON.stringify({ app: "yaos-drive", schema: 1 })));
	const rig2 = makeRig(drive2);
	rig2.text.insert(0, "note");
	const legacy = start(rig2, "B");
	await legacy.transport.connect();
	s.check(legacy.transport.fatalError === null, "an old meta file without a vault id is not refused");
	s.check(drive2.namesIn(FOLDER).some((n) => n.startsWith("seg-")), "and the vault syncs normally");
	legacy.transport.destroy();
}

// ---------------------------------------------------------------------------
s.section("Test 5: an empty folder plus a large local document is announced before the first upload");
{
	const drive = new FakeDrive();
	const rig = makeRig(drive);
	rig.text.insert(0, "x".repeat(2000)); // 2 KB, over the lowered warning size below
	const d = start(rig, "A", { splitBrainWarnBytes: 1000 });
	await d.transport.connect();
	s.check(d.notices.length === 1, `exactly one notice (${d.notices.join(" | ")})`);
	s.check(/empty vault folder/.test(d.notices[0] ?? ""), "it says the folder was empty");
	s.check(/invisible here|different Google client/.test(d.notices[0] ?? ""), "and explains the sign-in reason");
	s.check(/about to upload/.test(d.notices[0] ?? ""), "and that an upload is imminent");
	s.check(drive.namesIn(FOLDER).some((n) => n.startsWith("seg-")), "the normal upload still happened afterwards");
	s.check(d.transport.fatalError === null, "the warning did not stop the carrier");
	clock += 61_000;
	await d.transport.syncNow();
	s.check(d.notices.length === 1, "the notice is one-time");
	d.transport.destroy();

	// A small document in an empty folder stays quiet: nothing much is at risk.
	const drive2 = new FakeDrive();
	const rig2 = makeRig(drive2);
	rig2.text.insert(0, "tiny");
	const small = start(rig2, "B", { splitBrainWarnBytes: 1000 });
	await small.transport.connect();
	s.check(small.notices.length === 0, "a small local document is not announced");
	small.transport.destroy();

	// A folder that already holds the vault (a device joining normally) stays quiet.
	const drive3 = new FakeDrive();
	const rig3 = makeRig(drive3);
	rig3.text.insert(0, "x".repeat(2000));
	const publisher = start(rig3, "P", { splitBrainWarnBytes: 1000 });
	await publisher.transport.connect();
	const rig4 = makeRig(drive3);
	rig4.text.insert(0, "x".repeat(2000));
	clock += 61_000;
	const joiner = start(rig4, "J", { splitBrainWarnBytes: 1000 });
	await joiner.transport.connect();
	s.check(joiner.notices.length === 0, `a normal join has nothing to warn about (${joiner.notices.join(" | ")})`);
	publisher.transport.destroy();
	joiner.transport.destroy();
}

// ---------------------------------------------------------------------------
s.section("Test 6: meta.json carries an installId from creation");
{
	const drive = new FakeDrive();
	const rig = makeRig(drive);
	rig.text.insert(0, "note");
	const d = start(rig, "A");
	await d.transport.connect();
	const meta = await readMeta(drive, FOLDER);
	s.check(typeof meta?.installId === "string" && String(meta?.installId).length >= 8, `installId is written (${String(meta?.installId)})`);
	s.check(meta?.vaultId === VAULT && meta?.schema === 1, "the existing fields are unchanged");
	s.check(meta?.encryption === undefined, "an unencrypted vault has no encryption record");
	d.transport.destroy();

	// Two folders created independently for one vault id have different ids.
	const drive2 = new FakeDrive();
	const rigA = makeRig(drive2);
	rigA.text.insert(0, "one");
	const a = start(rigA, "A");
	await a.transport.connect();
	const other = await drive2.client().createFolder(FOLDER);
	await drive2.client().createFile(other.id, META_NAME, new TextEncoder().encode(JSON.stringify({
		app: "yaos-drive", schema: 1, vaultId: VAULT, installId: "separate00",
	})));
	const ids = [String((await readMeta(drive2, FOLDER))?.installId)];
	const second = (await drive2.client().listFiles(other.id)).find((f) => f.name === META_NAME);
	if (second) ids.push(String((JSON.parse(new TextDecoder().decode(await drive2.client().readFile(second.id))) as Record<string, unknown>).installId));
	s.check(ids.length === 2 && new Set(ids).size === 2, `two independently created folders have different install ids (${ids.join(", ")})`);
	a.transport.destroy();
}

// ---------------------------------------------------------------------------
s.section("Test 7: a second folder carrying the same install id is told apart from a split brain");
{
	const drive = new FakeDrive();
	const rig = makeRig(drive);
	rig.text.insert(0, "note");
	const first = start(rig, "A");
	await first.transport.connect();
	const original = await readMeta(drive, FOLDER);
	s.check(typeof original?.installId === "string", "the original folder has an install id");

	// A copy of the folder: same vault, same install id.
	const copy = await drive.client().createFolder(FOLDER);
	await drive.client().createFile(copy.id, META_NAME, new TextEncoder().encode(JSON.stringify({
		app: "yaos-drive", schema: 1, vaultId: VAULT, installId: String(original?.installId),
	})));

	const rig2 = makeRig(drive);
	rig2.text.insert(0, "note");
	clock += 61_000;
	const seen = start(rig2, "B");
	await seen.transport.connect();
	s.check(rig2.saved.value === rig.saved.value, "the original folder is still the one chosen");
	const notice = seen.notices[0] ?? "";
	s.check(/carry the same install id/.test(notice), `the copy is described as such (${notice})`);
	s.check(!/different Google client/.test(notice), "and not blamed on a different sign-in");
	first.transport.destroy();
	seen.transport.destroy();
}

await s.done();

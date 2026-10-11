/**
 * F2: CRDT schema admission on the carriers that have no server.
 *
 * The Cloudflare Worker refuses a room whose schema is newer than the plugin at
 * socket admission. Google Drive and the Local network carrier have no server,
 * so the engine's check is the only one there. This suite pins that behaviour:
 *
 *   - a device holding a newer-schema document never writes to Drive and never
 *     reports "synced" (refused before the first upload);
 *   - a device that APPLIES a newer-schema update from Drive stops immediately,
 *     and later cycles write nothing;
 *   - schema 2, schema 3 and unversioned documents are unaffected (no false
 *     positive, no behaviour change for existing vaults);
 *   - a transport without the guard behaves exactly as before, so the
 *     Cloudflare path and every existing caller are untouched.
 */
import * as Y from "yjs";
import { DriveTransport } from "../../src/drive-carrier/driveTransport";
import { KIND_SEGMENT, encodeFile } from "../../src/drive-carrier/fileFormat";
import { SCHEMA_VERSION, schemaAdmissionError } from "../../src/sync/schema";
import { FakeDrive } from "../mocks/fakeDrive";
import { generateLanKey, makeNode, waitFor, type RigNode } from "../mocks/lanRig";
import { suite } from "../harness.ts";

const s = suite("schema-admission-carriers");
const VAULT = "sa1";
/** The production rule, used by VaultSync.checkSchemaVersion and by both carriers. */
const guardFrom = (doc: Y.Doc) => () => schemaAdmissionError(doc.getMap<unknown>("sys").get("schemaVersion"));
const DATA_FILE = (name: string): boolean => name.startsWith("seg-") || name.startsWith("snap-");
const dataFiles = (drive: FakeDrive): string[] => drive.namesIn(`YAOS ${VAULT}`).filter(DATA_FILE);
const syncedEvents = (t: DriveTransport): boolean[] => {
	const seen: boolean[] = [];
	t.on("sync", (value: boolean) => seen.push(value));
	return seen;
};

/** A device like main.ts builds one: its own document plus a transport on one shared Drive. */
function makeDevice(drive: FakeDrive, options: { guard?: boolean; vaultId?: string } = {}): {
	doc: Y.Doc;
	transport: DriveTransport;
	fatal: string[];
} {
	const doc = new Y.Doc();
	doc.clientID = 7000 + Math.floor(Math.random() * 1000);
	const fatal: string[] = [];
	const vaultId = options.vaultId ?? VAULT;
	const transport = new DriveTransport(doc, drive.client(), {
		vaultId,
		deviceId: "SA",
		autoTimers: false,
		guardSchema: options.guard === false ? undefined : guardFrom(doc),
		onFatal: (message) => fatal.push(message),
	});
	return { doc, transport, fatal };
}

/** Write a segment into the vault folder as another device would, before anyone connects. */
async function seedRemoteUpdate(drive: FakeDrive, build: (doc: Y.Doc) => void): Promise<void> {
	const api = drive.client();
	const folder = await api.createFolder(`YAOS ${VAULT}`);
	const remote = new Y.Doc();
	remote.clientID = 9001;
	build(remote);
	const body = Y.encodeStateAsUpdate(remote);
	await api.createFile(
		folder.id,
		`seg-${String(1_700_000_000_000).padStart(13, "0")}-ZZ-0.ydu`,
		await encodeFile(KIND_SEGMENT, body),
	);
	remote.destroy();
}

// ---------------------------------------------------------------------------
s.section("Test 1: a newer-schema document is refused before any write");
{
	const drive = new FakeDrive();
	await seedRemoteUpdate(drive, (doc) => doc.getText("t").insert(0, "hello from another device"));
	const beforeSeeding = drive.calls.createFile; // the seeded file + nothing else yet

	const { doc, transport, fatal } = makeDevice(drive);
	doc.getMap("sys").set("schemaVersion", SCHEMA_VERSION + 1);
	doc.getText("t").insert(0, "local edit that must not be uploaded");
	const syncs = syncedEvents(transport);

	await transport.connect();
	s.check(transport.fatalError !== null, "the carrier stopped");
	s.check(
		transport.fatalError?.includes(`newer than this plugin supports (v${SCHEMA_VERSION})`) === true,
		`the reason names both versions (${transport.fatalError ?? ""})`,
	);
	s.check(fatal.length === 1 && fatal[0] === transport.fatalError, "the owner is told exactly once");
	s.check(transport.wsconnected === false, "the carrier is not left claiming to be connected");
	s.check(syncs.every((value) => value === false), `never reported "synced" (${syncs.join()} | none)`);

	const afterConnect = drive.calls.createFile;
	await transport.syncNow();
	await transport.syncNow();
	s.check(
		drive.calls.createFile === afterConnect && afterConnect === beforeSeeding,
		`no file was written at all (${beforeSeeding} -> ${drive.calls.createFile})`,
	);
	s.check(dataFiles(drive).length === 1, `only the other device's segment is on Drive (${dataFiles(drive).join(", ")})`);
	transport.destroy();
}

// ---------------------------------------------------------------------------
s.section("Test 2: an applied newer-schema update stops the carrier at once");
{
	const drive = new FakeDrive();
	await seedRemoteUpdate(drive, (doc) => {
		doc.getMap("sys").set("schemaVersion", SCHEMA_VERSION + 1);
		doc.getText("t").insert(0, "written by a newer plugin");
	});

	const { doc, transport, fatal } = makeDevice(drive);
	const syncs = syncedEvents(transport);
	await transport.connect();

	s.check(transport.fatalError !== null, "the newer schema was noticed after the poll");
	s.check(fatal.length === 1, "told once");
	s.check(syncs.every((value) => value === false), `never reported "synced" (${syncs.join()})`);

	// A local edit made afterwards must stay local: the carrier is stopped.
	doc.getText("t").insert(0, "later local edit");
	const filesAfterStop = drive.calls.createFile;
	await transport.syncNow();
	await new Promise<void>((resolve) => setImmediate(resolve));
	s.check(
		drive.calls.createFile === filesAfterStop,
		`later cycles write nothing (${filesAfterStop} -> ${drive.calls.createFile})`,
	);
	s.check(transport.pendingParts > 0, "the local edit is still queued, not lost");
	transport.destroy();
}

// ---------------------------------------------------------------------------
s.section("Test 3: readable schemas are not blocked (no false positives)");
for (const [label, value] of [["schema 3 (current)", SCHEMA_VERSION], ["schema 2 (older)", SCHEMA_VERSION - 1], ["no version marker", undefined]] as const) {
	const drive = new FakeDrive();
	const { doc, transport, fatal } = makeDevice(drive);
	if (value !== undefined) doc.getMap("sys").set("schemaVersion", value);
	doc.getText("t").insert(0, "note");
	await transport.connect();
	s.check(transport.fatalError === null && fatal.length === 0, `${label}: connects normally`);
	s.check(transport.synced === true, `${label}: reports "synced"`);
	s.check(drive.namesIn(`YAOS ${VAULT}`).some(DATA_FILE), `${label}: its edit reached Drive`);
	transport.destroy();
}

// ---------------------------------------------------------------------------
s.section("Test 4: without the guard nothing changes (Cloudflare-style callers)");
{
	const drive = new FakeDrive();
	const { doc, transport, fatal } = makeDevice(drive, { guard: false });
	doc.getMap("sys").set("schemaVersion", SCHEMA_VERSION + 1);
	doc.getText("t").insert(0, "note");
	await transport.connect();
	s.check(transport.fatalError === null && fatal.length === 0, "no guard set: the carrier runs as before");
	s.check(transport.synced === true, "and still reports synced");
	transport.destroy();
}

// ---------------------------------------------------------------------------
s.section("Test 5: a real Drive folder written by a newer plugin is refused, then readable after the reason clears");
{
	const drive = new FakeDrive();
	await seedRemoteUpdate(drive, (doc) => {
		doc.getMap("sys").set("schemaVersion", SCHEMA_VERSION + 1);
		doc.getText("t").insert(0, "newer");
	});
	let blocked = true;
	const doc = new Y.Doc();
	doc.clientID = 5555;
	const fatal: string[] = [];
	const transport = new DriveTransport(doc, drive.client(), {
		vaultId: VAULT,
		deviceId: "SA",
		autoTimers: false,
		guardSchema: () => (blocked ? schemaAdmissionError(doc.getMap("sys").get("schemaVersion")) : null),
		onFatal: (message) => fatal.push(message),
	});
	await transport.connect();
	s.check(transport.fatalError !== null, "refused while the reason stands");

	// The guard is a live view of the engine's opinion, so a fresh transport (what
	// a reload after updating the plugin creates) accepts the same folder.
	blocked = false;
	const fresh = new DriveTransport(doc, drive.client(), {
		vaultId: VAULT,
		deviceId: "SB",
		autoTimers: false,
		guardSchema: () => (blocked ? schemaAdmissionError(doc.getMap("sys").get("schemaVersion")) : null),
		onFatal: (message) => fatal.push(message),
	});
	await fresh.connect();
	s.check(fresh.fatalError === null, "a transport let through by the guard is not refused");
	s.check(fatal.length === 1, "only the refused transport told the owner");
	transport.destroy();
	fresh.destroy();
}

// ---------------------------------------------------------------------------
s.section("Test 6: the Local network carrier refuses the same vault (real loopback links)");
{
	const key = generateLanKey();
	const newerSchema = `CRDT schema version ${SCHEMA_VERSION + 1} is newer than this plugin supports (v${SCHEMA_VERSION}). Update the plugin or risk data corruption.`;

	const refused = makeNode("sa-lan-a", key, { guardSchema: () => newerSchema });
	await refused.transport.connect();
	s.check(refused.transport.wsconnected === false, "refused vault: not connected");
	s.check(refused.transport.synced === false, "refused vault: not synced");
	s.check(refused.port() === 0, "refused vault: the link server never started");
	s.check(
		refused.problems.length === 1 && refused.problems[0] === newerSchema,
		`refused vault: the owner is told once (${refused.problems.length})`,
	);
	// A second start attempt stays quiet: one notice per transport, not one per retry.
	await refused.transport.connect();
	s.check(refused.problems.length === 1, "a repeated start does not repeat the notice");
	refused.stop();

	// Two nodes whose guard admits the vault both sync over a real loopback link,
	// so the guard only ever refuses the vault it is told to refuse.
	let viewedSchema: number | null = null; // null: no version marker, admitted
	const a = makeNode("sa-lan-c", key, { guardSchema: () => schemaAdmissionError(viewedSchema) });
	const b = makeNode("sa-lan-d", key, { guardSchema: () => schemaAdmissionError(viewedSchema) });
	a.doc.getText("t").insert(0, "hello over the LAN. ");
	await a.transport.connect();
	await b.transport.connect();
	b.linkTo(a);
	s.check(await waitFor(() => a.transport.synced && b.transport.synced), "readable vault: both devices report synced");
	s.check(b.doc.getText("t").toString() === "hello over the LAN. ", "readable vault: the note travelled");
	s.check(a.problems.length === 0 && b.problems.length === 0, "readable vault: no problem reported");
	a.doc.getText("t").insert(0, "a edit, ");
	s.check(
		await waitFor(() => b.doc.getText("t").toString().includes("a edit")),
		"readable vault: edits keep flowing",
	);
	a.stop();
	b.stop();
}

await s.done();

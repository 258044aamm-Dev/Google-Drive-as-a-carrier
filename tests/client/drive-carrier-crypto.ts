/**
 * Drive carrier: optional encryption of everything stored on Drive
 * (sync files, attachments, snapshots) and the key bookkeeping in meta.json.
 */

import * as Y from "yjs";
import { DriveError, type DriveApi } from "../../src/drive-carrier/driveApi";
import { DriveBlobStore, blobFolderName } from "../../src/drive-carrier/driveBlobStore";
import {
	EncryptionError,
	createEncryption,
	parseEncryptionMeta,
	unlockEncryption,
} from "../../src/drive-carrier/driveCrypto";
import { DriveKeyring, FatalCarrierError } from "../../src/drive-carrier/driveKeyring";
import { sha256Hex } from "../../src/drive-carrier/driveFolders";
import { DriveSnapshotBackend, snapshotFolderName } from "../../src/drive-carrier/driveSnapshotBackend";
import { DriveTransport } from "../../src/drive-carrier/driveTransport";
import { KIND_SEGMENT, classifyName, encodeFile } from "../../src/drive-carrier/fileFormat";
import type { SnapshotIndex } from "../../src/sync/snapshotClient";
import { FakeDrive } from "../mocks/fakeDrive";
import { suite } from "../harness.ts";

const s = suite("drive-carrier-crypto");
const VAULT = "v1";
const FOLDER = `YAOS ${VAULT}`;
const ITER = 1000; // fast for tests; production default is 600000
const enc = new TextEncoder();
const dec = new TextDecoder();
let clock = 90_000_000;

async function fails(run: () => Promise<unknown>): Promise<Error | null> {
	try {
		await run();
	} catch (err) {
		return err instanceof Error ? err : new Error(String(err));
	}
	return null;
}

function contains(haystack: Uint8Array, needle: string): boolean {
	const n = enc.encode(needle);
	outer: for (let i = 0; i + n.length <= haystack.length; i++) {
		for (let j = 0; j < n.length; j++) if (haystack[i + j] !== n[j]) continue outer;
		return true;
	}
	return false;
}

function anyFileContains(drive: FakeDrive, needle: string): boolean {
	for (const f of drive.files.values()) {
		if (contains(f.data, needle) || contains(enc.encode(f.name), needle)) return true;
	}
	return false;
}

function keyring(drive: FakeDrive, passphrase: string, vaultId = VAULT, client: DriveApi = drive.client()): DriveKeyring {
	return new DriveKeyring(client, { vaultId, passphrase, kdfIterations: ITER });
}

s.section("Test 1: sealing");
{
	const { sealer, meta } = await createEncryption("correct horse", VAULT, ITER);
	const plain = enc.encode("secret note text");
	const a = await sealer.seal(plain, "segment");
	const b = await sealer.seal(plain, "segment");
	s.check(!contains(a, "secret"), "the sealed bytes do not contain the text");
	s.check(a.length === plain.length + 1 + 12 + 16, "overhead is a version byte, the IV and the tag");
	s.check(dec.decode(await sealer.open(a, "segment")) === "secret note text", "round trip");
	s.check(dec.decode(a) !== dec.decode(b) && dec.decode(await sealer.open(b, "segment")) === "secret note text", "a new IV each time");
	const wrongPurpose = await fails(() => sealer.open(a, "snapshot"));
	s.check(wrongPurpose instanceof EncryptionError, "a segment cannot be passed off as a snapshot");
	const flipped = a.slice();
	flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 1;
	s.check((await fails(() => sealer.open(flipped, "segment"))) instanceof EncryptionError, "a changed byte is detected");
	s.check((await fails(() => sealer.open(a.slice(0, 20), "segment"))) instanceof EncryptionError, "a truncated file is detected");
	const wrongVersion = a.slice();
	wrongVersion[0] = 9;
	s.check((await fails(() => sealer.open(wrongVersion, "segment")))?.message.includes("format 9") === true, "an unknown format version is named");
	s.check((await fails(() => unlockEncryption("correct horse", "other-vault", meta))) instanceof EncryptionError, "a vault's key details cannot be moved into another vault");
	const other = (await createEncryption("correct horse", "other-vault", ITER)).sealer;
	s.check((await fails(() => other.open(a, "segment"))) instanceof EncryptionError, "a file cannot be moved into another vault");
	const again = await unlockEncryption("correct horse", VAULT, meta);
	s.check(dec.decode(await again.open(a, "segment")) === "secret note text", "the same passphrase unlocks it on another device");
	const wrong = await fails(() => unlockEncryption("wrong", VAULT, meta));
	s.check(wrong instanceof EncryptionError && wrong.message.includes("passphrase is wrong"), "a wrong passphrase is reported as such");
	const n1 = await sealer.blobName("ab".repeat(32));
	s.check(/^[0-9a-f]{64}$/.test(n1) && n1 !== "ab".repeat(32), "attachment names are 64 hex characters, but not the content hash");
	s.check(n1 === (await again.blobName("ab".repeat(32))), "and are the same on every device");
	s.check(n1 !== (await other.blobName("ab".repeat(32))), "and differ between vaults");
	const unicodeA = await createEncryption("pässwörd", VAULT, ITER);
	s.check((await unlockEncryption("pa\u0308sswo\u0308rd", VAULT, unicodeA.meta)) !== null, "the same text typed in decomposed form still unlocks");
}

s.section("Test 2: meta validation");
{
	const { meta } = await createEncryption("x", VAULT, ITER);
	s.check(parseEncryptionMeta(meta) !== null, "valid meta is accepted");
	s.check(parseEncryptionMeta({ ...meta, iterations: 10 }) === null, "too few iterations are refused");
	s.check(parseEncryptionMeta({ ...meta, iterations: 50_000_000 }) === null, "an absurd iteration count is refused");
	s.check(parseEncryptionMeta({ ...meta, kdf: "md5" }) === null, "another key derivation is refused");
	s.check(parseEncryptionMeta({ ...meta, v: 2 }) === null, "another version is refused");
	s.check(parseEncryptionMeta({ ...meta, salt: "***" }) === null, "an unreadable salt is refused");
	s.check(parseEncryptionMeta(null) === null && parseEncryptionMeta("x") === null, "non-objects are refused");
}

s.section("Test 3: the keyring decides per vault");
{
	const drive = new FakeDrive();
	const plain = keyring(drive, "");
	s.check((await plain.ready()) === null && plain.sealer === null, "no passphrase on a new vault: not encrypted");
	const metaFile = drive.filesIn(FOLDER).find((f) => f.name === "meta.json");
	s.check(metaFile !== undefined && !dec.decode(metaFile.data).includes("encryption"), "plain meta has no encryption block");
	s.check((await keyring(drive, "").ready()) === null, "another device without a passphrase joins");
	const err = await fails(() => keyring(drive, "oops").ready());
	s.check(err instanceof FatalCarrierError && err.message.includes("not encrypted"), "a passphrase on an existing unencrypted vault is refused, not silently ignored");
}
{
	const drive = new FakeDrive();
	const first = keyring(drive, "pass phrase 1");
	const sealer = await first.ready();
	s.check(sealer !== null, "a passphrase on a new vault turns encryption on");
	const metaFile = drive.filesIn(FOLDER).find((f) => f.name === "meta.json");
	const text = metaFile ? dec.decode(metaFile.data) : "";
	s.check(text.includes('"encryption"') && !text.includes("pass phrase 1"), "meta records the salt but never the passphrase");
	s.check(!anyFileContains(drive, "pass phrase 1"), "the passphrase is nowhere on Drive");
	const second = keyring(drive, "pass phrase 1");
	const sealer2 = await second.ready();
	const sealed = await sealer?.seal(enc.encode("hello"), "segment");
	s.check(sealed !== undefined && dec.decode(await (sealer2?.open(sealed, "segment") ?? Promise.reject(new Error("no sealer")))) === "hello", "a second device with the passphrase reads what the first wrote");
	const bad = await fails(() => keyring(drive, "wrong").ready());
	s.check(bad instanceof FatalCarrierError && bad.message.includes("passphrase is wrong"), "a wrong passphrase is a fatal, clearly worded error");
	const none = await fails(() => keyring(drive, "").ready());
	s.check(none instanceof FatalCarrierError && none.message.includes("This vault is encrypted"), "no passphrase on an encrypted vault is a fatal, clearly worded error");
	const readsOnce = drive.calls.readFile;
	await second.ready();
	await second.ensureMeta("any");
	s.check(drive.calls.readFile === readsOnce, "once unlocked, nothing is read again");
}
{
	// Damaged or foreign meta.
	const drive = new FakeDrive();
	await keyring(drive, "p").ready();
	drive.corrupt("meta.json", (d) => enc.encode(dec.decode(d).replace('"salt":"', '"salt":"@@')));
	const err = await fails(() => keyring(drive, "p").ready());
	s.check(err instanceof FatalCarrierError, "unreadable encryption details are fatal");
	const drive2 = new FakeDrive();
	const folder = await drive2.client().createFolder(FOLDER);
	await drive2.client().createFile(folder.id, "meta.json", enc.encode(JSON.stringify({ schema: 99 })));
	const err2 = await fails(() => keyring(drive2, "p").ready());
	s.check(err2 instanceof FatalCarrierError && err2.message.includes("layout 99"), "another layout is still refused first");
}
{
	// Retry after a failure.
	const drive = new FakeDrive();
	const k = keyring(drive, "p");
	drive.failNext("findFolders", 500, 1);
	s.check((await fails(() => k.ready())) instanceof DriveError, "a network failure is not fatal");
	s.check((await k.ready()) !== null, "and the next call works");
}
{
	// Two devices start the same encrypted vault at once: one salt wins, both can read each other.
	const drive = new FakeDrive();
	const a = keyring(drive, "same");
	const b = keyring(drive, "same");
	const [sa, sb] = await Promise.all([a.ready(), b.ready()]);
	const metas = drive.filesIn(FOLDER).filter((f) => f.name === "meta.json");
	s.check(metas.length === 1, "one meta file remains");
	const sealed = await sa?.seal(enc.encode("x"), "segment");
	s.check(sealed !== undefined && dec.decode(await (sb?.open(sealed, "segment") ?? Promise.reject(new Error("no sealer")))) === "x", "both devices ended up with the same key");
}

// ---------------------------------------------------------------------------
// Sync files
// ---------------------------------------------------------------------------

interface Device { doc: Y.Doc; text: Y.Text; transport: DriveTransport; fatal: string[] }

function device(drive: FakeDrive, name: string, passphrase: string): Device {
	const doc = new Y.Doc();
	const api = drive.client();
	const fatal: string[] = [];
	const transport = new DriveTransport(doc, api, {
		vaultId: VAULT,
		deviceId: name,
		autoTimers: false,
		now: () => clock,
		keyring: new DriveKeyring(api, { vaultId: VAULT, passphrase, kdfIterations: ITER }),
		onFatal: (m) => fatal.push(m),
	});
	return { doc, text: doc.getText("t"), transport, fatal };
}

async function settle(...devices: Device[]): Promise<void> {
	for (let round = 0; round < 3; round++) {
		for (const d of devices) {
			clock += 61_000;
			await d.transport.syncNow();
		}
	}
}

s.section("Test 4: encrypted sync between devices");
{
	const drive = new FakeDrive();
	const a = device(drive, "A", "pw");
	const b = device(drive, "B", "pw");
	a.text.insert(0, "my private diary entry");
	await settle(a, b);
	s.check(b.text.toString() === "my private diary entry", "the second device receives the text");
	b.text.insert(0, "B: ");
	await settle(a, b);
	s.check(a.text.toString() === b.text.toString() && a.text.toString().startsWith("B: "), "and edits travel back");
	s.check(!anyFileContains(drive, "diary"), "the text appears nowhere on Drive, in file names or content");
	const segs = drive.filesIn(FOLDER).filter((f) => classifyName(f.name) === "segment");
	s.check(segs.length >= 2 && segs.every((f) => f.data[6] === 1), "every segment carries the encrypted flag");
	s.check(a.fatal.length === 0 && b.fatal.length === 0, "no fatal error");
	a.transport.destroy();
	b.transport.destroy();
}

s.section("Test 5: wrong or missing passphrase stops the carrier cleanly");
{
	const drive = new FakeDrive();
	const a = device(drive, "A", "right");
	a.text.insert(0, "classified");
	await settle(a);
	const filesBefore = drive.files.size;
	const wrong = device(drive, "W", "wrong");
	wrong.text.insert(0, "should never be uploaded");
	await wrong.transport.connect();
	s.check(wrong.transport.fatalError?.includes("passphrase is wrong") === true, "wrong passphrase: the carrier is stopped with a clear reason");
	s.check(wrong.fatal.length === 1 && wrong.fatal[0] === wrong.transport.fatalError, "and the owner is told once");
	await wrong.transport.syncNow();
	s.check(drive.files.size === filesBefore && !anyFileContains(drive, "never be uploaded"), "nothing is written to the vault");
	s.check(wrong.text.toString() === "should never be uploaded", "and the local note is untouched");
	const none = device(drive, "N", "");
	await none.transport.connect();
	s.check(none.transport.fatalError?.includes("This vault is encrypted") === true && none.fatal.length === 1, "no passphrase on an encrypted vault: stopped with a clear reason");
	s.check(none.text.toString() === "", "nothing was applied from the encrypted files");
	const early = device(drive, "E", "extra");
	const plainDrive = new FakeDrive();
	const plainDev = device(plainDrive, "P", "");
	plainDev.text.insert(0, "plain");
	await settle(plainDev);
	const addLater = device(plainDrive, "Q", "late");
	await addLater.transport.connect();
	s.check(addLater.transport.fatalError?.includes("not encrypted") === true, "adding a passphrase to an existing plain vault is refused");
	for (const d of [a, wrong, none, early, plainDev, addLater]) d.transport.destroy();
}

s.section("Test 6: damaged and foreign files in an encrypted vault are skipped");
{
	const drive = new FakeDrive();
	const a = device(drive, "A", "pw");
	a.text.insert(0, "alpha");
	await settle(a);
	const segName = drive.namesIn(FOLDER).find((n) => classifyName(n) === "segment") ?? "";
	drive.corrupt(segName, (d) => { const c = d.slice(); c[c.length - 1] = (c[c.length - 1] ?? 0) ^ 0xff; return c; });
	// checksum now fails first
	const b = device(drive, "B", "pw");
	await b.transport.connect();
	s.check(b.text.toString() === "", "a damaged encrypted segment is not applied");
	// A forged file that passes the checksum but was not sealed with the key.
	const folder = (await drive.client().findFolders(FOLDER))[0];
	const forged = new Y.Doc();
	forged.getText("t").insert(0, "forged");
	const plainSegment = await encodeFile(KIND_SEGMENT, Y.encodeStateAsUpdate(forged), false);
	await drive.client().createFile(folder?.id ?? "", "seg-0000000000001-evil-0.ydu", plainSegment);
	const flagged = await encodeFile(KIND_SEGMENT, enc.encode("garbage that is not a sealed update at all, long enough"), true);
	await drive.client().createFile(folder?.id ?? "", "seg-0000000000002-evil-1.ydu", flagged);
	const c = device(drive, "C", "pw");
	await c.transport.connect();
	await c.transport.syncNow();
	s.check(!c.text.toString().includes("forged"), "an unencrypted file in an encrypted vault is not applied");
	s.check(c.fatal.length === 0 && c.transport.fatalError === null, "neither stops the carrier");
	// An encrypted file in an unencrypted vault.
	const plainDrive = new FakeDrive();
	const p = device(plainDrive, "P", "");
	p.text.insert(0, "x");
	await settle(p);
	const pf = (await plainDrive.client().findFolders(FOLDER))[0];
	await plainDrive.client().createFile(pf?.id ?? "", "seg-0000000000003-evil-0.ydu", flagged);
	const q = device(plainDrive, "Q", "");
	await q.transport.connect();
	s.check(q.text.toString() === "x", "an encrypted-flag file in a plain vault is skipped too");
	for (const d of [a, b, c, p, q]) d.transport.destroy();
}

s.section("Test 7: compaction and a new device joining from an encrypted snapshot");
{
	const drive = new FakeDrive();
	const a = device(drive, "A", "pw");
	const small = new DriveTransport(a.doc, drive.client(), {
		vaultId: VAULT, deviceId: "A2", autoTimers: false, now: () => clock, compactSegmentCount: 3,
		keyring: new DriveKeyring(drive.client(), { vaultId: VAULT, passphrase: "pw", kdfIterations: ITER }),
	});
	a.transport.destroy();
	for (let i = 0; i < 6; i++) {
		a.text.insert(0, `line ${i} of private text\n`);
		clock += 61_000;
		await small.syncNow();
	}
	const snaps = drive.filesIn(FOLDER).filter((f) => classifyName(f.name) === "snapshot");
	s.check(snaps.length >= 1 && snaps.every((f) => f.data[6] === 1), "compaction wrote an encrypted snapshot");
	s.check(!anyFileContains(drive, "private text"), "still no plaintext on Drive");
	const fresh = device(drive, "F", "pw");
	await settle(fresh);
	s.check(fresh.text.toString() === a.text.toString(), "a new device with the passphrase gets the whole document");
	small.destroy();
	fresh.transport.destroy();
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

function buf(text: string): ArrayBuffer {
	const b = enc.encode(text);
	return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

s.section("Test 8: encrypted attachments");
{
	const drive = new FakeDrive();
	const mk = (pass: string, now = () => clock) => new DriveBlobStore(drive.client(), { vaultId: VAULT, now, keyring: keyring(drive, pass) });
	const a = mk("pw");
	const hash = await sha256Hex(enc.encode("holiday photo bytes"));
	await a.upload(hash, "image/png", buf("holiday photo bytes"), 5000);
	const stored = drive.filesIn(blobFolderName(VAULT));
	s.check(stored.length === 1 && stored[0]?.name !== hash && /^[0-9a-f]{64}$/.test(stored[0]?.name ?? ""), "stored under a keyed name, not the content hash");
	s.check(!anyFileContains(drive, "holiday photo") && !anyFileContains(drive, hash), "neither the content nor its hash is on Drive");
	s.check((await a.exists([hash])).join() === hash, "exists finds it");
	const b = mk("pw");
	clock += 40_000;
	s.check((await b.exists([hash])).join() === hash, "another device with the passphrase finds it");
	s.check(dec.decode(await b.download(hash, 5000)) === "holiday photo bytes", "and downloads it");
	const creates = drive.calls.createFile;
	await b.upload(hash, "image/png", buf("holiday photo bytes"), 5000);
	s.check(drive.calls.createFile === creates + 1, "(an explicit upload still writes; the engine skips it through exists)");
	drive.corrupt(stored[0]?.name ?? "", (d) => { const c = d.slice(); c[20] = (c[20] ?? 0) ^ 1; return c; });
	const fresh = mk("pw");
	const damaged = await fails(() => fresh.download(hash, 5000));
	s.check(damaged instanceof DriveError && damaged.status === 502 && damaged.message.includes("damaged"), "a damaged encrypted attachment is never used");
	const wrongStore = mk("nope");
	const wrongErr = await fails(() => wrongStore.exists([hash]));
	s.check(wrongErr instanceof FatalCarrierError, "a wrong passphrase fails clearly");
	const rawHash = await sha256Hex(enc.encode("other"));
	const mismatch = await fails(() => a.upload(rawHash, "x/y", buf("something else"), 5000));
	s.check(mismatch !== null && mismatch.message.includes("does not match"), "the content must still match its hash before it is sealed");
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

s.section("Test 9: encrypted snapshots");
{
	const drive = new FakeDrive();
	const doc = new Y.Doc();
	doc.getMap<string>("pathToId").set("secret-plans.md", "id1");
	doc.getMap<Y.Text>("idToText").set("id1", new Y.Text("the launch codes"));
	const tick = { t: Date.UTC(2026, 5, 1, 10) };
	const mk = (pass: string, d: Y.Doc | null = doc) => new DriveSnapshotBackend(drive.client(), {
		vaultId: VAULT, getDoc: () => d, now: () => tick.t, keyring: keyring(drive, pass),
	});
	const a = mk("pw");
	const res = await a.now("laptop");
	s.check(res.status === "created", "snapshot created");
	s.check(!anyFileContains(drive, "launch codes") && !anyFileContains(drive, "secret-plans") && !anyFileContains(drive, "laptop"), "neither content, file names nor the index details are readable on Drive");
	const idx = drive.filesIn(snapshotFolderName(VAULT)).find((f) => f.name.startsWith("snapidx-"));
	s.check(idx !== undefined && !dec.decode(idx.data).includes("snapshotId"), "the index is sealed too");
	const b = mk("pw", null);
	const listed = await b.list();
	s.check(listed.length === 1 && listed[0]?.markdownFileCount === 1, "another device lists it");
	const back = await b.download(listed[0] as SnapshotIndex);
	s.check(back.getMap<string>("pathToId").get("secret-plans.md") === "id1", "and downloads it");
	tick.t += 86_400_000;
	s.check((await a.daily("laptop")).status === "created", "the next day's daily snapshot is created");
	tick.t += 1000;
	s.check((await a.daily("laptop")).status === "noop", "the daily noop works through the sealed index");
	const pruned = await b.prune();
	s.check(pruned.pruned === 0 && pruned.kept === 2, "cleanup works too");
	const wrong = await fails(() => mk("nope").list());
	s.check(wrong instanceof FatalCarrierError, "a wrong passphrase fails clearly");
	const sealedIdx = drive.filesIn(snapshotFolderName(VAULT)).find((f) => f.name.startsWith("snapidx-"));
	drive.corrupt(sealedIdx?.name ?? "", (d) => { const c = d.slice(); c[15] = (c[15] ?? 0) ^ 1; return c; });
	s.check((await mk("pw", null).list()).length === 1, "one damaged index is skipped, the other still lists");
}

await s.done();

/**
 * Drive carrier: file format and file names.
 */

import * as Y from "yjs";
import { CorruptFileError, KIND_SEGMENT, KIND_SNAPSHOT, classifyName, decodeFile, encodeFile, segmentName, sessionTag, snapshotName } from "../../src/drive-carrier/fileFormat";
import { suite } from "../harness.ts";

const s = suite("drive-carrier-format");

async function rejects(bytes: Uint8Array): Promise<string | null> {
	try {
		await decodeFile(bytes);
		return null;
	} catch (err) {
		return err instanceof CorruptFileError ? err.message : `wrong error type: ${String(err)}`;
	}
}

s.section("Test 1: round trip");
{
	const payload = new Uint8Array([1, 2, 3, 250, 0, 7]);
	const seg = await decodeFile(await encodeFile(KIND_SEGMENT, payload));
	s.check(seg.kind === KIND_SEGMENT && Array.from(seg.payload).join() === "1,2,3,250,0,7", "segment round trips");
	const snap = await decodeFile(await encodeFile(KIND_SNAPSHOT, new Uint8Array(0)));
	s.check(snap.kind === KIND_SNAPSHOT && snap.payload.length === 0, "empty snapshot payload round trips");
}

s.section("Test 2: damaged files are rejected, never applied");
{
	const good = await encodeFile(KIND_SEGMENT, new Uint8Array([9, 8, 7, 6]));
	const flipped = good.slice();
	flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 0xff;
	s.check((await rejects(flipped)) === "checksum mismatch", "flipped payload byte -> checksum mismatch");
	const truncated = good.slice(0, good.length - 1);
	s.check((await rejects(truncated)) === "checksum mismatch", "truncated payload -> checksum mismatch");
	s.check((await rejects(good.slice(0, 10))) !== null, "shorter than header -> rejected");
	const badMagic = good.slice();
	badMagic[0] = 0;
	s.check((await rejects(badMagic)) === "bad magic", "bad magic -> rejected");
	const badVersion = good.slice();
	badVersion[4] = 99;
	s.check(((await rejects(badVersion)) ?? "").includes("unsupported format version"), "unknown version -> rejected");
	const badKind = good.slice();
	badKind[5] = 77;
	s.check(((await rejects(badKind)) ?? "").includes("unknown file kind"), "unknown kind -> rejected");
	const flippedChecksum = good.slice();
	flippedChecksum[20] = (flippedChecksum[20] ?? 0) ^ 1;
	s.check((await rejects(flippedChecksum)) === "checksum mismatch", "flipped checksum byte -> rejected");
}

s.section("Test 3: names");
{
	const seg = segmentName(1234, "dev1", 7);
	const snap = snapshotName(1234, "dev1", 8);
	s.check(classifyName(seg) === "segment", `segment name classified (${seg})`);
	s.check(classifyName(snap) === "snapshot", `snapshot name classified (${snap})`);
	s.check(classifyName("meta.json") === "meta", "meta classified");
	s.check(classifyName("notes.txt") === "other", "foreign file ignored");
	s.check(classifyName("seg-1-dev.ydu") === "other", "malformed segment name ignored");
	s.check(segmentName(5, "d", 0) < segmentName(50, "d", 0), "names sort by time");
}

s.section("Test: the encrypted flag");
{
	const payload = new Uint8Array([1, 2, 3]);
	const plain = await encodeFile(KIND_SEGMENT, payload);
	const flagged = await encodeFile(KIND_SEGMENT, payload, true);
	s.check(plain[6] === 0 && plain[7] === 0, "plain files keep the flag and reserved bytes at zero (as before)");
	s.check(flagged[6] === 1 && flagged[7] === 0, "the encrypted flag is bit 0 of byte 6");
	s.check((await decodeFile(plain)).encrypted === false && (await decodeFile(flagged)).encrypted === true, "decoding reports the flag");
	const noFlag = flagged.slice();
	noFlag[6] = 0;
	s.check((await decodeFile(noFlag)).encrypted === false, "the flag is not covered by the checksum, so it is checked against the vault instead (see the crypto suite)");
}

s.section("Test: F9b — two runs cannot mint the same name");
{
	const one = sessionTag(1_700_000_000_000, 1);
	const two = sessionTag(1_700_000_000_000, 2);
	s.check(one !== two, "the same millisecond in a different run gives a different tag");
	s.check(sessionTag(1_700_000_000_001, 1) !== one, "a later run in the same process differs as well");
	const first = segmentName(1_700_000_000_000, "dev", 0, one);
	const second = segmentName(1_700_000_000_000, "dev", 0, two);
	s.check(first !== second, "so two runs starting in the same millisecond do not collide on a name");
	s.check(classifyName(first) === "segment" && classifyName(snapshotName(1_700_000_000_000, "dev", 0, one)) === "snapshot", "tagged names are classified exactly as before");
	s.check(first.startsWith("seg-1700000000000-dev-0-"), `the 13-digit stamp still leads (${first})`);
	s.check(segmentName(5, "d", 0, one) < segmentName(50, "d", 0, one), "and names still sort by time");
	s.check(segmentName(1000, "d", 0) === "seg-0000000001000-d-0.ydu" && snapshotName(1000, "d", 1) === "snap-0000000001000-d-1.yds", "without a tag the names are byte-for-byte what 2.1.22 wrote");
}

s.section("Test: F9d — the header is not signed, and every consequence fails closed");
{
	const source = new Y.Doc();
	source.getText("t").insert(0, "x");
	const update = Y.encodeStateAsUpdate(source);
	const segment = await encodeFile(KIND_SEGMENT, update);

	// kind flipped: the bytes are a valid update either way.
	const asSnapshot = segment.slice();
	asSnapshot[5] = KIND_SNAPSHOT;
	const decoded = await decodeFile(asSnapshot);
	s.check(decoded.payload.join() === update.join(), "flipping the kind leaves the payload untouched");
	s.check(decoded.kind === KIND_SNAPSHOT, "the reader reports the kind the header claims");
	const target = new Y.Doc();
	Y.applyUpdate(target, decoded.payload);
	s.check(target.getText("t").toString() === "x", "and the bytes apply as the same update, so nothing can be smuggled in");
	s.check((await decodeFile(segment)).kind === KIND_SEGMENT, "the untouched file still reads as a segment");

	// an unknown kind is rejected rather than guessed at.
	const unknownKind = segment.slice();
	unknownKind[5] = 77;
	s.check((await rejects(unknownKind))?.includes("unknown file kind") === true, "an unknown kind byte is rejected");

	// the encrypted flag is outside the checksum by design; the reader believes it,
	// and the vault's key then refuses the file (drive-carrier-crypto.ts).
	const flagged = segment.slice();
	flagged[6] = 1;
	const read = await decodeFile(flagged);
	s.check(read.encrypted === true && read.payload.join() === update.join(), "flipping the encrypted flag is read as claimed and leaves the payload alone");
	s.check((await decodeFile(segment)).encrypted === false, "and the plain file is unchanged");
}

await s.done();

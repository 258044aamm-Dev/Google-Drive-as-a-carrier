/**
 * Drive carrier: file format and file names.
 */

import { CorruptFileError, KIND_SEGMENT, KIND_SNAPSHOT, classifyName, decodeFile, encodeFile, segmentName, snapshotName } from "../../src/drive-carrier/fileFormat";
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

await s.done();

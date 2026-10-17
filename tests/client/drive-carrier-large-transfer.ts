/**
 * F11: payloads above Google Drive's multipart ceiling.
 *
 * Google documents simple and multipart uploads for files up to 5 MB and asks
 * for resumable uploads above that. The carrier routinely exceeds it: a
 * compaction snapshot is the whole document, a new device uploads the whole
 * difference, and attachments can reach the configured cap. This suite pins
 * both halves:
 *
 *   REST layer (scripted HTTP double):
 *     - above the threshold: POST opens a session, PUT carries the bytes, and
 *       nothing is sent as a multipart body;
 *     - at or below it: exactly one multipart request, as before;
 *     - a reply without a session URL, or with one that is not a Google host,
 *       is refused with a clear error instead of being followed (that reply
 *       would otherwise receive the access token and the notes).
 *
 *   carrier layer (FakeDrive, no HTTP):
 *     - a document larger than 5 MB is created by one device, uploaded, and
 *       reconstructed from Drive alone by a fresh device that never saw it.
 *
 * The ceiling itself is enforced where it exists: multipart and resumable are
 * properties of Drive's HTTP API, which is what the scripted double above
 * models. FakeDrive speaks DriveApi, an interface with no upload-type notion,
 * so a limit there would model a constraint the interface does not have; the
 * carrier-layer case instead proves the data path end to end.
 */
import * as Y from "yjs";
import { DriveTransport } from "../../src/drive-carrier/driveTransport";
import { DriveError } from "../../src/drive-carrier/driveApi";
import { RESUMABLE_UPLOAD_THRESHOLD_BYTES, GoogleDriveRest, type DriveHttp, type DriveHttpRequest, type DriveHttpResponse } from "../../src/drive-carrier/googleDriveRest";
import { FakeDrive } from "../mocks/fakeDrive";
import { suite } from "../harness.ts";

const s = suite("drive-carrier-large-transfer");
const enc = new TextEncoder();
const dec = new TextDecoder();
const MB = 1024 * 1024;
const VAULT = "lt1";

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): DriveHttpResponse {
	return { status, body: enc.encode(JSON.stringify(body)), headers };
}

/** The session URL Google answers a resumable initiation with. */
const SESSION_URL = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=abc123";

function makeApi(handler: (req: DriveHttpRequest, n: number) => DriveHttpResponse | Promise<DriveHttpResponse>): {
	api: GoogleDriveRest;
	requests: DriveHttpRequest[];
} {
	const requests: DriveHttpRequest[] = [];
	const http: DriveHttp = async (req) => {
		requests.push(req);
		return handler(req, requests.length);
	};
	return { api: new GoogleDriveRest(http, () => Promise.resolve("token")), requests };
}

/** A payload just above the threshold, built from a repeating byte pattern. */
function bigPayload(bytes: number): Uint8Array {
	const out = new Uint8Array(bytes);
	for (let i = 0; i < bytes; i++) out[i] = (i * 31) & 0xff;
	return out;
}

// ---------------------------------------------------------------------------
s.section("Test 1: above the threshold, the upload is resumable (never multipart)");
{
	const data = bigPayload(RESUMABLE_UPLOAD_THRESHOLD_BYTES + 1024);
	const { api, requests } = makeApi((req) => {
		if (req.method === "POST") return jsonResponse(200, {}, { Location: SESSION_URL });
		return jsonResponse(200, { id: "big-1", name: "snap-big.yds", size: String(data.length) });
	});
	const info = await api.createFile("folder-1", "snap-big.yds", data);

	s.check(requests.length === 2, `exactly two requests: open, then upload (${requests.length})`);
	const open = requests[0];
	const put = requests[1];
	s.check(
		open?.method === "POST" && open.url.startsWith("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable"),
		"step 1 opens a resumable session",
	);
	const openBody = typeof open?.body === "string" ? open.body : open?.body instanceof Uint8Array ? dec.decode(open.body) : "";
	s.check(
		openBody.includes('"parents":["folder-1"]') && openBody.includes('"name":"snap-big.yds"'),
		`the session is opened with the name and parent (${openBody})`,
	);
	s.check(
		open?.headers["X-Upload-Content-Length"] === String(data.length),
		"the size is declared before the bytes travel",
	);
	s.check(put?.method === "PUT" && put.url === SESSION_URL, "step 2 PUTs to the session URL");
	const sent = put?.body instanceof Uint8Array ? put.body : new Uint8Array();
	s.check(sent.length === data.length, `all bytes travel in the PUT (${sent.length} of ${data.length})`);
	s.check(sent[0] === data[0] && sent[sent.length - 1] === data[data.length - 1], "first and last byte intact");
	s.check(
		!requests.some((req) => (req.headers["Content-Type"] ?? "").startsWith("multipart/")),
		"no multipart body was built for this upload",
	);
	s.check(info.id === "big-1" && info.size === data.length, "the stored file is parsed from the reply");
}

// ---------------------------------------------------------------------------
s.section("Test 2: at or below the threshold, the multipart path is unchanged");
{
	for (const [label, size] of [["1 byte", 1], ["4 MB (the threshold)", RESUMABLE_UPLOAD_THRESHOLD_BYTES]] as const) {
		const data = new Uint8Array(size).fill(7);
		const { api, requests } = makeApi(() => jsonResponse(200, { id: "n", name: "seg.ydu", size: String(size) }));
		await api.createFile("folder-1", "seg.ydu", data);
		s.check(requests.length === 1, `${label}: exactly one request (no extra round-trip)`);
		s.check(
			(requests[0]?.headers["Content-Type"] ?? "").startsWith("multipart/related"),
			`${label}: still sent as multipart`,
		);
	}
}

// ---------------------------------------------------------------------------
s.section("Test 3: a reply we cannot vouch for is refused, not followed");
{
	const data = bigPayload(RESUMABLE_UPLOAD_THRESHOLD_BYTES + 1);
	const attempts: Array<[string, (req: DriveHttpRequest) => DriveHttpResponse]> = [
		["no session URL at all", () => jsonResponse(200, {})],
		["a session URL that is not a URL", () => jsonResponse(200, {}, { Location: "not a url" })],
		["a session URL on another host", () => jsonResponse(200, {}, { Location: "https://evil.example.com/upload" })],
		["a session URL over cleartext", () => jsonResponse(200, {}, { Location: "http://www.googleapis.com/upload" })],
	];
	for (const [label, reply] of attempts) {
		const { api, requests } = makeApi((req) => reply(req));
		let error: unknown = null;
		try {
			await api.createFile("folder-1", "snap-big.yds", data);
		} catch (err) {
			error = err;
		}
		s.check(error instanceof DriveError, `${label}: refused with a DriveError`);
		s.check(
			error instanceof DriveError && /Resumable upload of snap-big\.yds/.test(error.message),
			`${label}: the message names the file (${error instanceof Error ? error.message : String(error)})`,
		);
		s.check(requests.length === 1, `${label}: the payload was never sent anywhere`);
	}
}

// ---------------------------------------------------------------------------
s.section("Test 5: if Drive refuses an upload, the refusal surfaces once and is not retried in a loop");
{
	// Google's own answer when a multipart body is over the ceiling. It must
	// reach the caller as a clear DriveError, and the REST layer must not answer
	// it with a retry storm (the sync loop decides when to come back).
	const refusal = "Bad Request. File exceeds the maximum size for uploadType=multipart.";
	const { api, requests } = makeApi(() => jsonResponse(400, { error: { message: refusal } }));
	let error: unknown = null;
	try {
		await api.createFile("folder-1", "seg-small.ydu", new Uint8Array(1024).fill(3));
	} catch (err) {
		error = err;
	}
	s.check(error instanceof DriveError && error.status === 400, "the refusal is a DriveError with Drive's status");
	s.check(error instanceof DriveError && error.message.includes(refusal), `the reason is carried to the caller (${error instanceof Error ? error.message : String(error)})`);
	s.check(error instanceof DriveError && error.retryable === false, "a 400 is not classified as automatically retryable");
	s.check(requests.length === 1, `exactly one request was made, no loop (${requests.length})`);
}

// ---------------------------------------------------------------------------
s.section("Test 4: a document larger than 5 MB travels between two devices");
{
	const drive = new FakeDrive();
	let clock = 1_700_000_000_000;
	const make = (deviceId: string, doc: Y.Doc): DriveTransport =>
		new DriveTransport(doc, drive.client(), {
			vaultId: VAULT,
			deviceId,
			autoTimers: false,
			now: () => clock,
		});

	const a = new Y.Doc();
	a.clientID = 1111;
	const ta = make("LTA", a);
	// ~6 MB of ordinary note text, larger than Drive's multipart ceiling.
	const line = "the quick brown fox jumps over the lazy dog, again and again. ";
	const text = a.getText("t");
	const lines = Math.ceil((6 * MB) / line.length);
	for (let i = 0; i < lines; i++) text.insert(text.length, `${String(i).padStart(7, "0")} ${line}\n`);
	const docBytes = Y.encodeStateAsUpdate(a).length;
	await ta.connect();
	s.check(ta.synced === true && ta.fatalError === null, "the publishing device is synced");
	s.check(docBytes > 5 * MB, `the document is larger than the 5 MB multipart ceiling (${(docBytes / MB).toFixed(2)} MB)`);

	const expected = text.toString();
	const onDrive = drive.namesIn(`YAOS ${VAULT}`).filter((n) => n.startsWith("seg-") || n.startsWith("snap-"));
	s.check(onDrive.length > 0, `its state reached Drive (${onDrive.length} file(s))`);

	// A brand-new device that has never seen the document, reading Drive alone.
	const b = new Y.Doc();
	b.clientID = 2222;
	const tb = make("LTB", b);
	await tb.connect();
	await tb.syncNow();
	s.check(tb.fatalError === null, "the new device was not refused");
	s.check(
		b.getText("t").toString() === expected,
		`the new device reconstructs the whole ${(docBytes / MB).toFixed(2)} MB document (${b.getText("t").length} of ${expected.length} chars)`,
	);

	// And a further edit on the new device returns to the first one.
	clock += 60_000;
	b.getText("t").insert(0, "written on the new device\n");
	await tb.syncNow();
	await ta.syncNow();
	s.check(
		a.getText("t").toString().startsWith("written on the new device"),
		"an edit from the new device comes back to the publisher",
	);
	ta.destroy();
	tb.destroy();
}

await s.done();

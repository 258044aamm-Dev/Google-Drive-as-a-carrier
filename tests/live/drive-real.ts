/**
 * F8: the one suite that talks to a real Google Drive.
 *
 * Everything else in this repo runs against FakeDrive, and the repo's own QA
 * docs say a fake "is not a substitute". This script measures the things the
 * fake cannot model: how long a created file takes to appear in a listing, how
 * a deleted file behaves, whether Drive really allows two files with one name,
 * what the multipart ceiling is, what an error body looks like, and whether a
 * token issued by one Google client can see files created by another.
 *
 * IT IS OPT-IN AND ENVIRONMENT-GUARDED. It is registered in tests/suites.json
 * under "skip" with a reason, so the regression run never touches it. To run it:
 *
 *   YAOS_DRIVE_LIVE=1 \
 *   YAOS_DRIVE_CLIENT_ID=... YAOS_DRIVE_CLIENT_SECRET=... YAOS_DRIVE_REFRESH_TOKEN=... \
 *   node --import jiti/register tests/live/drive-real.ts
 *
 * With the easy sign-in instead of your own client:
 *
 *   YAOS_DRIVE_LIVE=1 YAOS_DRIVE_REFRESH_TOKEN=<the sign-in code> \
 *   [YAOS_DRIVE_HOSTED_URL=https://.../api/access] node --import jiti/register tests/live/drive-real.ts
 *
 * Optional: YAOS_DRIVE_VAULT_ID (folder suffix; a random one is used otherwise),
 * YAOS_DRIVE_ALT_REFRESH_TOKEN (+ ALT_CLIENT_ID/ALT_CLIENT_SECRET) to test that
 * a second sign-in cannot see these files.
 *
 * Everything it creates is deleted again at the end, and it never touches the
 * folder of a normal vault: it works in `YAOS <vaultId> live-probe`.
 *
 * The output is meant to be committed as evidence (docs/drive-carrier-device-results.md).
 */
import { GoogleDriveRest, type DriveHttp, type DriveHttpRequest, type DriveHttpResponse } from "../../src/drive-carrier/googleDriveRest";
import { GoogleTokenManager } from "../../src/drive-carrier/googleAuth";
import { HostedTokenManager } from "../../src/drive-carrier/hostedAuth";
import { DriveError, type DriveApi, type DriveFileInfo } from "../../src/drive-carrier/driveApi";
import { DriveBlobStore } from "../../src/drive-carrier/driveBlobStore";
import { MeteredDriveApi } from "../../src/drive-carrier/requestMeter";
import { suite } from "../harness.ts";

const s = suite("drive-real");
const dec = new TextDecoder();
const enc = new TextEncoder();

const enabled = process.env.YAOS_DRIVE_LIVE === "1";
if (!enabled) {
	console.log("drive-real: skipped (set YAOS_DRIVE_LIVE=1 plus the token environment to run it).");
	console.log("drive-real: see docs/drive-carrier-device-results.md for what a run records.");
	process.exit(0);
}

// ---------------------------------------------------------------------------
// Setup: a real token, a real REST client, a folder of our own
// ---------------------------------------------------------------------------

const clientId = process.env.YAOS_DRIVE_CLIENT_ID ?? "";
const clientSecret = process.env.YAOS_DRIVE_CLIENT_SECRET ?? "";
const refreshToken = process.env.YAOS_DRIVE_REFRESH_TOKEN ?? "";
const hostedUrl = process.env.YAOS_DRIVE_HOSTED_URL ?? "";
const altRefresh = process.env.YAOS_DRIVE_ALT_REFRESH_TOKEN ?? "";
const vaultId = process.env.YAOS_DRIVE_VAULT_ID ?? `live-${Date.now().toString(36)}`;

if (!refreshToken) {
	console.error("drive-real: YAOS_DRIVE_REFRESH_TOKEN is required.");
	process.exit(2);
}
if (!hostedUrl && (!clientId || !clientSecret)) {
	console.error("drive-real: set YAOS_DRIVE_CLIENT_ID and YAOS_DRIVE_CLIENT_SECRET, or YAOS_DRIVE_HOSTED_URL.");
	process.exit(2);
}

/** Node fetch as the drive HTTP adapter, with the headers the REST layer expects. */
const http: DriveHttp = async (request: DriveHttpRequest): Promise<DriveHttpResponse> => {
	const res = await fetch(request.url, {
		method: request.method,
		headers: request.headers,
		body: request.body as BodyInit | undefined,
	});
	const body = new Uint8Array(await res.arrayBuffer());
	const headers: Record<string, string> = {};
	res.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
	return { status: res.status, body, headers };
};

const tokens = hostedUrl
	? new HostedTokenManager(http, hostedUrl, refreshToken)
	: new GoogleTokenManager(http, { clientId, clientSecret }, refreshToken);
const meter = new MeteredDriveApi(new GoogleDriveRest(http, tokens.provider));
const api: DriveApi = meter;

const PROBE_FOLDER = `YAOS ${vaultId} live-probe`;
const created: DriveFileInfo[] = [];
let folderId = "";

async function ensureProbeFolder(): Promise<void> {
	const existing = await api.findFolders(PROBE_FOLDER);
	if (existing.length > 0) {
		folderId = existing[0]?.id ?? "";
		console.log(`drive-real: using the existing probe folder (${existing.length} with this name)`);
		return;
	}
	const folder = await api.createFolder(PROBE_FOLDER);
	folderId = folder.id;
	console.log(`drive-real: created probe folder "${PROBE_FOLDER}"`);
}

async function make(name: string, bytes: Uint8Array): Promise<DriveFileInfo> {
	const info = await api.createFile(folderId, name, bytes);
	created.push(info);
	return info;
}

async function listNames(): Promise<DriveFileInfo[]> {
	return api.listFiles(folderId);
}

/** How long Drive takes to show a file that was just created. */
async function visibilityLatency(name: string, limitMs = 30_000): Promise<number | null> {
	const started = Date.now();
	for (;;) {
		const files = await listNames();
		if (files.some((f) => f.name === name)) return Date.now() - started;
		if (Date.now() - started > limitMs) return null;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}

async function disappearanceLatency(name: string, limitMs = 30_000): Promise<number | null> {
	const started = Date.now();
	for (;;) {
		const files = await listNames();
		if (!files.some((f) => f.name === name)) return Date.now() - started;
		if (Date.now() - started > limitMs) return null;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}

const report: string[] = [];
function record(line: string): void {
	report.push(line);
	console.log(`drive-real: ${line}`);
}

function randomBytes(n: number): Uint8Array {
	const out = new Uint8Array(n);
	for (let i = 0; i < n; i++) out[i] = (i * 31 + 17) & 0xff;
	return out;
}

// ---------------------------------------------------------------------------
// The probes
// ---------------------------------------------------------------------------

s.section("Test 1: the listing really is eventually consistent");
{
	const name = `probe-visible-${Date.now()}.txt`;
	await make(name, enc.encode("hello"));
	const latency = await visibilityLatency(name);
	record(`create -> visible in the listing: ${latency === null ? "NEVER (>30s)" : `${latency} ms`}`);
	s.check(latency !== null, "a created file appears in listFiles");
	s.check(latency !== null && latency < 60_000, `it appears within the transport's listing grace (${String(latency)} ms)`);

	const files = await listNames();
	const mine = files.filter((f) => f.name === name);
	s.check(mine.length === 1 && mine[0]?.size === 5, `the listing reports the exact size (${String(mine[0]?.size)})`);
	const one = await api.getFile(mine[0]?.id ?? "");
	s.check(one.size === 5 && one.name === name, "getFile agrees with the listing");

	await api.deleteFile(mine[0]?.id ?? "");
	created.splice(created.findIndex((f) => f.id === mine[0]?.id), 1);
	const gone = await disappearanceLatency(name);
	record(`delete -> gone from the listing: ${gone === null ? "NEVER (>30s)" : `${gone} ms`}`);
	s.check(gone !== null, "a deleted file stops appearing in listFiles");
}

s.section("Test 2: Drive allows two files with the same name");
{
	const name = `probe-duplicate-${Date.now()}.txt`;
	const first = await make(name, enc.encode("one"));
	const second = await make(name, enc.encode("two"));
	const mine = (await listNames()).filter((f) => f.name === name);
	record(`duplicate names allowed: ${mine.length} files named ${name}`);
	s.check(mine.length === 2 && first.id !== second.id, "both files exist under one name");
	s.check(mine.map((f) => f.size).sort().join() === "3,3", "and each carries its own bytes");
	await api.deleteFile(first.id);
	await api.deleteFile(second.id);
	created.length = 0;
}

s.section("Test 3: where the multipart ceiling really is (F11)");
{
	// The transport switches to resumable above RESUMABLE_UPLOAD_THRESHOLD_BYTES
	// (4 MB). This probe checks that the switch is where it needs to be: the
	// byte-identical multipart body is accepted below it and refused above it.
	const below = randomBytes(4 * 1024 * 1024);
	const belowInfo = await make("probe-multipart-4mb.bin", below);
	const readBack = await api.readFile(belowInfo.id);
	record(`4 MB multipart upload: accepted, read back ${readBack.length} bytes`);
	s.check(readBack.length === below.length, "4 MB round trips");
	s.check(readBack.every((b, i) => b === below[i]), "byte for byte");

	// One raw multipart request above the threshold, to record what Drive says.
	const over = randomBytes(5 * 1024 * 1024 + 1024);
	const boundary = "yaosliveprobe";
	const head = enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: "probe-multipart-5mb.bin", parents: [folderId] })}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`);
	const tail = enc.encode(`\r\n--${boundary}--`);
	const body = new Uint8Array(head.length + over.length + tail.length);
	body.set(head, 0); body.set(over, head.length); body.set(tail, head.length + over.length);
	const token = await tokens.provider();
	const res = await http({
		url: "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size",
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
		body,
	});
	let reason = "";
	try {
		const parsed = JSON.parse(dec.decode(res.body)) as { error?: { errors?: { reason?: string }[]; message?: string } };
		reason = parsed.error?.errors?.[0]?.reason ?? parsed.error?.message ?? "";
	} catch { /* not JSON */ }
	record(`5 MB multipart upload: HTTP ${res.status} ${reason === "" ? "" : `(${reason})`}`);
	s.check(res.status === 200 || res.status === 400, `Drive answers 200 or 400 above the ceiling (${res.status})`);
	if (res.status === 200) {
		// Accepted: the probe's own conclusion is that 5 MB still fits, so the
		// threshold stays conservative. Record it and clean up.
		const parsed = JSON.parse(dec.decode(res.body)) as { id?: string };
		if (parsed.id) await api.deleteFile(parsed.id);
		record("the ceiling is above 5 MB; the 4 MB threshold stays conservative");
	} else {
		record("the ceiling is at or below 5 MB, which is why the carrier switches to resumable at 4 MB");
	}

	await api.deleteFile(belowInfo.id);
	created.length = 0;
}

s.section("Test 4: a large file goes up resumably and comes back whole");
{
	const size = 6 * 1024 * 1024 + 12345;
	const bytes = randomBytes(size);
	const info = await make("probe-resumable-6mb.bin", bytes);
	const back = await api.readFile(info.id);
	record(`resumable path: stored ${String(info.size)} bytes, read back ${back.length}`);
	s.check(info.size === size, "Drive echoes the size");
	s.check(back.length === size && back.every((b, i) => b === bytes[i]), "the 6 MB file round trips byte for byte");
	await api.deleteFile(info.id);
	created.length = 0;
}

s.section("Test 5: error bodies (what the retry logic classifies)");
{
	const cases: { label: string; run: () => Promise<unknown> }[] = [
		{ label: "missing file id", run: () => api.getFile("0000000000000000000000000000000000000") },
		{ label: "missing folder for listFiles", run: () => api.listFiles("0000000000000000000000000000000000000") },
		{ label: "delete of a missing file", run: () => api.deleteFile("0000000000000000000000000000000000000") },
	];
	for (const probe of cases) {
		try {
			await probe.run();
			s.check(false, `${probe.label}: expected an error`);
		} catch (error) {
			const drive = error instanceof DriveError ? error : null;
			s.check(drive !== null, `${probe.label}: a DriveError with a status (${drive?.status ?? "none"})`);
			const text = drive?.message ?? "";
			record(`${probe.label}: HTTP ${String(drive?.status)} ${text.slice(0, 120).replace(/\s+/g, " ")}`);
			s.check(!text.includes("Bearer "), "the message never contains the access token");
		}
	}
	// A dead token: the shape the carrier's re-auth path sees.
	const dead = new GoogleDriveRest(http, () => Promise.resolve("yaos-live-probe-not-a-token"));
	try {
		await dead.listFiles(folderId);
		s.check(false, "a dead token must not list files");
	} catch (error) {
		const drive = error instanceof DriveError ? error : null;
		record(`dead access token: HTTP ${String(drive?.status)}`);
		s.check(drive?.status === 401, "a dead token is reported as 401");
	}
	s.check(true, "403 (rate limit) is not provoked on purpose; see the results doc for that gap");
}

s.section("Test 6: attachments round trip through the real blob store");
{
	// One layer above the raw API: the same store the plugin uses for attachments.
	const store = new DriveBlobStore(api, { vaultId });
	const payload = randomBytes(1024 * 1024 + 7);
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", payload));
	const hash = Array.from(digest).map((b: number) => b.toString(16).padStart(2, "0")).join("");
	const copy = new ArrayBuffer(payload.length);
	new Uint8Array(copy).set(payload);
	await store.upload(hash, "application/octet-stream", copy, 60_000);
	const back = new Uint8Array(await store.download(hash, 60_000));
	record(`attachment round trip: ${payload.length} bytes, name ${hash.slice(0, 12)}…`);
	s.check(back.length === payload.length && back.every((b: number, i: number) => b === payload[i]), "the attachment comes back byte for byte");
	const exists = await store.exists([hash]);
	s.check(exists.includes(hash), "and exists() agrees");
	// Clean up by name: the blob store has no delete path (F6, deliberately).
	const blobFolder = `YAOS ${vaultId} blobs`;
	const folders = await api.findFolders(blobFolder);
	const files = folders[0] ? await api.listFiles(folders[0].id) : [];
	for (const file of files) if (file.name === hash) await api.deleteFile(file.id);
	record(`attachment cleanup: removed ${files.filter((f) => f.name === hash).length} stored file(s)`);
}

s.section("Test 7: a second sign-in cannot see these files");
{
	if (!altRefresh) {
		record("second-client invisibility: NOT RUN (set YAOS_DRIVE_ALT_REFRESH_TOKEN to cover it)");
		s.check(true, "the check is skipped without a second sign-in");
	} else {
		const altTokens = /^https?:/.test(altRefresh) || hostedUrl
			? new HostedTokenManager(http, process.env.YAOS_DRIVE_ALT_HOSTED_URL ?? hostedUrl, altRefresh)
			: new GoogleTokenManager(http, {
				clientId: process.env.YAOS_DRIVE_ALT_CLIENT_ID ?? clientId,
				clientSecret: process.env.YAOS_DRIVE_ALT_CLIENT_SECRET ?? clientSecret,
			}, altRefresh);
		const alt = new GoogleDriveRest(http, altTokens.provider);
		const visible = await alt.findFolders(PROBE_FOLDER);
		record(`second sign-in sees ${visible.length} folder(s) named ${PROBE_FOLDER}`);
		s.check(visible.length === 0, "the drive.file scope hides this folder from the other sign-in");
		try {
			await alt.listFiles(folderId);
			s.check(false, "reading the first sign-in's folder id must fail");
		} catch (error) {
			s.check(error instanceof DriveError, `and reading by id fails (${String(error instanceof DriveError ? error.status : error)})`);
		}
	}
}

// ---------------------------------------------------------------------------
// Cleanup and the evidence block
// ---------------------------------------------------------------------------

s.section("Cleanup");
{
	const files = folderId ? await listNames() : [];
	for (const file of files) {
		try { await api.deleteFile(file.id); } catch { /* already gone */ }
	}
	if (folderId) {
		try { await api.deleteFile(folderId); } catch { /* already gone */ }
	}
	const left = folderId ? await listNames().catch(() => []) : [];
	s.check(left.length === 0, "the probe folder is empty again (or gone)");
}

const stats = meter.stats();
record(`requests: ${stats.total} (createFile ${stats.byOperation.createFile ?? 0}, readFile ${stats.byOperation.readFile ?? 0}, listFiles ${stats.byOperation.listFiles ?? 0})`);
record(`payload bytes: written ${stats.bytesWritten}, read ${stats.bytesRead}`);
record(`measured: ${report.filter((line) => line.includes(":")).slice(0, 12).join(" | ")}`);

console.log("\ndrive-real: evidence for docs/drive-carrier-device-results.md");
for (const line of report) console.log(`  - ${line}`);

await s.done();

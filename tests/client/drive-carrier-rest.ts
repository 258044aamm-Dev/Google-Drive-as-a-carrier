/**
 * Drive carrier: the Google Drive v3 REST client, against a scripted HTTP double.
 */

import { DriveError } from "../../src/drive-carrier/driveApi";
import { GoogleDriveRest, type DriveHttp, type DriveHttpRequest, type DriveHttpResponse } from "../../src/drive-carrier/googleDriveRest";
import { suite } from "../harness.ts";

const s = suite("drive-carrier-rest");
const enc = new TextEncoder();
const dec = new TextDecoder();

function json(status: number, body: unknown): DriveHttpResponse {
	return { status, body: enc.encode(JSON.stringify(body)) };
}

function makeApi(handler: (req: DriveHttpRequest, n: number) => DriveHttpResponse | Promise<DriveHttpResponse>) {
	const requests: DriveHttpRequest[] = [];
	const tokens: (boolean | undefined)[] = [];
	const http: DriveHttp = async (req) => {
		requests.push(req);
		return handler(req, requests.length);
	};
	const api = new GoogleDriveRest(http, (force) => {
		tokens.push(force);
		return Promise.resolve(force ? "fresh-token" : "token");
	});
	return { api, requests, tokens };
}

s.section("Test 1: findFolders builds an escaped query and parses results");
{
	const { api, requests } = makeApi(() => json(200, { files: [{ id: "f1", name: "x", createdTime: "2026-01-02T03:04:05.000Z" }] }));
	const found = await api.findFolders("Bob's \\ vault");
	s.check(found.length === 1 && found[0]?.id === "f1", "parsed one folder");
	s.check(found[0]?.createdTime === Date.parse("2026-01-02T03:04:05.000Z"), "parsed creation time");
	const url = new URL(requests[0]?.url ?? "");
	const q = url.searchParams.get("q") ?? "";
	s.check(q.includes("name='Bob\\'s \\\\ vault'"), `quote and backslash escaped (${q})`);
	s.check(q.includes("mimeType='application/vnd.google-apps.folder'") && q.includes("trashed=false"), "folder mime and not trashed");
	s.check(requests[0]?.headers.Authorization === "Bearer token", "bearer token sent");
	s.check(!url.toString().includes("drive.appdata"), "no extra scope is involved");
}

s.section("Test 2: listFiles follows pages");
{
	const { api, requests } = makeApi((req) => {
		const page = new URL(req.url).searchParams.get("pageToken");
		return page === "p2"
			? json(200, { files: [{ id: "c", name: "c.ydu", size: "30" }] })
			: json(200, { nextPageToken: "p2", files: [{ id: "a", name: "a.ydu", size: "10" }, { id: "b", name: "b.ydu", size: "20" }] });
	});
	const files = await api.listFiles("folder-1");
	s.check(files.map((f) => f.name).join() === "a.ydu,b.ydu,c.ydu", "all pages collected");
	s.check(files.map((f) => f.size).join() === "10,20,30", "string sizes parsed to numbers");
	s.check(requests.length === 2, "exactly two requests");
	s.check((new URL(requests[0]?.url ?? "").searchParams.get("q") ?? "").includes("'folder-1' in parents"), "scoped to the folder");
}

s.section("Test 3: createFile sends multipart with name, parent and exact bytes");
{
	const data = new Uint8Array([0, 1, 2, 255, 254, 13, 10, 13, 10]);
	const { api, requests } = makeApi(() => json(200, { id: "n1", name: "seg.ydu", size: String(data.length) }));
	const info = await api.createFile("folder-1", "seg.ydu", data);
	s.check(info.id === "n1" && info.size === data.length, "response parsed");
	const req = requests[0];
	s.check(req?.method === "POST" && (req.url.startsWith("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart")), "multipart upload endpoint");
	const type = req?.headers["Content-Type"] ?? "";
	const boundary = type.split("boundary=")[1] ?? "";
	s.check(type.startsWith("multipart/related") && boundary.length > 5, "multipart content type with boundary");
	const body = req?.body;
	s.check(body instanceof Uint8Array, "body is bytes");
	if (body instanceof Uint8Array) {
		const text = dec.decode(body);
		s.check(text.includes('"name":"seg.ydu"') && text.includes('"parents":["folder-1"]'), "metadata part has name and parent");
		const tail = enc.encode(`\r\n--${boundary}--`);
		const end = body.length - tail.length;
		s.check(Array.from(body.slice(end - data.length, end)).join() === Array.from(data).join(), "payload bytes are intact (including CRLF bytes)");
	}
}

s.section("Test 4: readFile and deleteFile");
{
	const { api, requests } = makeApi((req) => req.method === "DELETE" ? { status: 204, body: new Uint8Array(0) } : { status: 200, body: new Uint8Array([5, 6, 7]) });
	const bytes = await api.readFile("fid");
	s.check(Array.from(bytes).join() === "5,6,7", "bytes returned untouched");
	s.check(requests[0]?.url.endsWith("/files/fid?alt=media") === true, "alt=media download URL");
	await api.deleteFile("fid");
	s.check(requests[1]?.method === "DELETE", "DELETE sent");
}

s.section("Test 5: a 401 retries once with a fresh token");
{
	const { api, requests, tokens } = makeApi((req) => req.headers.Authorization === "Bearer fresh-token" ? json(200, { files: [] }) : json(401, { error: "expired" }));
	const found = await api.findFolders("v");
	s.check(found.length === 0, "request succeeded after refresh");
	s.check(requests.length === 2, "retried exactly once");
	s.check(tokens.length === 2 && tokens[1] === true, "second attempt forced a token refresh");
}

s.section("Test 6: errors carry the status and say whether to retry");
{
	const cases: [number, boolean][] = [[429, true], [500, true], [503, true], [403, false], [404, false], [400, false]];
	for (const [status, retryable] of cases) {
		const { api } = makeApi(() => json(status, { error: "x" }));
		try {
			await api.listFiles("f");
			s.check(false, `status ${status} should throw`);
		} catch (err) {
			s.check(err instanceof DriveError && err.status === status && err.retryable === retryable, `status ${status} -> retryable=${retryable}`);
		}
	}
	const { api: netApi } = makeApi(() => { throw new Error("socket hang up"); });
	try {
		await netApi.listFiles("f");
		s.check(false, "network failure should throw");
	} catch (err) {
		s.check(err instanceof DriveError && err.status === 0 && err.retryable, "network failure -> status 0, retryable");
	}
	const failingToken = new GoogleDriveRest(() => Promise.resolve({ status: 200, body: new Uint8Array(0) }), () => Promise.reject(new Error("refresh denied")));
	try {
		await failingToken.listFiles("f");
		s.check(false, "token failure should throw");
	} catch (err) {
		s.check(err instanceof DriveError && err.status === 401 && !err.retryable, "token failure -> 401 (not retryable)");
	}
}

s.section("Test 7: malformed responses are errors, not crashes");
{
	const { api } = makeApi(() => ({ status: 200, body: enc.encode("<html>") }));
	try {
		await api.listFiles("f");
		s.check(false, "non-JSON body should throw");
	} catch (err) {
		s.check(err instanceof DriveError && err.status === 502, "non-JSON body -> DriveError 502");
	}
	const { api: api2 } = makeApi(() => json(200, { files: [{ name: "no-id" }] }));
	try {
		await api2.listFiles("f");
		s.check(false, "file without id should throw");
	} catch (err) {
		s.check(err instanceof DriveError && err.status === 502, "file without id -> DriveError 502");
	}
}

await s.done();

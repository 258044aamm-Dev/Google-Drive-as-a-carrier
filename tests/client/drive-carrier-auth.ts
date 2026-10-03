/**
 * Drive carrier: Google device sign-in and access-token handling,
 * against a scripted HTTP double (no network).
 */

import {
	GOOGLE_DEVICE_CODE_URL,
	GOOGLE_TOKEN_URL,
	GoogleAuthError,
	GoogleTokenManager,
	pollForDeviceSignIn,
	requestDeviceCode,
	type DeviceCodeInfo,
} from "../../src/drive-carrier/googleAuth";
import type { DriveHttp, DriveHttpRequest, DriveHttpResponse } from "../../src/drive-carrier/googleDriveRest";
import { signInWithGoogle } from "../../src/drive-carrier/signIn";
import { suite } from "../harness.ts";

const s = suite("drive-carrier-auth");
const enc = new TextEncoder();
const client = { clientId: "cid", clientSecret: "secret" };

function reply(status: number, body: unknown): DriveHttpResponse {
	return { status, body: typeof body === "string" ? enc.encode(body) : enc.encode(JSON.stringify(body)) };
}

function script(handler: (req: DriveHttpRequest, n: number) => DriveHttpResponse | Promise<DriveHttpResponse>) {
	const requests: DriveHttpRequest[] = [];
	const http: DriveHttp = async (req) => {
		requests.push(req);
		return handler(req, requests.length);
	};
	return { http, requests };
}

function formOf(req: DriveHttpRequest): URLSearchParams {
	return new URLSearchParams(typeof req.body === "string" ? req.body : "");
}

const CODE: DeviceCodeInfo = {
	deviceCode: "dev-code",
	userCode: "ABCD-EFGH",
	verificationUrl: "https://www.google.com/device",
	expiresInSeconds: 600,
	intervalSeconds: 5,
};

async function throws(run: () => Promise<unknown>): Promise<unknown> {
	try {
		await run();
	} catch (err) {
		return err;
	}
	return null;
}

s.section("Test 1: asking for a sign-in code");
{
	const { http, requests } = script(() => reply(200, {
		device_code: "d", user_code: "U-1", verification_url: "https://www.google.com/device", expires_in: 1800, interval: 5,
	}));
	const info = await requestDeviceCode(http, " cid ");
	s.check(requests.length === 1 && requests[0]?.url === GOOGLE_DEVICE_CODE_URL && requests[0]?.method === "POST", "one POST to the device-code endpoint");
	const f = formOf(requests[0]!);
	s.check(f.get("client_id") === "cid", "client id sent (trimmed)");
	s.check(f.get("scope") === "https://www.googleapis.com/auth/drive.file", "only the drive.file scope is requested");
	s.check(requests[0]?.headers["Content-Type"] === "application/x-www-form-urlencoded", "form content type");
	s.check(info.deviceCode === "d" && info.userCode === "U-1" && info.intervalSeconds === 5 && info.expiresInSeconds === 1800, "reply parsed");
}
{
	const { http } = script(() => reply(200, { device_code: "d", user_code: "U", verification_uri: "https://example/alt" }));
	const info = await requestDeviceCode(http, "cid");
	s.check(info.verificationUrl === "https://example/alt" && info.intervalSeconds === 5 && info.expiresInSeconds === 1800, "verification_uri accepted; defaults filled in");
}
{
	const { http } = script(() => reply(401, { error: "invalid_client", error_description: "The OAuth client was not found." }));
	const err = await throws(() => requestDeviceCode(http, "cid"));
	s.check(err instanceof GoogleAuthError && err.message.includes("invalid_client") && !err.needsSignIn, "Google's refusal is reported with its reason");
	const { http: html } = script(() => reply(502, "<html>bad gateway</html>"));
	const err2 = await throws(() => requestDeviceCode(html, "cid"));
	s.check(err2 instanceof GoogleAuthError && err2.message.includes("502"), "a non-JSON error page is reported by status");
	const { http: none, requests } = script(() => reply(200, {}));
	const err3 = await throws(() => requestDeviceCode(none, "  "));
	s.check(err3 instanceof GoogleAuthError && err3.code === "missing_client" && requests.length === 0, "no client id: refused without any request");
}

s.section("Test 2: waiting for approval");
{
	const sleeps: number[] = [];
	const { http, requests } = script((_req, n) => n < 3
		? reply(428, { error: "authorization_pending" })
		: reply(200, { access_token: "at", refresh_token: "rt", expires_in: 3599 }));
	const result = await pollForDeviceSignIn(http, client, CODE, { sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); } });
	s.check(result.refreshToken === "rt" && result.accessToken === "at" && result.expiresInSeconds === 3599, "tokens returned once approved");
	s.check(requests.length === 3 && sleeps.join() === "5000,5000,5000", `kept polling at the interval (${sleeps.join()})`);
	const f = formOf(requests[0]!);
	s.check(requests[0]?.url === GOOGLE_TOKEN_URL, "polls the token endpoint");
	s.check(f.get("client_id") === "cid" && f.get("client_secret") === "secret" && f.get("device_code") === "dev-code", "client and device code sent");
	s.check(f.get("grant_type") === "urn:ietf:params:oauth:grant-type:device_code", "device grant type");
}
{
	const sleeps: number[] = [];
	const { http } = script((_req, n) => n === 1 ? reply(403, { error: "slow_down" }) : n === 2 ? reply(428, { error: "authorization_pending" }) : reply(200, { access_token: "a", refresh_token: "r" }));
	await pollForDeviceSignIn(http, client, CODE, { sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); } });
	s.check(sleeps.join() === "5000,10000,10000", `slow_down adds 5 s for the rest of the wait (${sleeps.join()})`);
}
for (const [error, status, needle] of [["access_denied", 403, "declined"], ["expired_token", 400, "expired"]] as const) {
	const { http } = script(() => reply(status, { error }));
	const err = await throws(() => pollForDeviceSignIn(http, client, CODE, { sleep: () => Promise.resolve() }));
	s.check(err instanceof GoogleAuthError && err.code === error && err.message.toLowerCase().includes(needle), `${error} stops with a clear message`);
}
{
	const { http } = script(() => reply(400, { error: "invalid_client", error_description: "bad secret" }));
	const err = await throws(() => pollForDeviceSignIn(http, client, CODE, { sleep: () => Promise.resolve() }));
	s.check(err instanceof GoogleAuthError && err.message.includes("bad secret"), "an unknown error stops and shows Google's description");
}
{
	const { http } = script(() => reply(200, { access_token: "a" }));
	const err = await throws(() => pollForDeviceSignIn(http, client, CODE, { sleep: () => Promise.resolve() }));
	s.check(err instanceof GoogleAuthError && err.code === "no_refresh_token", "approval without a refresh token is an error, not a half sign-in");
}
{
	let now = 1_000_000;
	const { http, requests } = script(() => reply(428, { error: "authorization_pending" }));
	const err = await throws(() => pollForDeviceSignIn(http, client, { ...CODE, expiresInSeconds: 20 }, {
		sleep: (ms) => { now += ms; return Promise.resolve(); },
		now: () => now,
	}));
	s.check(err instanceof GoogleAuthError && err.code === "expired_token" && requests.length === 4, `gives up after the code's lifetime (${requests.length} polls)`);
}
{
	let cancelled = false;
	const { http, requests } = script(() => reply(428, { error: "authorization_pending" }));
	const err = await throws(() => pollForDeviceSignIn(http, client, CODE, {
		sleep: () => { cancelled = true; return Promise.resolve(); },
		isCancelled: () => cancelled,
	}));
	s.check(err instanceof GoogleAuthError && err.code === "cancelled" && requests.length === 0, "closing the window stops polling before another request");
}

s.section("Test 3: the whole sign-in");
{
	const shown: string[] = [];
	const { http } = script((req, n) => req.url === GOOGLE_DEVICE_CODE_URL
		? reply(200, { device_code: "d", user_code: "WXYZ", verification_url: "https://www.google.com/device", expires_in: 600, interval: 5 })
		: n < 3 ? reply(428, { error: "authorization_pending" }) : reply(200, { access_token: "a", refresh_token: "r" }));
	const result = await signInWithGoogle(client, { showCode: (i) => shown.push(i.userCode), isCancelled: () => false }, { http, sleep: () => Promise.resolve() });
	s.check(shown.join() === "WXYZ" && result.refreshToken === "r", "code shown, then refresh token returned");
	const { http: h2, requests } = script(() => reply(200, {}));
	const err = await throws(() => signInWithGoogle({ clientId: "cid", clientSecret: " " }, { showCode: () => undefined, isCancelled: () => false }, { http: h2, sleep: () => Promise.resolve() }));
	s.check(err instanceof GoogleAuthError && err.code === "missing_client" && requests.length === 0, "missing secret: refused without any request");
}

s.section("Test 4: access tokens");
{
	let now = 5_000_000;
	const { http, requests } = script((_req, n) => reply(200, { access_token: `at${n}`, expires_in: 3600 }));
	const tm = new GoogleTokenManager(http, client, "refresh-1", () => now);
	s.check(await tm.provider() === "at1", "first call refreshes");
	const f = formOf(requests[0]!);
	s.check(f.get("grant_type") === "refresh_token" && f.get("refresh_token") === "refresh-1" && f.get("client_secret") === "secret", "refresh request is well formed");
	s.check(await tm.provider() === "at1" && requests.length === 1, "token is cached");
	now += 3600_000 - 30_000;
	s.check(await tm.provider() === "at2" && requests.length === 2, "refreshed shortly before expiry");
	s.check(await tm.provider(true) === "at3", "forceRefresh skips the cache");
}
{
	const { http, requests } = script(async (_req, n) => {
		await Promise.resolve();
		return reply(200, { access_token: `at${n}`, expires_in: 3600 });
	});
	const tm = new GoogleTokenManager(http, client, "r");
	const all = await Promise.all([tm.provider(), tm.provider(), tm.provider(true)]);
	s.check(requests.length === 1 && all.every((t) => t === "at1"), "simultaneous requests share one refresh");
	await tm.provider(true);
	s.check(requests.length === 2, "and the next one can refresh again");
}
{
	let lost = 0;
	const { http, requests } = script(() => reply(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." }));
	const tm = new GoogleTokenManager(http, client, "r", undefined, () => { lost++; });
	const err = await throws(() => tm.provider());
	s.check(err instanceof GoogleAuthError && err.needsSignIn && err.code === "invalid_grant", "revoked access asks for a new sign-in");
	s.check(lost === 1 && tm.revoked, "the owner is told once");
	const err2 = await throws(() => tm.provider());
	s.check(err2 instanceof GoogleAuthError && err2.needsSignIn && requests.length === 1 && lost === 1, "afterwards it fails fast without more requests");
}
{
	let phase = 0;
	const { http } = script(() => phase === 0 ? reply(503, "unavailable") : reply(200, { access_token: "ok", expires_in: 3600 }));
	const tm = new GoogleTokenManager(http, client, "r");
	const err = await throws(() => tm.provider());
	s.check(err instanceof GoogleAuthError && !err.needsSignIn && !tm.revoked, "a temporary failure is not treated as revoked");
	phase = 1;
	s.check(await tm.provider() === "ok", "and the next try works");
	const { http: net } = script(() => { throw new Error("offline"); });
	const err2 = await throws(() => new GoogleTokenManager(net, client, "r").provider());
	s.check(err2 instanceof Error && err2.message === "offline", "network failures pass through (the transport backs off)");
}

await s.done();

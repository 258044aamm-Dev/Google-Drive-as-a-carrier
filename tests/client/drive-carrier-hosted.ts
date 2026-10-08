/**
 * Easy sign-in: the token service client, how the carrier picks its token
 * source, and the proof that the normal Google sign-in is left alone.
 */

import { GoogleAuthError, GoogleTokenManager, GOOGLE_TOKEN_URL } from "../../src/drive-carrier/googleAuth";
import { HOSTED_TOKEN_URL, HOSTED_SIGNIN_URL, HostedTokenManager, HostedAuthError, resolveHostedTokenUrl } from "../../src/drive-carrier/hostedAuth";
import { isDriveSignedIn, isHostedSignIn, type DriveCarrierSettings } from "../../src/drive-carrier/carrierSettings";
import { createDriveCarrier } from "../../src/drive-carrier/driveCarrierRuntime";
import type { DriveHttp, DriveHttpRequest } from "../../src/drive-carrier/googleDriveRest";
import { decodeSetupCode, encodeSetupCode, HOSTED_SETUP_CODE_PREFIX, SETUP_CODE_PREFIX } from "../../src/drive-carrier/wizard/setupCode";
import { checkHostedToken, normalizeHostedToken } from "../../src/drive-carrier/wizard/validate";
import { explainHostedSignInError, explainSetupError } from "../../src/drive-carrier/wizard/explainError";
import { suite } from "../harness.ts";

const s = suite("drive-carrier-hosted");
const enc = new TextEncoder();
const HASH = "a".repeat(64);
const TOKEN = "1//0gHostedRefreshTokenForTests-0123456789";

interface Reply { status: number; json?: unknown; raw?: string }

function fakeHttp(handler: (req: DriveHttpRequest, n: number) => Reply | "network"): { http: DriveHttp; calls: DriveHttpRequest[] } {
	const calls: DriveHttpRequest[] = [];
	const http: DriveHttp = async (req) => {
		calls.push(req);
		const reply = handler(req, calls.length);
		if (reply === "network") throw new Error("network down");
		const text = reply.raw ?? JSON.stringify(reply.json ?? {});
		return { status: reply.status, body: enc.encode(text) };
	};
	return { http, calls };
}

async function failure(run: () => Promise<unknown>): Promise<GoogleAuthError | null> {
	try { await run(); } catch (e) { return e instanceof GoogleAuthError ? e : null; }
	return null;
}

s.section("Test 1: the service address and the sign-in page");
{
	s.check(HOSTED_TOKEN_URL === "https://ogd-server.richardxiong.com/api/access", "the same token address the Obsidian Google Drive plugin uses");
	s.check(HOSTED_SIGNIN_URL === "https://ogd.richardxiong.com", "and the same sign-in page");
}

s.section("Test 2: getting and reusing an access token");
{
	let now = 1_000_000;
	const { http, calls } = fakeHttp(() => ({ status: 200, json: { access_token: "acc-1", expires_in: 3600 } }));
	const tm = new HostedTokenManager(http, HOSTED_TOKEN_URL, TOKEN, () => now);
	s.check(await tm.provider() === "acc-1" && calls.length === 1, "the first request fetches a token");
	const req = calls[0];
	const body = JSON.parse(String(req?.body)) as Record<string, unknown>;
	s.check(req?.url === HOSTED_TOKEN_URL && req.method === "POST" && req.headers["Content-Type"] === "application/json", "a JSON POST to the service");
	s.check(body.refresh_token === TOKEN && body.clientId === "" && body.clientSecret === "" && Object.keys(body).length === 3, "with exactly the body the plugin sends: the token and empty client details");
	s.check(await tm.provider() === "acc-1" && calls.length === 1, "the token is reused while it is fresh");
	now += 3600_000 - 30_000;
	await tm.provider();
	s.check(calls.length === 2, "and renewed shortly before it expires");
	await tm.provider(true);
	s.check(calls.length === 3, "a forced refresh always asks again");
	const many = fakeHttp(() => ({ status: 200, json: { access_token: "x", expires_in: 3600 } }));
	const shared = new HostedTokenManager(many.http, HOSTED_TOKEN_URL, TOKEN);
	await Promise.all([shared.provider(), shared.provider(), shared.provider()]);
	s.check(many.calls.length === 1, "simultaneous requests share one refresh");
	const noExpiry = fakeHttp(() => ({ status: 200, json: { access_token: "y" } }));
	const defaulted = new HostedTokenManager(noExpiry.http, HOSTED_TOKEN_URL, TOKEN, () => now);
	await defaulted.provider();
	await defaulted.provider();
	s.check(noExpiry.calls.length === 1, "a missing expiry counts as one hour");
}

s.section("Test 3: when the service says no");
{
	let lost = 0;
	const { http, calls } = fakeHttp(() => ({ status: 400, json: { error: "invalid_grant", error_description: "Bad Request" } }));
	const tm = new HostedTokenManager(http, HOSTED_TOKEN_URL, TOKEN, undefined, () => { lost++; });
	const err = await failure(() => tm.provider());
	s.check(err?.code === "invalid_grant" && err.needsSignIn && tm.revoked && lost === 1, "explicit invalid_grant means sign in again, reported once");
	const again = await failure(() => tm.provider());
	s.check(again?.code === "invalid_grant" && calls.length === 1 && lost === 1, "afterwards no more requests are sent");
	for (const status of [401, 403]) {
		const t = new HostedTokenManager(fakeHttp(() => ({ status, json: { error: "invalid_grant" } })).http, HOSTED_TOKEN_URL, TOKEN);
		const e = await failure(() => t.provider());
		s.check(e?.needsSignIn === true && t.revoked, `${status} with explicit invalid_grant is treated the same way`);
	}
	const temp = fakeHttp((_r, n) => (n === 1 ? { status: 503, raw: "<html>bad gateway</html>" } : { status: 200, json: { access_token: "ok", expires_in: 3600 } }));
	const t2 = new HostedTokenManager(temp.http, HOSTED_TOKEN_URL, TOKEN);
	const e2 = await failure(() => t2.provider());
	s.check(e2?.code === "http_503" && !e2.needsSignIn && !t2.revoked, "a server error is temporary and does not sign the user out");
	s.check(await t2.provider() === "ok", "and the next attempt can succeed");
	const t3 = new HostedTokenManager(fakeHttp(() => "network").http, HOSTED_TOKEN_URL, TOKEN);
	const e3 = await failure(() => t3.provider());
	s.check(e3?.code === "network" && !e3.needsSignIn && !t3.revoked, "no connection is temporary too");
	const t4 = new HostedTokenManager(fakeHttp(() => ({ status: 200, json: { nothing: true } })).http, HOSTED_TOKEN_URL, TOKEN);
	const e4 = await failure(() => t4.provider());
	s.check(e4?.code === "http_200" && !t4.revoked, "a success without an access token is not accepted");
}

s.section("Test 4: signed-in rule for each way of signing in");
{
	const classic: DriveCarrierSettings = { driveClientId: "i", driveClientSecret: "x", driveRefreshToken: "r" };
	s.check(isDriveSignedIn(classic) && !isHostedSignIn(classic), "the normal way still needs client ID, secret and token");
	s.check(!isDriveSignedIn({ driveRefreshToken: "r" }), "a token alone is not enough for the normal way");
	s.check(!isDriveSignedIn({ driveClientId: "i", driveClientSecret: "x" }), "client details alone are not enough");
	s.check(!isDriveSignedIn({}), "nothing set: not signed in");
	s.check(isDriveSignedIn({ driveAuthMode: "hosted", driveRefreshToken: "r" }) && isHostedSignIn({ driveAuthMode: "hosted" }), "the easy sign-in needs only the token");
	s.check(!isDriveSignedIn({ driveAuthMode: "hosted" }), "and the token must be there");
	s.check(!isHostedSignIn({ driveAuthMode: undefined }), "absent means the normal way");
}

s.section("Test 5: the carrier picks the right token source");
{
	function driveReply(req: DriveHttpRequest): Reply {
		if (req.url.startsWith("https://www.googleapis.com/")) return { status: 200, json: { files: [] } };
		return { status: 200, json: { access_token: `token-from-${req.url}`, expires_in: 3600 } };
	}
	const hostedHttp = fakeHttp(driveReply);
	const hosted = createDriveCarrier({
		getSettings: () => ({ driveAuthMode: "hosted", driveRefreshToken: TOKEN, driveDeviceId: "dev" }),
		http: hostedHttp.http, log: () => undefined, onSignInLost: () => undefined,
	});
	await hosted.blobStore("vault-1").exists([HASH]).catch(() => []);
	const tokenCalls = hostedHttp.calls.filter((c) => !c.url.startsWith("https://www.googleapis.com/"));
	s.check(tokenCalls.length === 1 && tokenCalls[0]?.url === HOSTED_TOKEN_URL, "easy sign-in: the token comes from the service");
	const driveCalls = hostedHttp.calls.filter((c) => c.url.startsWith("https://www.googleapis.com/"));
	s.check(driveCalls.length >= 1 && driveCalls.every((c) => c.headers.Authorization === `Bearer token-from-${HOSTED_TOKEN_URL}`), "and Drive is called directly with that token");
	s.check(!hostedHttp.calls.some((c) => c.url === GOOGLE_TOKEN_URL), "Google's token address is not used");

	const custom = fakeHttp(driveReply);
	const customCarrier = createDriveCarrier({
		getSettings: () => ({ driveAuthMode: "hosted", driveRefreshToken: TOKEN, driveHostedUrl: "https://my-own-host.example/api/access " }),
		http: custom.http, log: () => undefined, onSignInLost: () => undefined,
	});
	await customCarrier.blobStore("vault-1").exists([HASH]).catch(() => []);
	s.check(custom.calls[0]?.url === "https://my-own-host.example/api/access", "a custom service address (self-hosting) is honoured");

	const classicHttp = fakeHttp(driveReply);
	const classic = createDriveCarrier({
		getSettings: () => ({ driveClientId: "id", driveClientSecret: "secret", driveRefreshToken: "r", driveDeviceId: "dev", driveHostedUrl: "https://ignored.example/" }),
		http: classicHttp.http, log: () => undefined, onSignInLost: () => undefined,
	});
	await classic.blobStore("vault-1").exists([HASH]).catch(() => []);
	const first = classicHttp.calls[0];
	s.check(first?.url === GOOGLE_TOKEN_URL && String(first.body).includes("client_id=id"), "without the easy marker: Google's own token request with the client details, as before");
	s.check(!classicHttp.calls.some((c) => c.url === HOSTED_TOKEN_URL || c.url.includes("ignored.example")), "and the hosted service is never contacted");
	const direct = new GoogleTokenManager(classicHttp.http, { clientId: "id", clientSecret: "secret" }, "r");
	s.check(typeof direct.provider === "function", "the Google token manager is unchanged");
}

s.section("Test 6: setup codes, both kinds");
{
	const classic = encodeSetupCode({ vaultId: "vaultAAAAAAAA", clientId: "1-a.apps.googleusercontent.com", clientSecret: "GOCSPX-secret0123", bundledClient: false, passphrase: "pw pw pw pw", encrypted: true });
	s.check(classic.startsWith(SETUP_CODE_PREFIX), "a normal code still starts with YAOS-DRIVE1:");
	const c1 = decodeSetupCode(classic);
	s.check(c1.ok && c1.content.clientId === "1-a.apps.googleusercontent.com" && c1.content.hosted !== true, "and reads back as before");

	const hosted = encodeSetupCode({ vaultId: "vaultAAAAAAAA", clientId: "", clientSecret: "", bundledClient: false, hosted: true, passphrase: "pw pw pw pw", encrypted: true });
	s.check(hosted.startsWith(HOSTED_SETUP_CODE_PREFIX), "an easy-sign-in code starts with YAOS-DRIVE2:");
	const h1 = decodeSetupCode(hosted);
	s.check(h1.ok && h1.content.hosted === true && h1.content.vaultId === "vaultAAAAAAAA" && h1.content.passphrase === "pw pw pw pw" && h1.content.encrypted, "it carries the vault and the passphrase");
	s.check(h1.ok && h1.content.clientId === "" && h1.content.clientSecret === "", "and no client details");
	const lean = decodeSetupCode(encodeSetupCode({ vaultId: "vaultAAAAAAAA", clientId: "", clientSecret: "", bundledClient: false, hosted: true, passphrase: "", encrypted: true }));
	s.check(lean.ok && lean.content.passphrase === "" && lean.content.encrypted, "without the passphrase it still says the vault is encrypted");
	const plain = decodeSetupCode(encodeSetupCode({ vaultId: "vaultAAAAAAAA", clientId: "", clientSecret: "", bundledClient: false, hosted: true, passphrase: "", encrypted: false }));
	s.check(plain.ok && !plain.content.encrypted, "and an unencrypted vault says so");
	const spaced = decodeSetupCode(`  ${hosted.slice(0, 20)}\n${hosted.slice(20)}  `);
	s.check(spaced.ok, "line breaks and spaces from copying are ignored");
	const damaged = decodeSetupCode(`${hosted.slice(0, 30)}X${hosted.slice(31)}`);
	s.check(!damaged.ok && damaged.reason === "damaged", "a changed letter is detected");
	const cut = decodeSetupCode(hosted.slice(0, hosted.length - 12));
	s.check(!cut.ok && cut.reason === "damaged", "a cut-off code is detected");
	s.check(!JSON.stringify(h1).includes(TOKEN), "no sign-in code anywhere");
	const wrongTag = hosted.replace("YAOS-DRIVE2:", "YAOS-DRIVE1:");
	const wt = decodeSetupCode(wrongTag);
	s.check(!wt.ok, "a code with the wrong tag is refused, not guessed at");
	const future = decodeSetupCode("YAOS-DRIVE3:abc.00000000");
	s.check(!future.ok && future.reason === "newer-version", "a future version is named as such");
}

s.section("Test 7: checking what the user pastes");
{
	s.check(checkHostedToken(TOKEN) === null, "a normal code is fine");
	s.check(normalizeHostedToken(`  "${TOKEN}"  `) === TOKEN && normalizeHostedToken(`'${TOKEN}'`) === TOKEN, "quotes and spaces are removed");
	s.check(checkHostedToken("") !== null && checkHostedToken("   ") !== null, "empty is refused");
	s.check(String(checkHostedToken("https://ogd.richardxiong.com")).includes("web address"), "a web address is refused with a hint");
	s.check(String(checkHostedToken("YAOS-DRIVE1:abcdefghij.12345678")).includes("setup code"), "a setup code in the wrong place is recognised");
	s.check(String(checkHostedToken("abc")).includes("too short"), "too short is refused");
	s.check(String(checkHostedToken(`${TOKEN}\n${TOKEN}`)).includes("no spaces"), "two lines are refused");
	s.check(explainHostedSignInError(new GoogleAuthError("x", "invalid_grant", true)).includes("did not accept"), "a rejected code is explained");
	s.check(explainHostedSignInError(new GoogleAuthError("x", "network", false)).includes("No connection"), "no connection is explained");
	s.check(explainHostedSignInError(new GoogleAuthError("x", "http_502", false)).includes("temporary"), "a server problem is called temporary");
	s.check(explainHostedSignInError(new Error("odd")) === "odd", "anything else keeps its own words");
}

s.section("Test 8: service failures never falsely revoke or leak credentials");
{
	const cases: { reply: Reply; code: string; kind: string; hint: string }[] = [
		{ reply: { status: 400, json: { error: "invalid_client", error_description: TOKEN } }, code: "invalid_client", kind: "oauth-json", hint: "configuration problem" },
		{ reply: { status: 401, json: { error: "unauthorized_client" } }, code: "unauthorized_client", kind: "oauth-json", hint: "configuration problem" },
		{ reply: { status: 400, json: { error: "invalid_request" } }, code: "invalid_request", kind: "oauth-json", hint: "does not confirm" },
		{ reply: { status: 403, raw: `<html>Access denied ${TOKEN}</html>` }, code: "http_403", kind: "non-json", hint: "does not confirm" },
		{ reply: { status: 400, json: { error: TOKEN } }, code: "http_400", kind: "other-json", hint: "does not confirm" },
		{ reply: { status: 401, json: {} }, code: "http_401", kind: "other-json", hint: "does not confirm" },
		{ reply: { status: 429, json: { error: "invalid_grant" } }, code: "http_429", kind: "oauth-json", hint: "rate limiting" },
		{ reply: { status: 503, json: { error: "invalid_grant" } }, code: "http_503", kind: "oauth-json", hint: "temporary problem" },
		{ reply: { status: 200, json: { error: "invalid_grant" } }, code: "http_200", kind: "oauth-json", hint: "unexpected response" },
		{ reply: { status: 200, json: { access_token: "   " } }, code: "http_200", kind: "other-json", hint: "unexpected response" },
		{ reply: { status: 200, json: { access_token: "unused", error: "invalid_client" } }, code: "http_200", kind: "oauth-json", hint: "unexpected response" },
		{ reply: { status: 200, raw: "not json" }, code: "http_200", kind: "non-json", hint: "unexpected response" },
		{ reply: { status: 403, json: ["invalid_grant"] }, code: "http_403", kind: "other-json", hint: "does not confirm" },
		{ reply: { status: 400, json: null }, code: "http_400", kind: "other-json", hint: "does not confirm" },
	];
	for (const { reply, code, kind, hint } of cases) {
		let lost = 0;
		const { http, calls } = fakeHttp((_req, n) => n === 1 ? reply : { status: 200, json: { access_token: "recovered" } });
		const manager = new HostedTokenManager(http, HOSTED_TOKEN_URL, TOKEN, undefined, () => { lost++; });
		const err = await failure(() => manager.provider());
		s.check(err instanceof HostedAuthError && err.code === code && err.status === reply.status && err.responseKind === kind, `safe classification: ${reply.status} ${code} ${kind}`);
		s.check(!manager.revoked && lost === 0 && err?.needsSignIn === false, "service failure preserves sign-in");
		const text = explainHostedSignInError(err);
		s.check(text.includes(hint) && text.includes(`HTTP ${reply.status}`), "actionable message keeps safe status");
		s.check(!JSON.stringify(err).includes(TOKEN) && !String(err).includes(TOKEN) && !text.includes(TOKEN), "raw errors and UI never expose echoed token");
		s.check(explainSetupError(err) === text, "vault setup uses hosted guidance, not private-client guidance");
		s.check(await manager.provider() === "recovered" && calls.length === 2, "same manager can recover without another sign-in");
	}
	const { http } = fakeHttp((_req, n) => n === 1
		? { status: 200, json: { access_token: "cached" } }
		: n === 2 ? { status: 403, raw: "blocked" } : { status: 200, json: { access_token: "fresh" } });
	const manager = new HostedTokenManager(http, HOSTED_TOKEN_URL, TOKEN);
	await manager.provider();
	await failure(() => manager.provider(true));
	s.check(await manager.provider() === "fresh", "failed forced refresh clears cached access and permits recovery");
	s.check(resolveHostedTokenUrl(undefined) === HOSTED_TOKEN_URL && resolveHostedTokenUrl("  ") === HOSTED_TOKEN_URL, "missing or blank endpoint uses default");
	s.check(resolveHostedTokenUrl(" https://custom.test/access ") === "https://custom.test/access", "custom endpoint is trimmed without fallback to another domain");
}

await s.done();

import type { AccessTokenProvider, DriveHttp } from "./googleDriveRest";

/**
 * Google sign-in for the Drive carrier, using the OAuth "device" flow:
 * the user is shown a short code, enters it on google.com/device, and this
 * code polls until Google hands back a refresh token. There is no redirect
 * URL, no local web server and no third-party server in the loop: the tokens
 * only ever travel between this device and Google.
 *
 * The only scope requested is `drive.file`, which lets the plugin see just the
 * files it created itself, never the rest of the user's Drive.
 */

export const GOOGLE_DEVICE_CODE_URL = "https://oauth2.googleapis.com/device/code";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
/** Refresh a little early so a token never expires in the middle of a request. */
const EXPIRY_MARGIN_MS = 60_000;

export interface GoogleClient {
	clientId: string;
	clientSecret: string;
}

export interface DeviceCodeInfo {
	deviceCode: string;
	userCode: string;
	verificationUrl: string;
	expiresInSeconds: number;
	intervalSeconds: number;
}

export interface DeviceSignInResult {
	refreshToken: string;
	accessToken: string;
	expiresInSeconds: number;
}

/** The user has to sign in again (token revoked or expired, or the sign-in was refused). Retrying will not help. */
export class GoogleAuthError extends Error {
	constructor(
		message: string,
		readonly code: string,
		/** True when only a new sign-in can fix it. */
		readonly needsSignIn: boolean,
	) {
		super(message);
		this.name = "GoogleAuthError";
	}
}

const decoder = new TextDecoder();

function form(params: Record<string, string>): string {
	return Object.entries(params)
		.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
		.join("&");
}

interface RawReply {
	status: number;
	json: Record<string, unknown>;
}

async function post(http: DriveHttp, url: string, params: Record<string, string>): Promise<RawReply> {
	const res = await http({
		url,
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: form(params),
	});
	let json: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(decoder.decode(res.body));
		if (typeof parsed === "object" && parsed !== null) json = parsed as Record<string, unknown>;
	} catch {
		// Not JSON (a proxy error page, for example): leave json empty and report by status.
	}
	return { status: res.status, json };
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function num(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function describeError(reply: RawReply): string {
	const description = str(reply.json.error_description);
	const code = str(reply.json.error);
	if (description && code) return `${code}: ${description}`;
	return description || code || `HTTP ${reply.status}`;
}

/** Step 1: ask Google for a code the user can type in on another screen. */
export async function requestDeviceCode(http: DriveHttp, clientId: string): Promise<DeviceCodeInfo> {
	if (!clientId.trim()) throw new GoogleAuthError("Enter the Google client ID first.", "missing_client", false);
	const reply = await post(http, GOOGLE_DEVICE_CODE_URL, { client_id: clientId.trim(), scope: DRIVE_FILE_SCOPE });
	const deviceCode = str(reply.json.device_code);
	const userCode = str(reply.json.user_code);
	const verificationUrl = str(reply.json.verification_url) || str(reply.json.verification_uri);
	if (reply.status !== 200 || !deviceCode || !userCode || !verificationUrl) {
		throw new GoogleAuthError(`Google did not give a sign-in code (${describeError(reply)}).`, str(reply.json.error) || "device_code_failed", false);
	}
	return {
		deviceCode,
		userCode,
		verificationUrl,
		expiresInSeconds: num(reply.json.expires_in, 1800),
		intervalSeconds: Math.max(1, num(reply.json.interval, 5)),
	};
}

export interface PollDeps {
	/** Wait for the given number of milliseconds. Injected so tests do not really wait. */
	sleep: (ms: number) => Promise<void>;
	now?: () => number;
	/** Return true to stop waiting (the user closed the sign-in window). */
	isCancelled?: () => boolean;
}

/**
 * Step 2: wait until the user approves on google.com/device. Handles the
 * documented polling answers: still waiting, polling too fast, refused, expired.
 */
export async function pollForDeviceSignIn(
	http: DriveHttp,
	client: GoogleClient,
	code: DeviceCodeInfo,
	deps: PollDeps,
): Promise<DeviceSignInResult> {
	const now = deps.now ?? (() => Date.now());
	const deadline = now() + code.expiresInSeconds * 1000;
	let intervalMs = code.intervalSeconds * 1000;
	for (;;) {
		await deps.sleep(intervalMs);
		if (deps.isCancelled?.()) throw new GoogleAuthError("Sign-in was cancelled.", "cancelled", false);
		if (now() > deadline) throw new GoogleAuthError("The sign-in code expired. Start again.", "expired_token", false);
		const reply = await post(http, GOOGLE_TOKEN_URL, {
			client_id: client.clientId.trim(),
			client_secret: client.clientSecret.trim(),
			device_code: code.deviceCode,
			grant_type: DEVICE_GRANT,
		});
		const accessToken = str(reply.json.access_token);
		if (accessToken) {
			const refreshToken = str(reply.json.refresh_token);
			if (!refreshToken) {
				throw new GoogleAuthError("Google did not return a refresh token. Remove this app from your Google account's connected apps and try again.", "no_refresh_token", false);
			}
			return { refreshToken, accessToken, expiresInSeconds: num(reply.json.expires_in, 3600) };
		}
		const error = str(reply.json.error);
		if (error === "authorization_pending") continue;
		if (error === "slow_down") {
			intervalMs += 5000;
			continue;
		}
		if (error === "access_denied") throw new GoogleAuthError("Google sign-in was declined.", error, false);
		if (error === "expired_token") throw new GoogleAuthError("The sign-in code expired. Start again.", error, false);
		throw new GoogleAuthError(`Google sign-in failed (${describeError(reply)}).`, error || "sign_in_failed", false);
	}
}

/**
 * Keeps a valid access token on hand. The refresh token is the long-lived
 * secret; access tokens last about an hour and are renewed on demand.
 */
export class GoogleTokenManager {
	private accessToken: string | null = null;
	private expiresAt = 0;
	private inflight: Promise<string> | null = null;
	/** Set once Google says the refresh token no longer works; the user must sign in again. */
	revoked = false;

	constructor(
		private readonly http: DriveHttp,
		private readonly client: GoogleClient,
		private readonly refreshToken: string,
		private readonly now: () => number = () => Date.now(),
		private readonly onRevoked: () => void = () => undefined,
	) {}

	/** Use as the `AccessTokenProvider` of GoogleDriveRest. */
	readonly provider: AccessTokenProvider = (forceRefresh = false) => this.get(forceRefresh);

	private get(forceRefresh: boolean): Promise<string> {
		if (this.revoked) {
			return Promise.reject(new GoogleAuthError("Google access was revoked or expired. Sign in again in the YAOS settings.", "invalid_grant", true));
		}
		if (!forceRefresh && this.accessToken && this.now() < this.expiresAt - EXPIRY_MARGIN_MS) {
			return Promise.resolve(this.accessToken);
		}
		// Many requests may ask at once; they share one refresh.
		this.inflight ??= this.refresh().finally(() => { this.inflight = null; });
		return this.inflight;
	}

	private async refresh(): Promise<string> {
		const reply = await post(this.http, GOOGLE_TOKEN_URL, {
			client_id: this.client.clientId.trim(),
			client_secret: this.client.clientSecret.trim(),
			refresh_token: this.refreshToken,
			grant_type: "refresh_token",
		});
		const accessToken = str(reply.json.access_token);
		if (reply.status === 200 && accessToken) {
			this.accessToken = accessToken;
			this.expiresAt = this.now() + num(reply.json.expires_in, 3600) * 1000;
			return accessToken;
		}
		this.accessToken = null;
		const error = str(reply.json.error);
		if (error === "invalid_grant" || error === "invalid_client" || error === "unauthorized_client") {
			this.revoked = true;
			this.onRevoked();
			throw new GoogleAuthError(`Google access was revoked or expired (${describeError(reply)}). Sign in again in the YAOS settings.`, error, true);
		}
		// Anything else (network trouble, 5xx, rate limit) is temporary: the transport backs off and retries.
		throw new GoogleAuthError(`Could not refresh the Google access token (${describeError(reply)}).`, error || `http_${reply.status}`, false);
	}
}

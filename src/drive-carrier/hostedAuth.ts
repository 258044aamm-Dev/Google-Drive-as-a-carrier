import { GoogleAuthError } from "./googleAuth";
import type { AccessTokenProvider, DriveHttp } from "./googleDriveRest";

/**
 * The "easy sign-in": a sign-in page and token service run by the author of
 * the Obsidian Google Drive plugin (source: github.com/RichardX366/Obsidian-Google-Drive-website).
 *
 * The user signs in on that page once and copies a refresh token. This device
 * then sends the token to the service whenever it needs a short-lived access
 * token, because only the service holds the Google client secret. The service
 * never sees the notes: the Drive requests go from this device straight to Google.
 *
 * Nothing in this file runs unless the user chose the easy sign-in.
 */

export const HOSTED_SIGNIN_URL = "https://ogd.richardxiong.com";
export const HOSTED_TOKEN_URL = "https://ogd-server.richardxiong.com/api/access";

/** Shared by setup and runtime; never fall back to a second service after a failure. */
export function resolveHostedTokenUrl(override?: string): string {
	return override?.trim() || HOSTED_TOKEN_URL;
}

type HostedResponseKind = "oauth-json" | "other-json" | "non-json";

/** Only allowlisted codes and response metadata escape the token service boundary. */
export class HostedAuthError extends GoogleAuthError {
	constructor(
		message: string,
		code: string,
		needsSignIn: boolean,
		readonly status: number,
		readonly responseKind: HostedResponseKind,
	) {
		super(message, code, needsSignIn);
		this.name = "HostedAuthError";
	}
}

const OAUTH_ERROR_CODES = new Set([
	"invalid_grant", "invalid_client", "unauthorized_client", "invalid_request",
	"invalid_scope", "access_denied", "temporarily_unavailable", "server_error",
]);

/** Refresh a little early so a token never expires in the middle of a request. */
const EXPIRY_MARGIN_MS = 60_000;
const decoder = new TextDecoder();

/** Same shape as GoogleTokenManager, so the carrier can use either one. */
export class HostedTokenManager {
	private accessToken: string | null = null;
	private expiresAt = 0;
	private inflight: Promise<string> | null = null;
	private rejection: HostedAuthError | null = null;
	/** Set once the service says the token no longer works; the user must sign in again. */
	revoked = false;

	constructor(
		private readonly http: DriveHttp,
		private readonly endpoint: string,
		private readonly refreshToken: string,
		private readonly now: () => number = () => Date.now(),
		private readonly onRevoked: () => void = () => undefined,
	) {}

	/** Use as the `AccessTokenProvider` of GoogleDriveRest. */
	readonly provider: AccessTokenProvider = (forceRefresh = false) => this.get(forceRefresh);

	private get(forceRefresh: boolean): Promise<string> {
		if (this.revoked) {
			return Promise.reject(this.rejection ?? new HostedAuthError("Your sign-in was revoked or has expired. Sign in again in the YAOS settings.", "invalid_grant", true, 401, "oauth-json"));
		}
		if (!forceRefresh && this.accessToken && this.now() < this.expiresAt - EXPIRY_MARGIN_MS) {
			return Promise.resolve(this.accessToken);
		}
		this.inflight ??= this.refresh().finally(() => { this.inflight = null; });
		return this.inflight;
	}

	private async refresh(): Promise<string> {
		let status: number;
		let json: Record<string, unknown> = {};
		let responseKind: HostedResponseKind = "non-json";
		try {
			const res = await this.http({
				url: this.endpoint,
				method: "POST",
				headers: { "Content-Type": "application/json" },
				// Same body the Obsidian Google Drive plugin sends to this service.
				body: JSON.stringify({ refresh_token: this.refreshToken, clientId: "", clientSecret: "" }),
			});
			status = res.status;
			try {
				const parsed: unknown = JSON.parse(decoder.decode(res.body));
				responseKind = "other-json";
				if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
			} catch {
				// Not JSON (a proxy error page, for example): report by status.
			}
		} catch {
			throw new HostedAuthError("No connection to the sign-in service. Check your internet.", "network", false, 0, "non-json");
		}
		const oauthCode = typeof json.error === "string" && OAUTH_ERROR_CODES.has(json.error) ? json.error : "";
		if (oauthCode) responseKind = "oauth-json";
		const accessToken = typeof json.access_token === "string" ? json.access_token : "";
		if (status === 200 && accessToken.trim() && json.error === undefined) {
			this.accessToken = accessToken;
			const expires = typeof json.expires_in === "number" && Number.isFinite(json.expires_in) ? json.expires_in : 3600;
			this.expiresAt = this.now() + expires * 1000;
			return accessToken;
		}
		this.accessToken = null;
		// HTTP status alone is not evidence of revocation: proxies and service
		// configuration errors can also produce 400/401/403. Never echo raw bodies.
		if ([400, 401, 403].includes(status) && oauthCode === "invalid_grant") {
			this.revoked = true;
			this.rejection = new HostedAuthError(`The sign-in service rejected the refresh token (HTTP ${status}).`, "invalid_grant", true, status, responseKind);
			this.onRevoked();
			throw this.rejection;
		}
		const code = [400, 401, 403].includes(status) && oauthCode ? oauthCode : `http_${status}`;
		throw new HostedAuthError(`The sign-in service could not refresh access (HTTP ${status}; ${responseKind}).`, code, false, status, responseKind);
	}
}

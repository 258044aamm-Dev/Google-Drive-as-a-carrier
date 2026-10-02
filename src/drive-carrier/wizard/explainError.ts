import { DriveError } from "../driveApi";
import { GoogleAuthError } from "../googleAuth";
import { FatalCarrierError } from "../driveKeyring";
import { EncryptionError } from "../driveCrypto";

/** Turns what Google or Drive said into a sentence a beginner can act on. */
export function explainSetupError(err: unknown): string {
	if (err instanceof GoogleAuthError) {
		switch (err.code) {
			case "cancelled": return "Sign-in was cancelled.";
			case "missing_client": return err.message;
			case "invalid_client":
				return "Google does not recognise this client ID or client secret. Check that you copied both from the same client, and that its type is \"TVs and Limited Input devices\".";
			case "unauthorized_client":
				return "This Google client is not allowed to use the sign-in code method. Create the client again with the type \"TVs and Limited Input devices\".";
			case "invalid_scope":
			case "invalid_request":
				return "Google refused the request. Make sure the client type is \"TVs and Limited Input devices\".";
			case "access_denied":
				return "Google sign-in was declined. If you were not asked at all, your Google app may still be in \"Testing\": open the Audience page and press Publish app, or add your own Google account under Test users.";
			case "expired_token": return "The sign-in code expired. Press Try again to get a new one.";
			case "no_refresh_token": return err.message;
			case "invalid_grant": return "Google access was revoked or has expired. Sign in again.";
			default: return err.message;
		}
	}
	if (err instanceof FatalCarrierError || err instanceof EncryptionError) return err.message;
	if (err instanceof DriveError) {
		const text = err.message.toLowerCase();
		if (err.status === 0) return "No connection to Google. Check your internet and try again.";
		if (err.status === 401) {
			return "Google did not accept the sign-in. Try again, and if it keeps happening, check that the client is the right type and published.";
		}
		if (err.status === 403) {
			if (text.includes("accessnotconfigured") || text.includes("has not been used") || text.includes("is disabled") || text.includes("api has not been")) {
				return "The Google Drive API is not switched on for your Google project. Open the Drive API page, press Enable, wait a minute, then try again.";
			}
			if (text.includes("storagequota") || text.includes("quota") && text.includes("storage")) {
				return "Your Google Drive is full. Free some space in Google Drive and try again.";
			}
			if (text.includes("ratelimit") || text.includes("rate limit")) return "Google asked us to slow down. Wait a minute and try again.";
			return "Google Drive refused access (403). Check that the Drive API is enabled for your project and that you approved access when signing in.";
		}
		if (err.status === 429) return "Google asked us to slow down. Wait a minute and try again.";
		if (err.status >= 500) return "Google Drive had a temporary problem. Wait a minute and try again.";
		return `Google Drive answered with an error (${err.status}). Try again in a minute.`;
	}
	return err instanceof Error ? err.message : String(err);
}

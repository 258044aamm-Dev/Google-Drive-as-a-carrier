import {
	GoogleAuthError,
	pollForDeviceSignIn,
	requestDeviceCode,
	type DeviceCodeInfo,
	type DeviceSignInResult,
} from "./googleAuth";
import type { DriveHttp } from "./googleDriveRest";

export interface SignInUi {
	/** The code and address to show the user. */
	showCode(info: DeviceCodeInfo): void;
	isCancelled(): boolean;
}

export interface SignInDeps {
	http: DriveHttp;
	sleep: (ms: number) => Promise<void>;
	now?: () => number;
}

/**
 * The whole sign-in, with the screen kept separate so it can be tested:
 * ask for a code, show it, then wait for the user to approve.
 */
export async function signInWithGoogle(
	client: { clientId: string; clientSecret: string },
	ui: SignInUi,
	deps: SignInDeps,
): Promise<DeviceSignInResult> {
	if (!client.clientId.trim() || !client.clientSecret.trim()) {
		throw new GoogleAuthError("Enter the Google client ID and client secret first.", "missing_client", false);
	}
	const code = await requestDeviceCode(deps.http, client.clientId);
	ui.showCode(code);
	return await pollForDeviceSignIn(deps.http, client, code, {
		sleep: deps.sleep,
		now: deps.now,
		isCancelled: () => ui.isCancelled(),
	});
}

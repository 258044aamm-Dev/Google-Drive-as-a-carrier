import { checkClientId, checkClientSecret, checkHostedToken, checkNewPassphrase, checkVaultId } from "./validate";
import { SETUP_CODE_PREFIX } from "./setupCode";
import type { WizardController, StepId } from "./wizardController";
import { driveFolderLabel } from "../carrierSettings";
import { HOSTED_SIGNIN_URL, HOSTED_TOKEN_URL } from "../hostedAuth";

/**
 * What each wizard screen says and offers, as plain data. The Obsidian window
 * (DriveSetupWizard.ts) only draws this, so the words and the rules can be
 * tested without a screen.
 */

export type ActionId =
	| "next" | "back" | "cancel" | "retry"
	| "choose-new" | "choose-join" | "client-hosted" | "client-bundled" | "client-own"
	| "copy-code" | "copy-signin-code" | "reload" | "close"
	| "clear-join-passphrase";

export type Block =
	| { kind: "p"; text: string }
	| { kind: "steps"; items: string[] }
	| { kind: "note"; tone: "info" | "warn"; text: string }
	| { kind: "code"; text: string }
	| { kind: "checklist"; items: { label: string; status: "pending" | "running" | "done" | "failed" }[] }
	| { kind: "link"; label: string; url: string };

export interface Field {
	key: string;
	label: string;
	type: "text" | "password" | "checkbox" | "textarea";
	value: string | boolean;
	placeholder?: string;
	help?: string;
	/** Shown under the field while the value is not acceptable (only once something was typed). */
	problem?: string | null;
}

export interface ButtonDef {
	label: string;
	action: ActionId;
	kind: "primary" | "secondary" | "link";
	disabled?: boolean;
}

export interface Screen {
	id: StepId;
	title: string;
	/** "Step 3 of 8", or null on the first two screens. */
	progress: string | null;
	body: Block[];
	fields: Field[];
	buttons: ButtonDef[];
	busy: string | null;
	error: string | null;
}

export const GOOGLE_URLS = {
	createProject: "https://console.cloud.google.com/projectcreate",
	driveApi: "https://console.cloud.google.com/apis/library/drive.googleapis.com",
	consent: "https://console.cloud.google.com/auth/overview",
	createClient: "https://console.cloud.google.com/auth/clients/create",
	audience: "https://console.cloud.google.com/auth/audience",
	device: "https://www.google.com/device",
} as const;

const OWN_CLIENT_HINT = "Creating your own Google client is easier on a computer than on a phone. You only do it once.";

function link(label: string, url: string): Block {
	return { kind: "link", label, url };
}

function typed(value: string, check: (v: string) => string | null): string | null {
	return value.trim() ? check(value) : null;
}

export function buildScreen(c: WizardController): Screen {
	const { state } = c;
	const { draft } = state;
	const steps = c.steps;
	const at = steps.indexOf(state.step);
	const progress = state.step === "welcome" || state.step === "choose" ? null : `Step ${at + 1} of ${steps.length}`;
	const screen: Screen = {
		id: state.step,
		title: "",
		progress,
		body: [],
		fields: [],
		buttons: [],
		busy: state.busy,
		error: state.error,
	};
	const back: ButtonDef = { label: "Back", action: "back", kind: "secondary", disabled: !c.canBack() };
	const cancel: ButtonDef = { label: "Cancel", action: "cancel", kind: "link" };
	const next = (label = "Next"): ButtonDef => ({ label, action: "next", kind: "primary", disabled: !c.canNext() });
	const standard = (nextLabel = "Next"): ButtonDef[] => [cancel, back, next(nextLabel)];

	switch (state.step) {
		case "welcome":
			screen.title = "Set up Google Drive sync";
			screen.body = [
				{ kind: "p", text: "Your notes will sync between your devices through a folder in your own Google Drive. There is no server to set up and no extra account." },
				{ kind: "p", text: "This takes a few minutes. You need a Google account." },
				{ kind: "note", tone: "info", text: "YAOS can only see the files it creates itself. It cannot see anything else in your Google Drive. Changes appear on your other devices after a few seconds, not instantly." },
			];
			screen.buttons = [cancel, next("Start")];
			break;
		case "choose":
			screen.title = "What do you want to do?";
			screen.body = [
				{ kind: "p", text: "Pick the first one for your first device. Pick the second to connect another device to a vault you already made." },
			];
			screen.buttons = [
				{ label: "Start a new vault", action: "choose-new", kind: "primary" },
				{ label: "Join my existing vault", action: "choose-join", kind: "secondary" },
				cancel,
			];
			break;
		case "client":
			screen.title = "How do you want to sign in to Google?";
			screen.body = [
				{ kind: "p", text: "YAOS needs to sign in to your Google account to reach your Drive. Pick the way that suits you." },
				{ kind: "steps", items: [
					"Easy sign-in (recommended): a short sign-in on a web page, then paste one code. No Google Cloud setup. A sign-in service run by someone else (the author of the Obsidian Google Drive plugin) exchanges your sign-in for access. It never receives your notes.",
					...(c.bundledAvailable
						? [
							"Private sign-in: the built-in connection. Nothing goes through anyone else's service.",
							"Your own Google client (advanced): you create a free Google Cloud project once. Nothing goes through anyone else's service. About ten minutes on a computer.",
						]
						: [
							"Private sign-in (your own Google client): you create a free Google Cloud project once and enter its client ID and secret yourself. Nothing goes through anyone else's service, and the details stay yours. About ten minutes on a computer.",
						]),
				] },
				{ kind: "note", tone: "warn", text: "Choose one and keep it. A vault made with one way of signing in cannot be opened with another, because Google lets each connection see only the files it made." },
			];
			screen.buttons = [
				{ label: "Easy sign-in (recommended)", action: "client-hosted", kind: "primary" },
				...(c.bundledAvailable
					? [
						{ label: "Private sign-in (built-in connection)", action: "client-bundled" as const, kind: "secondary" as const },
						{ label: "Use my own Google client (advanced)", action: "client-own" as const, kind: "secondary" as const },
					]
					: [{ label: "Private sign-in (your own Google client)", action: "client-own" as const, kind: "secondary" as const }]),
				cancel,
				back,
			];
			break;
		case "hosted-token":
			screen.title = "Sign in on the sign-in page";
			screen.body = [
				{ kind: "steps", items: [
					"Press the button below. The sign-in page opens in your browser.",
					"Press Sign in at the top right and choose your Google account.",
					"Approve access. Google asks only for the files this app creates.",
					"The page shows Your Refresh Token. Copy that entire value, not a code from the browser address bar.",
					"Come back here and paste it below.",
				] },
				link("Open the sign-in page", HOSTED_SIGNIN_URL),
				{ kind: "note", tone: "info", text: "That page is run by the author of the Obsidian Google Drive plugin, not by YAOS. It only trades your sign-in for short-lived access, and its own page says your notes never pass through it. Because it takes part in signing in, turn encryption on in the next steps: then even your files in Google Drive stay unreadable to anyone else." },
			];
			if (c.hostedTokenUrl !== HOSTED_TOKEN_URL) {
				let destination = "the custom endpoint configured on this device";
				try { destination = new URL(c.hostedTokenUrl).origin; } catch { /* HTTP adapter will report an invalid URL. */ }
				screen.body.push({ kind: "note", tone: "info", text: `Your refresh token will be sent to ${destination}, not the default token service. Continue only if you trust this service and the token was issued for its Google client.` });
			}
			screen.fields = [
				{ key: "hostedToken", label: "Sign-in token (Your Refresh Token)", type: "password", value: draft.hostedToken, placeholder: "Paste the complete refresh token here", problem: typed(draft.hostedToken, checkHostedToken) },
			];
			screen.buttons = standard();
			break;
		case "guide-project":
			screen.title = "Make a Google project";
			screen.body = [
				{ kind: "p", text: OWN_CLIENT_HINT },
				{ kind: "steps", items: [
					"Press the button below. Google opens in your browser.",
					"Sign in with the Google account whose Drive you want to use.",
					"Project name: YAOS (any name works). Press Create.",
					"Wait until the new project is selected at the top of the page.",
				] },
				link("Open Google Cloud: new project", GOOGLE_URLS.createProject),
			];
			screen.buttons = standard();
			break;
		case "guide-api":
			screen.title = "Switch on the Google Drive API";
			screen.body = [
				{ kind: "steps", items: [
					"Press the button below.",
					"Check that your YAOS project is selected at the top.",
					"Press Enable. If the page shows Manage instead, it is already on.",
				] },
				link("Open the Google Drive API page", GOOGLE_URLS.driveApi),
			];
			screen.buttons = standard();
			break;
		case "guide-consent":
			screen.title = "Set up the sign-in screen";
			screen.body = [
				{ kind: "steps", items: [
					"Press the button below. If Google shows Get started, press it.",
					"App name: YAOS. User support email: your email address.",
					"Audience: choose External.",
					"Contact information: your email address. Agree to the policy, then press Create.",
				] },
				{ kind: "note", tone: "info", text: "The page may look a little different from this list. Google changes it from time to time. Fill in the app name, your email and choose External." },
				link("Open the Google sign-in screen setup", GOOGLE_URLS.consent),
			];
			screen.buttons = standard();
			break;
		case "guide-client":
			screen.title = "Create the Google client";
			screen.body = [
				{ kind: "steps", items: [
					"Press the button below.",
					"Application type: choose TVs and Limited Input devices. This exact type is required.",
					"Name: YAOS. Press Create.",
					"A window shows a Client ID and a Client secret. Keep it open, or copy both. You paste them on the next screens.",
				] },
				link("Open Google: create a client", GOOGLE_URLS.createClient),
			];
			screen.buttons = standard();
			break;
		case "guide-publish":
			screen.title = "Publish the app (important)";
			screen.body = [
				{ kind: "steps", items: [
					"Press the button below.",
					"Under Publishing status, press Publish app and confirm.",
				] },
				{ kind: "note", tone: "warn", text: "Do not skip this. A Google app left in Testing signs you out every 7 days, and sync would stop." },
				{ kind: "p", text: "You do not need to send the app to Google for review. YAOS only asks for access to its own files, and Google does not require a review for that." },
				link("Open Google: publish the app", GOOGLE_URLS.audience),
			];
			screen.buttons = standard();
			break;
		case "paste":
			screen.title = "Paste the client details";
			screen.body = [
				{ kind: "p", text: "Copy the Client ID and the Client secret from the Google window and paste them here." },
				{ kind: "note", tone: "info", text: "They are saved only in this vault's plugin data, on your devices." },
			];
			screen.fields = [
				{ key: "clientId", label: "Client ID", type: "text", value: draft.clientId, placeholder: "123456789-abc.apps.googleusercontent.com", problem: typed(draft.clientId, checkClientId) },
				{ key: "clientSecret", label: "Client secret", type: "password", value: draft.clientSecret, placeholder: "GOCSPX-...", problem: typed(draft.clientSecret, checkClientSecret) },
			];
			screen.buttons = standard();
			break;
		case "join-code": {
			screen.title = "Join your vault";
			const preview = c.previewJoinCode();
			screen.body = [
				{ kind: "p", text: "On your other device, finish the wizard (or reopen it) to get a setup code, then paste it here." },
				{ kind: "note", tone: "info", text: "If this device already has notes, they are merged with the vault. For the cleanest result, join with an empty vault." },
			];
			if (!draft.manualJoin) {
				screen.fields.push({
					key: "setupCodeText",
					label: "Setup code",
					type: "textarea",
					value: draft.setupCodeText,
					placeholder: `${SETUP_CODE_PREFIX}...`,
					problem: draft.setupCodeText.trim() ? c.blocker() : null,
				});
				if (preview) {
					screen.body.push({ kind: "note", tone: "info", text: `Code accepted. Vault ${preview.vaultId}${preview.encrypted ? ", encrypted" : ""}${preview.hosted ? ", easy sign-in" : ""}.` });
				}
			}
			screen.fields.push({ key: "manualJoin", label: "I have no code: enter the details by hand", type: "checkbox", value: draft.manualJoin });
			if (draft.manualJoin) {
				screen.fields.push(
					{ key: "vaultId", label: "Vault ID", type: "text", value: draft.vaultId, problem: typed(draft.vaultId, checkVaultId) },
					{ key: "passphrase", label: "Encryption passphrase (only if the vault is encrypted)", type: "password", value: draft.passphrase },
					{ key: "joinHosted", label: "This vault was made with the easy sign-in", type: "checkbox", value: draft.joinHosted },
				);
			}
			if (draft.manualJoin && !draft.joinHosted) {
				screen.fields.push(
					{
						key: "clientId",
						label: c.bundledAvailable ? "Google client ID (leave empty to use the built-in connection)" : "Google client ID",
						type: "text",
						value: draft.clientId,
						problem: typed(draft.clientId, checkClientId),
					},
					{ key: "clientSecret", label: "Google client secret", type: "password", value: draft.clientSecret, problem: typed(draft.clientSecret, checkClientSecret) },
				);
			}
			screen.buttons = standard();
			break;
		}
		case "existing": {
			screen.title = "This device is already set up";
			const settings = c.stateSummary();
			screen.body = [
				{ kind: "p", text: `This device already syncs with Google Drive (vault ${settings.vaultId}). Continuing sets up ${draft.path === "join" ? "the vault from your code" : "a new, separate vault"} on this device instead.` },
				{ kind: "note", tone: "warn", text: "Your old vault stays in Google Drive, untouched. The notes on this device will be synced into the new vault." },
			];
			screen.fields = [{ key: "existingAccepted", label: "I understand", type: "checkbox", value: draft.existingAccepted }];
			screen.buttons = standard();
			break;
		}
		case "signin": {
			screen.title = draft.clientMode === "hosted" ? "Checking your sign-in" : "Sign in with Google";
			if (draft.refreshToken && !state.busy) {
				screen.body = [{ kind: "note", tone: "info", text: "You are signed in. Press Next." }];
			} else if (state.signIn) {
				screen.body = [
					{ kind: "p", text: "On any device, open the page below and type this code. Keep this window open until Google says you are done." },
					{ kind: "code", text: state.signIn.userCode },
					link(`Open ${state.signIn.verificationUrl}`, state.signIn.verificationUrl),
				];
				if (draft.clientMode === "own") {
					screen.body.push({ kind: "note", tone: "info", text: "If Google says it has not verified the app, that is normal for an app you made yourself. Choose Continue." });
				}
			} else if (!state.error) {
				screen.body = [{ kind: "p", text: draft.clientMode === "hosted" ? "Checking your sign-in code..." : "Asking Google for a sign-in code..." }];
			}
			screen.buttons = [cancel, back, ...(state.signIn ? [{ label: "Copy code", action: "copy-signin-code" as const, kind: "secondary" as const }] : []), ...(state.error ? [{ label: "Try again", action: "retry" as const, kind: "primary" as const }] : [next()])];
			break;
		}
		case "encryption": {
			screen.title = "Protect your notes";
			screen.body = [
				{ kind: "p", text: "Encryption scrambles your notes in Google Drive, so nobody without the passphrase can read them, not even someone with access to your Google account." },
				{ kind: "note", tone: "warn", text: "You can only choose this now, when the vault is created. If you lose the passphrase, your notes in Google Drive cannot be recovered. Your devices keep their own copies." },
			];
			screen.fields = [{ key: "encrypt", label: "Encrypt my notes in Google Drive (recommended)", type: "checkbox", value: draft.encrypt }];
			if (draft.encrypt) {
				screen.fields.push(
					{ key: "passphrase", label: "Passphrase", type: "password", value: draft.passphrase, help: "At least 8 characters. Use a long phrase you will remember." },
					{
						key: "passphraseConfirm",
						label: "Type the passphrase again",
						type: "password",
						value: draft.passphraseConfirm,
						problem: draft.passphrase || draft.passphraseConfirm ? checkNewPassphrase(draft.passphrase, draft.passphraseConfirm) : null,
					},
					{ key: "riskAccepted", label: "I understand that a lost passphrase cannot be recovered", type: "checkbox", value: draft.riskAccepted },
				);
				screen.body.push({ kind: "p", text: "The passphrase is also saved on each of your devices, in this plugin's data file." });
			} else {
				screen.body.push({ kind: "note", tone: "warn", text: "Without encryption, anyone who can open your Google Drive can read your notes in the YAOS folder." });
			}
			screen.buttons = standard();
			break;
		}
		case "create": {
			screen.title = "Setting up your vault";
			screen.body = [{ kind: "checklist", items: state.checklist.map((s) => ({ label: s.label, status: s.status })) }];
			if (c.committed) {
				screen.body.push({ kind: "note", tone: "info", text: `Done. Your notes will live in the Google Drive folder "${driveFolderLabel(draft.vaultId)}".` });
			}
			screen.buttons = [cancel, ...(state.error ? [back, { label: "Try again", action: "retry" as const, kind: "primary" as const }] : [next()])];
			break;
		}
		case "join-check": {
			screen.title = "Checking your vault";
			const check = state.joinCheck;
			if (check?.status === "ok") {
				screen.body = [{ kind: "note", tone: "info", text: `Found it${check.encrypted ? " (encrypted, the passphrase fits)" : ""}. Press Next to start syncing.` }];
			} else if (check) {
				screen.body = [{ kind: "note", tone: "warn", text: joinProblemText(check.status === "other-layout" ? `${check.status}:${check.found}` : check.status) }];
				if (check.status === "needs-passphrase" || check.status === "wrong-passphrase") {
					screen.fields = [{ key: "joinPassphrase", label: "Encryption passphrase", type: "password", value: draft.passphrase }];
				}
			} else if (!state.error) {
				screen.body = [{ kind: "p", text: "Looking for your vault in Google Drive..." }];
			}
			const retryButton: ButtonDef[] = [];
			if (state.error || (check && check.status !== "ok")) {
				if (check?.status === "not-encrypted") retryButton.push({ label: "Clear the passphrase and check again", action: "clear-join-passphrase", kind: "primary" });
				else retryButton.push({ label: "Check again", action: "retry", kind: "primary" });
			}
			screen.buttons = [cancel, back, ...(retryButton.length ? retryButton : [next()])];
			break;
		}
		case "code": {
			screen.title = "Your setup code";
			const encrypted = draft.encrypt && draft.passphrase !== "";
			screen.body = [
				{ kind: "p", text: "To connect another device, install the plugin there, choose Google Drive, pick \"Join my existing vault\" and paste this code." },
				{ kind: "code", text: state.setupCode ?? "" },
				{ kind: "note", tone: "warn", text: "Keep this code private: it holds " + (draft.clientMode === "hosted" ? "your vault ID" : "your Google client details") + (encrypted && draft.includePassphrase ? " and your passphrase" : "") + ". Do not paste it into a note inside this vault, because notes are synced. You can reopen this wizard later to see it again." },
			];
			if (draft.clientMode === "hosted") {
				screen.body.push({ kind: "note", tone: "info", text: "On the other device you sign in again on the same sign-in page, with the same Google account. The code does not contain your sign-in." });
			}
			if (encrypted) {
				screen.fields = [{ key: "includePassphrase", label: "Include the passphrase in the code", type: "checkbox", value: draft.includePassphrase, help: "If you leave it out, you will type the passphrase on the other device." }];
			}
			screen.buttons = [{ label: state.copied ? "Copied" : "Copy code", action: "copy-code", kind: "secondary" }, next("Finish")];
			break;
		}
		case "done":
			screen.title = state.busy ? "Starting sync" : "You are all set";
			if (state.result === "started") {
				screen.body = [
					{ kind: "p", text: "Sync is starting. Your notes will appear in your Google Drive in the folder \"" + driveFolderLabel(draft.vaultId) + "\"." },
					{ kind: "note", tone: "info", text: "The first sync can take a little while on a big vault. You can keep using Obsidian." },
				];
				screen.buttons = [{ label: "Close", action: "close", kind: "primary" }];
			} else if (state.result === "reload") {
				screen.body = [
					{ kind: "p", text: "One last step: reload Obsidian so sync can start." },
					{ kind: "note", tone: "info", text: "Your Google Drive settings are saved." },
				];
				screen.buttons = [{ label: "Reload Obsidian", action: "reload", kind: "primary" }, { label: "Later", action: "close", kind: "secondary" }];
			} else {
				screen.buttons = [];
			}
			break;
	}
	return screen;
}

export function joinProblemText(status: string): string {
	if (status === "not-found") {
		return "No vault with that ID was found for this Google client. Check the ID, and make sure this device signed in with the same Google account and the same Google client as your first device.";
	}
	if (status === "needs-passphrase") return "This vault is encrypted. Enter its passphrase.";
	if (status === "wrong-passphrase") return "That passphrase does not fit this vault. Check it and try again.";
	if (status === "not-encrypted") return "This vault is not encrypted, but a passphrase was entered. Clear the passphrase to continue.";
	return "This vault was made by a different version of the plugin. Update the plugin on all your devices.";
}

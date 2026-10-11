import type { DriveApi } from "../driveApi";
import { GoogleAuthError, GoogleTokenManager, type DeviceCodeInfo, type DeviceSignInResult, type GoogleClient } from "../googleAuth";
import { GoogleDriveRest, type DriveHttp } from "../googleDriveRest";
import { describeHostedEndpoint, resolveHostedTokenUrl, HostedTokenManager, type HostedEndpointInfo } from "../hostedAuth";
import { isDriveCarrier, isDriveSignedIn, isHostedSignIn, type DriveCarrierSettings } from "../carrierSettings";
import { signInWithGoogle, type SignInUi } from "../signIn";
import { checkVaultForJoin, createVault, type CheckStep, type JoinCheck } from "./driveSetup";
import { explainHostedSignInError, explainSetupError } from "./explainError";
import { decodeSetupCode, describeSetupCodeProblem, encodeSetupCode } from "./setupCode";
import { checkClientId, checkClientSecret, checkHostedToken, checkNewPassphrase, checkVaultId, normalizeHostedToken } from "./validate";

export type StepId =
	| "welcome" | "choose" | "client"
	| "hosted-token"
	| "guide-project" | "guide-api" | "guide-consent" | "guide-client" | "guide-publish" | "paste"
	| "join-code" | "existing" | "signin"
	| "encryption" | "create" | "join-check" | "code" | "done";

/**
 * F4, decision 4 (2.1.23). The easy sign-in hands the sign-in to a service run by
 * someone else, so a vault that uses it has to be encrypted: otherwise that service
 * holds a token to a vault whose files anyone with the Google account can read. The
 * wizard refuses to create such a vault, and refuses to finish a join into one.
 */
export const HOSTED_NEEDS_PASSPHRASE =
	"The easy sign-in goes through a service run by someone else, so a vault that uses it has to be encrypted. Keep \"Encrypt my notes in Google Drive\" ticked and choose a passphrase, or go back and use your own Google client.";
export const HOSTED_JOIN_NEEDS_ENCRYPTION =
	"This vault was created without encryption. The easy sign-in goes through a service run by someone else, so it will not sync a vault whose files are readable in Google Drive. Use \"Private sign-in (your own Google client)\" for this vault, or create a new vault with a passphrase.";

export type WizardPath = "new" | "join";
/** hosted = the easy sign-in page, bundled = the client built into the plugin, own = the user's own Google client. */
export type ClientMode = "hosted" | "bundled" | "own";

export interface WizardDraft {
	path: WizardPath | null;
	clientMode: ClientMode;
	clientId: string;
	clientSecret: string;
	vaultId: string;
	encrypt: boolean;
	passphrase: string;
	passphraseConfirm: string;
	riskAccepted: boolean;
	existingAccepted: boolean;
	setupCodeText: string;
	manualJoin: boolean;
	includePassphrase: boolean;
	refreshToken: string;
	/** What the user pasted from the easy sign-in page. */
	hostedToken: string;
	/** Joining by hand: the vault uses the easy sign-in. */
	joinHosted: boolean;
}

export type WizardSettings = DriveCarrierSettings & { vaultId: string };

/** What the wizard saves, in one go, when the vault is created or joined. */
export interface WizardSettingsPatch {
	carrier: "drive";
	vaultId: string;
	driveClientId: string;
	driveClientSecret: string;
	driveRefreshToken: string;
	driveEncryptionPassphrase: string;
	/** "hosted" for the easy sign-in; absent for the other two (and it must then be cleared). */
	driveAuthMode?: "hosted";
	/** F4: the custom sign-in address that actually served this sign-in (default service: absent). */
	driveHostedUrlUsed?: string;
}

export type FinishResult = "started" | "reload";

export interface WizardDeps {
	http: DriveHttp;
	sleep: (ms: number) => Promise<void>;
	getSettings(): WizardSettings;
	applySettings(patch: WizardSettingsPatch): Promise<void>;
	newVaultId(): string;
	bundledClient: GoogleClient | null;
	copyText(text: string): Promise<void>;
	openUrl(url: string): void;
	/** Start syncing now when that is safe, otherwise say a reload is needed. */
	finishSetup(): Promise<FinishResult>;
	reloadApp?(): void;
	/** For tests: key-derivation cost, a fake sign-in and a fake Drive. */
	kdfIterations?: number;
	signIn?: (client: GoogleClient, ui: SignInUi) => Promise<DeviceSignInResult>;
	makeApi?: (client: GoogleClient, refreshToken: string) => DriveApi;
	/** Called after every change, so the screen can redraw. */
	onChange?: () => void;
	/** The easy sign-in token service (tests point this at a fake). */
	hostedUrl?: string;
	/** Called when the wizard wants to close. */
	onClose?: () => void;
}

export interface WizardState {
	step: StepId;
	draft: WizardDraft;
	busy: string | null;
	error: string | null;
	signIn: DeviceCodeInfo | null;
	checklist: CheckStep[];
	joinCheck: JoinCheck | null;
	/** The setup code, once a vault exists on this device. */
	setupCode: string | null;
	result: FinishResult | null;
	copied: boolean;
}

export const GUIDE_STEPS: StepId[] = ["guide-project", "guide-api", "guide-consent", "guide-client", "guide-publish", "paste"];

export function newDraft(): WizardDraft {
	return {
		path: null,
		clientMode: "hosted",
		clientId: "",
		clientSecret: "",
		vaultId: "",
		encrypt: true,
		passphrase: "",
		passphraseConfirm: "",
		riskAccepted: false,
		existingAccepted: false,
		setupCodeText: "",
		manualJoin: false,
		includePassphrase: true,
		refreshToken: "",
		hostedToken: "",
		joinHosted: false,
	};
}

/** The steps for the current choices, in order. */
export function stepsFor(draft: WizardDraft, ctx: { alreadySetUp: boolean }): StepId[] {
	const steps: StepId[] = ["welcome", "choose"];
	if (draft.path === "join") {
		steps.push("join-code");
		if (ctx.alreadySetUp) steps.push("existing");
		if (draft.clientMode === "hosted") steps.push("hosted-token");
		steps.push("signin", "join-check", "done");
		return steps;
	}
	steps.push("client");
	if (draft.clientMode === "own") steps.push(...GUIDE_STEPS);
	if (ctx.alreadySetUp) steps.push("existing");
	if (draft.clientMode === "hosted") steps.push("hosted-token");
	steps.push("signin", "encryption", "create", "code", "done");
	return steps;
}

/** The client this run will use: the built-in one, or the one the user typed in. */
export function chosenClient(draft: WizardDraft, bundled: GoogleClient | null): GoogleClient {
	if (draft.clientMode === "hosted") return { clientId: "", clientSecret: "" };
	if (draft.clientMode === "bundled" && bundled) return { clientId: bundled.clientId, clientSecret: bundled.clientSecret };
	return { clientId: draft.clientId.trim(), clientSecret: draft.clientSecret.trim() };
}

export class WizardController {
	state: WizardState;
	private cancelled = false;
	private running = 0;
	/** True once the vault exists on this device (created, or checked and joined). */
	private vaultReady = false;
	/** The client the current sign-in belongs to, so going back and forward does not ask again. */
	private signedInClient = "";

	constructor(private readonly deps: WizardDeps) {
		const draft = newDraft();
		this.state = {
			step: "welcome",
			draft,
			busy: null,
			error: null,
			signIn: null,
			checklist: [],
			joinCheck: null,
			setupCode: null,
			result: null,
			copied: false,
		};
	}

	/** Use the same saved endpoint policy as the carrier; the explicit override is for tests. */
	get hostedTokenUrl(): string {
		return resolveHostedTokenUrl(this.deps.hostedUrl ?? this.deps.getSettings().driveHostedUrl);
	}

	/** F4: where the sign-in code would be sent, plus why it cannot be sent there (if it cannot). */
	get hostedEndpoint(): HostedEndpointInfo {
		return describeHostedEndpoint(this.deps.hostedUrl ?? this.deps.getSettings().driveHostedUrl);
	}

	get bundledAvailable(): boolean {
		return this.deps.bundledClient !== null;
	}

	get alreadySetUp(): boolean {
		const settings = this.deps.getSettings();
		return isDriveCarrier(settings) && isDriveSignedIn(settings);
	}

	get steps(): StepId[] {
		return stepsFor(this.state.draft, { alreadySetUp: this.alreadySetUp });
	}

	/** True once the vault exists on this device: going back would not undo it. */
	get committed(): boolean {
		return this.vaultReady;
	}

	private changed(): void {
		this.deps.onChange?.();
	}

	setField<K extends keyof WizardDraft>(key: K, value: WizardDraft[K]): void {
		// F4 (decision 4): on the easy-sign-in path encryption is a rule, not a default,
		// so this tick box cannot be turned off there. The encryption screen says why.
		if (key === "encrypt" && value === false && this.state.draft.clientMode === "hosted") return;
		this.state.draft[key] = value;
		this.state.error = null;
		if (key === "includePassphrase") this.refreshSetupCode();
		this.changed();
	}

	// -- navigation ---------------------------------------------------------

	/** The reason the current step cannot continue yet, or null. */
	blocker(): string | null {
		const { draft, step } = this.state;
		switch (step) {
			// F4: a refused address blocks the token step (and with it every later step), so
			// nothing is ever sent to it. The wording is the reason from resolveHostedTokenUrl.
			case "hosted-token": return this.hostedEndpoint.problem ?? checkHostedToken(draft.hostedToken);
			case "paste": return checkClientId(draft.clientId) ?? checkClientSecret(draft.clientSecret);
			case "join-code": return this.joinInputProblem();
			case "existing": return draft.existingAccepted ? null : "Tick the box to continue.";
			case "encryption":
				// F4 (decision 4): the easy sign-in is refused for a vault that would be plain
				// in Google Drive, so the step cannot be passed with encryption off.
				if (draft.clientMode === "hosted" && !draft.encrypt) return HOSTED_NEEDS_PASSPHRASE;
				if (!draft.encrypt) return null;
				return checkNewPassphrase(draft.passphrase, draft.passphraseConfirm) ?? (draft.riskAccepted ? null : "Tick the box to confirm you understand.");
			case "signin": return this.state.draft.refreshToken ? null : "Waiting for you to sign in.";
			case "create": return this.state.setupCode ? null : "The vault is not ready yet.";
			case "join-check": {
				// F4 (decision 4): a vault without encryption is not joined through the easy sign-in.
				const refusal = this.hostedJoinRefusal(this.state.joinCheck);
				if (refusal) return refusal;
				return this.state.joinCheck?.status === "ok" ? null : "The vault is not checked yet.";
			}
			default: return null;
		}
	}

	/**
	 * F4 (decision 4): why a checked vault may not be joined with the easy sign-in, or
	 * null. Screens and the step rule both ask this, so the wording cannot drift.
	 */
	hostedJoinRefusal(check: JoinCheck | null): string | null {
		if (check?.status !== "ok" || check.encrypted) return null;
		return this.state.draft.clientMode === "hosted" ? HOSTED_JOIN_NEEDS_ENCRYPTION : null;
	}

	private joinInputProblem(): string | null {
		const { draft } = this.state;
		if (!draft.manualJoin) {
			const result = decodeSetupCode(draft.setupCodeText);
			if (!result.ok) return describeSetupCodeProblem(result.reason);
			return this.signInModeMismatch(result.content.hosted === true);
		}
		const vault = checkVaultId(draft.vaultId);
		if (vault) return vault;
		if (draft.joinHosted) return null;
		if (!this.bundledAvailable || draft.clientId.trim() || draft.clientSecret.trim()) {
			return checkClientId(draft.clientId) ?? checkClientSecret(draft.clientSecret);
		}
		return null;
	}

	/**
	 * F5: a vault is only visible to the Google sign-in that created its folder,
	 * because the carrier asks for the `drive.file` scope. A device that is already
	 * signed in the other way would join an empty view of the vault (or make a
	 * second folder of its own), so the join stops here instead, while the fix is
	 * still one step away. A device that has not signed in yet has nothing to
	 * mismatch: the code decides.
	 */
	private signInModeMismatch(codeUsesHosted: boolean): string | null {
		const saved = this.deps.getSettings();
		if (!isDriveSignedIn(saved)) return null;
		const deviceUsesHosted = isHostedSignIn(saved);
		if (deviceUsesHosted === codeUsesHosted) return null;
		const codeMode = codeUsesHosted ? "the easy sign-in" : "its own Google client";
		const deviceMode = deviceUsesHosted ? "the easy sign-in" : "your own Google client";
		return `This device is already signed in with ${deviceMode}, but the setup code was made with ${codeMode}. `
			+ "Google lets an app see only the files it created, so this vault stays invisible to the other sign-in: joining would look empty, or make a second folder. "
			+ "Use a code from the same kind of sign-in as this device (or sign in the same way as the device that made this code), or set this device up as a new vault.";
	}

	canNext(): boolean {
		return this.state.busy === null && this.blocker() === null && this.state.step !== "done";
	}

	canBack(): boolean {
		if (this.state.busy !== null) return false;
		if (this.committed) return false;
		return this.steps.indexOf(this.state.step) > 0;
	}

	async next(): Promise<void> {
		if (!this.canNext()) return;
		// Reading the code can change which way of signing in applies, and so the steps ahead.
		if (this.state.step === "join-code") this.absorbJoinInput();
		const steps = this.steps;
		const at = steps.indexOf(this.state.step);
		const target = steps[at + 1];
		if (!target) return;
		await this.go(target);
	}

	async back(): Promise<void> {
		if (!this.canBack()) return;
		const steps = this.steps;
		let index = steps.indexOf(this.state.step) - 1;
		// The sign-in screen is a step that runs by itself; going back skips over it.
		if (steps[index] === "signin" && this.state.draft.refreshToken) index--;
		const target = steps[index];
		if (!target) return;
		this.cancelSignIn();
		this.state.error = null;
		this.state.busy = null;
		this.state.step = target;
		this.changed();
	}

	cancel(): void {
		this.cancelSignIn();
		this.deps.onClose?.();
	}

	private cancelSignIn(): void {
		this.cancelled = true;
		this.running++;
	}

	choosePath(path: WizardPath): void {
		this.state.draft.path = path;
		if (path === "new") this.state.draft.vaultId = this.deps.newVaultId();
		void this.go(this.steps[2] ?? "done");
	}

	chooseClient(mode: ClientMode): void {
		this.state.draft.clientMode = mode === "bundled" && !this.deps.bundledClient ? "own" : mode;
		void this.go(this.steps[this.steps.indexOf("client") + 1] ?? "signin");
	}

	private async go(step: StepId): Promise<void> {
		this.state.error = null;
		// F4 (decision 4): a draft that reached "encryption" another way (exported state,
		// an older wizard session) is corrected here too, so the rule holds for every path.
		if (step === "encryption" && this.state.draft.clientMode === "hosted") this.state.draft.encrypt = true;
		this.state.step = step;
		this.changed();
		if (step === "signin") {
			if (this.state.draft.refreshToken && this.signedInClient === this.signInKey()) await this.next();
			else await this.runSignIn();
		} else if (step === "create") await this.runCreate();
		else if (step === "join-check") await this.runJoinCheck();
		else if (step === "done") await this.runFinish();
	}

	// -- join input ---------------------------------------------------------

	private absorbJoinInput(): void {
		const { draft } = this.state;
		if (!draft.manualJoin) {
			const result = decodeSetupCode(draft.setupCodeText);
			if (!result.ok) return;
			const { content } = result;
			draft.vaultId = content.vaultId;
			draft.clientId = content.clientId;
			draft.clientSecret = content.clientSecret;
			draft.passphrase = content.passphrase;
			draft.encrypt = content.encrypted;
			const bundled = this.deps.bundledClient;
			if (content.hosted) draft.clientMode = "hosted";
			else draft.clientMode = bundled && bundled.clientId === content.clientId ? "bundled" : "own";
		} else {
			draft.vaultId = draft.vaultId.trim();
			const typedClient = draft.clientId.trim() || draft.clientSecret.trim();
			if (draft.joinHosted) draft.clientMode = "hosted";
			else draft.clientMode = !typedClient && this.deps.bundledClient ? "bundled" : "own";
			draft.encrypt = draft.passphrase !== "";
		}
	}

	/** What the code from step "join-code" says, for showing a summary. */
	previewJoinCode(): { vaultId: string; encrypted: boolean; ownClient: boolean; hosted: boolean } | null {
		const result = decodeSetupCode(this.state.draft.setupCodeText);
		if (!result.ok) return null;
		return { vaultId: result.content.vaultId, encrypted: result.content.encrypted, ownClient: !result.content.bundledClient && !result.content.hosted, hosted: result.content.hosted === true };
	}

	// -- sign in ------------------------------------------------------------

	async retry(): Promise<void> {
		const { step } = this.state;
		if (step === "signin") await this.runSignIn();
		else if (step === "create") await this.runCreate();
		else if (step === "join-check") await this.runJoinCheck();
	}

	/** Identifies the sign-in the current choices need, so going back and forward does not repeat it. */
	private signInKey(): string {
		const { draft } = this.state;
		if (draft.clientMode === "hosted") return `hosted:${this.hostedTokenUrl}:${normalizeHostedToken(draft.hostedToken)}`;
		return chosenClient(draft, this.deps.bundledClient).clientId;
	}

	/** The easy sign-in: check that the service accepts the pasted token. */
	private async runHostedSignIn(): Promise<void> {
		const token = ++this.running;
		this.cancelled = false;
		const { draft } = this.state;
		draft.refreshToken = "";
		this.state.signIn = null;
		this.state.error = null;
		this.state.busy = "Checking your sign-in code...";
		this.changed();
		const pasted = normalizeHostedToken(draft.hostedToken);
		const refused = this.hostedEndpoint.problem;
		if (refused) {
			this.state.busy = null;
			this.state.error = refused;
			this.changed();
			return;
		}
		try {
			const manager = new HostedTokenManager(this.deps.http, this.hostedTokenUrl, pasted);
			await manager.provider(true);
			if (token !== this.running) return;
			draft.refreshToken = pasted;
			this.signedInClient = this.signInKey();
			this.state.busy = null;
			this.changed();
			await this.next();
		} catch (err) {
			if (token !== this.running) return;
			this.state.busy = null;
			this.state.error = explainHostedSignInError(err);
			this.changed();
		}
	}

	async runSignIn(): Promise<void> {
		if (this.state.draft.clientMode === "hosted") {
			await this.runHostedSignIn();
			return;
		}
		const token = ++this.running;
		this.cancelled = false;
		const { draft } = this.state;
		draft.refreshToken = "";
		this.state.signIn = null;
		this.state.error = null;
		this.state.busy = "Asking Google for a sign-in code...";
		this.changed();
		const client = chosenClient(draft, this.deps.bundledClient);
		const ui: SignInUi = {
			showCode: (info) => {
				if (token !== this.running) return;
				this.state.signIn = info;
				this.state.busy = "Waiting for you to approve in Google...";
				this.changed();
			},
			isCancelled: () => this.cancelled || token !== this.running,
		};
		try {
			const run = this.deps.signIn ?? ((c: GoogleClient, u: SignInUi) => signInWithGoogle(c, u, { http: this.deps.http, sleep: this.deps.sleep }));
			const result = await run(client, ui);
			if (token !== this.running) return;
			draft.refreshToken = result.refreshToken;
			this.signedInClient = this.signInKey();
			this.state.busy = null;
			this.state.signIn = null;
			this.changed();
			await this.next();
		} catch (err) {
			if (token !== this.running) return;
			this.state.busy = null;
			this.state.signIn = null;
			this.state.error = err instanceof GoogleAuthError && err.code === "cancelled" ? null : explainSetupError(err);
			this.changed();
		}
	}

	private apiFor(client: GoogleClient, refreshToken: string): DriveApi {
		if (this.deps.makeApi) return this.deps.makeApi(client, refreshToken);
		if (this.state.draft.clientMode === "hosted") {
			const hosted = new HostedTokenManager(this.deps.http, this.hostedTokenUrl, refreshToken);
			return new GoogleDriveRest(this.deps.http, hosted.provider);
		}
		const tokens = new GoogleTokenManager(this.deps.http, client, refreshToken);
		return new GoogleDriveRest(this.deps.http, tokens.provider);
	}

	// -- create / join ------------------------------------------------------

	private patch(): WizardSettingsPatch {
		const { draft } = this.state;
		const client = chosenClient(draft, this.deps.bundledClient);
		return {
			carrier: "drive",
			vaultId: draft.vaultId.trim(),
			// The easy sign-in has no client details; keep any that were saved earlier instead of erasing them.
			driveClientId: draft.clientMode === "hosted" ? this.deps.getSettings().driveClientId ?? "" : client.clientId,
			driveClientSecret: draft.clientMode === "hosted" ? this.deps.getSettings().driveClientSecret ?? "" : client.clientSecret,
			driveRefreshToken: draft.refreshToken,
			driveEncryptionPassphrase: draft.encrypt ? draft.passphrase : "",
			...(draft.clientMode === "hosted" ? { driveAuthMode: "hosted" as const } : {}),
			// F4: remember the custom address that served this sign-in, so the carrier can
			// spot a later change and say so instead of quietly posting the token elsewhere.
			...(draft.clientMode === "hosted" && this.hostedEndpoint.custom ? { driveHostedUrlUsed: this.hostedEndpoint.url } : {}),
		};
	}

	async runCreate(): Promise<void> {
		const token = ++this.running;
		const { draft } = this.state;
		// F4 (decision 4): never create a plain vault through the easy sign-in, whatever
		// route reached this method.
		if (draft.clientMode === "hosted" && !(draft.encrypt && draft.passphrase.trim() !== "")) {
			this.state.error = HOSTED_NEEDS_PASSPHRASE;
			this.changed();
			return;
		}
		this.state.error = null;
		this.state.busy = "Setting things up in your Google Drive...";
		this.state.checklist = [];
		this.changed();
		try {
			const client = chosenClient(draft, this.deps.bundledClient);
			const api = this.apiFor(client, draft.refreshToken);
			await createVault(api, {
				vaultId: draft.vaultId.trim(),
				passphrase: draft.encrypt ? draft.passphrase : "",
				kdfIterations: this.deps.kdfIterations,
				onStep: (steps) => {
					if (token !== this.running) return;
					this.state.checklist = steps;
					this.changed();
				},
			});
			if (token !== this.running) return;
			await this.deps.applySettings(this.patch());
			this.vaultReady = true;
			this.refreshSetupCode();
			this.state.busy = null;
			this.changed();
		} catch (err) {
			if (token !== this.running) return;
			this.state.busy = null;
			this.state.error = explainSetupError(err);
			this.changed();
		}
	}

	async runJoinCheck(): Promise<void> {
		const token = ++this.running;
		const { draft } = this.state;
		this.state.error = null;
		this.state.busy = "Looking for your vault in Google Drive...";
		this.state.joinCheck = null;
		this.changed();
		try {
			const client = chosenClient(draft, this.deps.bundledClient);
			const api = this.apiFor(client, draft.refreshToken);
			const check = await checkVaultForJoin(api, draft.vaultId.trim(), draft.encrypt ? draft.passphrase : "");
			if (token !== this.running) return;
			this.state.joinCheck = check;
			const refusal = this.hostedJoinRefusal(check);
			if (check.status === "ok" && !refusal) {
				await this.deps.applySettings(this.patch());
				this.vaultReady = true;
				this.refreshSetupCode();
			}
			this.state.busy = null;
			this.changed();
		} catch (err) {
			if (token !== this.running) return;
			this.state.busy = null;
			this.state.error = explainSetupError(err);
			this.changed();
		}
	}

	/** Used when a join problem can be fixed by typing a passphrase here. */
	setJoinPassphrase(passphrase: string): void {
		this.state.draft.passphrase = passphrase;
		this.state.draft.encrypt = passphrase !== "";
		this.state.error = null;
		this.changed();
	}

	private refreshSetupCode(): void {
		const { draft } = this.state;
		if (!this.vaultReady) return;
		const client = chosenClient(draft, this.deps.bundledClient);
		const encrypted = draft.encrypt && draft.passphrase !== "";
		this.state.setupCode = encodeSetupCode({
			vaultId: draft.vaultId.trim(),
			clientId: client.clientId,
			clientSecret: client.clientSecret,
			bundledClient: draft.clientMode === "bundled",
			hosted: draft.clientMode === "hosted",
			passphrase: encrypted && draft.includePassphrase ? draft.passphrase : "",
			encrypted,
		});
	}

	// -- finishing ----------------------------------------------------------

	private async runFinish(): Promise<void> {
		this.state.busy = "Starting sync...";
		this.changed();
		try {
			this.state.result = await this.deps.finishSetup();
		} catch (err) {
			this.state.result = "reload";
			this.state.error = explainSetupError(err);
		}
		this.state.busy = null;
		this.changed();
	}

	/** For the screen: set a field by the key used in `Screen.fields`. Unknown keys are ignored. */
	setFieldByKey(key: string, value: string | boolean): void {
		switch (key) {
			case "joinPassphrase": this.setJoinPassphrase(String(value)); return;
			case "clientId": case "clientSecret": case "vaultId": case "passphrase":
			case "passphraseConfirm": case "setupCodeText": case "hostedToken":
				this.setField(key, String(value));
				return;
			case "encrypt": case "riskAccepted": case "existingAccepted": case "manualJoin": case "includePassphrase": case "joinHosted":
				this.setField(key, value === true);
				return;
			default:
		}
	}

	/** The vault this device is set up for right now (shown when the wizard is rerun). */
	stateSummary(): { vaultId: string } {
		return { vaultId: this.deps.getSettings().vaultId };
	}

	async copySetupCode(): Promise<void> {
		if (!this.state.setupCode) return;
		await this.deps.copyText(this.state.setupCode);
		this.state.copied = true;
		this.changed();
	}

	async copyText(text: string): Promise<void> {
		await this.deps.copyText(text);
	}

	open(url: string): void {
		this.deps.openUrl(url);
	}

	reload(): void {
		this.deps.reloadApp?.();
	}
}

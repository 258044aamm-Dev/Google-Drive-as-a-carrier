import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	type SettingDefinition,
	type SettingDefinitionGroup,
	type SettingDefinitionItem,
	type SettingDefinitionPage,
} from "obsidian";
import {
	currentCarrier,
	driveFolderLabel,
	isCarrierKind,
	isDriveCarrier,
	isDriveSignedIn,
	isHostedSignIn,
	type CarrierKind,
} from "../drive-carrier/carrierSettings";
import { checkHostedToken, normalizeHostedToken } from "../drive-carrier/wizard/validate";
import { isDetailedStatusShown, isStatusIconShown } from "../status/simpleStatus";
import { CUSTOM_LIMITS, currentSyncPace, isSyncPaceProfile, resolveCloudflareBatchMs, resolveDrivePace, type SyncPaceCustom, type SyncPaceProfile } from "./syncPace";
import { PairDeviceModal } from "./PairDeviceModal";
import { RecoveryKitModal } from "./RecoveryKitModal";
import {
	attachmentSizeCapKB,
	type ExternalEditPolicy,
	type VaultSyncSettings,
} from "./settingsStore";

type SettingsAuthMode = "env" | "claim" | "unclaimed" | "unknown";
type SettingsStatusState = "disconnected" | "loading" | "syncing" | "connected" | "offline" | "error" | "unauthorized";

type DeclarativeSettingKey =
	| "deviceName"
	| "excludePatterns"
	| "maxFileSizeKB"
	| "enableAttachmentSync"
	| "maxAttachmentSizeKB"
	| "attachmentConcurrency"
	| "showRemoteCursors"
	| "host"
	| "token"
	| "vaultId"
	| "updateRepoUrl"
	| "updateRepoBranch"
	| "externalEditPolicy"
	| "frontmatterGuardEnabled"
	| "debug"
	| "carrier"
	| "syncPace"
	| "drivePaceActive"
	| "drivePaceIdle"
	| "drivePaceHidden"
	| "drivePaceBatch"
	| "drivePaceFullCheck"
	| "cloudflarePaceBatch"
	| "showStatusIcon"
	| "detailedStatus"
	| "driveClientId"
	| "driveClientSecret"
	| "driveHostedToken"
	| "driveEncryptionPassphrase";

interface SettingsUpdateState {
	serverVersion: string | null;
	latestServerVersion: string | null;
	serverUpdateAvailable: boolean;
	pluginVersion: string;
	latestPluginVersion: string | null;
	pluginUpdateRecommended: boolean;
	updateRepoUrl: string | null;
	updateActionUrl: string | null;
	updateBootstrapUrl: string | null;
	legacyServerDetected: boolean;
	pluginCompatibilityWarning: string | null;
}

export interface VaultSyncSettingsHost {
	settings: VaultSyncSettings;
	serverAuthMode: SettingsAuthMode;
	serverSupportsAttachments: boolean;
	serverMaxBlobUploadBytes: number | null;
	updateSettings(mutator: (settings: VaultSyncSettings) => void, reason?: string): Promise<void>;
	refreshServerCapabilities(reason?: string): Promise<void>;
	refreshUpdateManifest(reason?: string, force?: boolean): Promise<void>;
	refreshAttachmentSyncRuntime(reason?: string): Promise<void>;
	getSettingsStatusSummary(): { state: SettingsStatusState; label: string };
	getUpdateState(): SettingsUpdateState;
	buildSetupDeepLink(): string | null;
	buildMobileSetupUrl(): string | null;
	buildRecoveryKitText(): string | null;
	/** Google Drive carrier only. Absent on hosts that do not offer it. */
	signInToDrive?(): Promise<void>;
	signOutOfDrive?(): Promise<void>;
	/** Opens the step-by-step Google Drive setup wizard. */
	openDriveWizard?(): void;
	/** Tells the running carrier to use the new "sync speed" setting right away. */
	applySyncPace?(): void;
	/** Redraws the status bar and adds or removes the header icons after a status display setting changed. */
	applyStatusDisplay?(): void;
}

const CLOUDFLARE_DEPLOY_URL = "https://deploy.workers.cloudflare.com/?url=https://github.com/kavinsood/yaos/tree/main/server";
const ATTACHMENT_SETUP_VIDEO_URL = "https://youtu.be/Z7xCMEYfdFM";
const CARRIER_OPTIONS: Record<CarrierKind, string> = {
	cloudflare: "Cloudflare Worker (default)",
	drive: "Google Drive (experimental)",
};
const SYNC_PACE_OPTIONS: Record<SyncPaceProfile, string> = {
	normal: "Normal (default)",
	gentle: "Gentle (fewer requests)",
	minimal: "Minimal (fewest requests)",
	custom: "Custom",
};
const DRIVE_PACE_KEYS = {
	drivePaceActive: "driveActiveSec",
	drivePaceIdle: "driveIdleSec",
	drivePaceHidden: "driveHiddenSec",
	drivePaceBatch: "driveBatchSec",
	drivePaceFullCheck: "driveFullCheckMin",
} as const satisfies Record<string, keyof SyncPaceCustom>;
const EXTERNAL_EDIT_OPTIONS: Record<ExternalEditPolicy, string> = {
	always: "Always import",
	"closed-only": "Only when file is closed",
	never: "Never import",
};

function isInsecureRemoteHost(host: string): boolean {
	if (!host) return false;
	try {
		const url = new URL(host);
		if (url.protocol !== "http:") return false;
		const hostname = url.hostname;
		return hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "[::1]";
	} catch {
		return false;
	}
}

function isPageDefinition(item: SettingDefinitionItem): item is SettingDefinitionPage {
	return "type" in item && item.type === "page";
}

function isGroupDefinition(item: SettingDefinitionItem): item is SettingDefinitionGroup {
	return "type" in item && item.type === "group";
}

function shortenMiddle(value: string, maxLength = 36): string {
	if (value.length <= maxLength) return value;
	const edge = Math.max(8, Math.floor((maxLength - 3) / 2));
	return `${value.slice(0, edge)}...${value.slice(-edge)}`;
}

function expectStringValue(key: string, value: unknown): string {
	if (typeof value !== "string") throw new TypeError(`${key} must be a string`);
	return value;
}

function expectBooleanValue(key: string, value: unknown): boolean {
	if (typeof value !== "boolean") throw new TypeError(`${key} must be a boolean`);
	return value;
}

function expectFiniteNumber(key: string, value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new TypeError(`${key} must be a finite number`);
	}
	return value;
}

function validatePositiveInteger(value: number): string | void {
	if (!Number.isInteger(value) || value <= 0) return "Enter a positive whole number.";
}

function isExternalEditPolicy(value: string): value is ExternalEditPolicy {
	return value === "always" || value === "closed-only" || value === "never";
}

export class VaultSyncSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		plugin: Plugin,
		private readonly host: VaultSyncSettingsHost,
	) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const setupIncomplete = !this.host.settings.host || !this.host.settings.token;
		const attachmentsAvailable = this.host.serverSupportsAttachments;
		const attachmentCapKB = attachmentSizeCapKB(this.host.serverMaxBlobUploadBytes);
		const syncStatus = this.host.getSettingsStatusSummary();
		const updateState = this.host.getUpdateState();
		const definitions: SettingDefinitionItem[] = [];

		if (setupIncomplete) {
			definitions.push({
				type: "group",
				heading: "Setup",
				items: [
					{
						name: "Setup required",
						desc: "Deploy and claim a free sync server, then open its setup link to configure Yaos.",
					},
					{
						name: "Deploy your server",
						desc: "Open the one-click Cloudflare deployment page.",
						action: () => this.openUrl(CLOUDFLARE_DEPLOY_URL),
					},
				],
			});
		} else {
			const statusItems: SettingDefinition[] = [
				{ name: "Status", desc: syncStatus.label },
				{ name: "Server", desc: this.host.settings.host },
				{ name: "Vault", desc: shortenMiddle(this.host.settings.vaultId || "Not set") },
				{ name: "This device", desc: this.host.settings.deviceName || "Unnamed" },
				{
					name: "Pair another device",
					desc: "Open a setup code and link for another device.",
					action: () => this.openPairing(),
				},
				{
					name: "Back up connection details",
					desc: "Open a recovery kit containing this vault's connection details.",
					action: () => this.openRecoveryKit(),
				},
			];
			definitions.push({ type: "group", heading: "Sync status", items: statusItems });

			const updateSummary = updateState.serverUpdateAvailable
				? "A server update is available."
				: updateState.pluginUpdateRecommended
					? "This device should update the Yaos plugin soon."
					: "Server and plugin are up to date with the latest cached manifest.";
			const updateItems: SettingDefinition[] = [
				{ name: "Server version", desc: updateState.serverVersion ?? "Unknown" },
				{ name: "Latest server", desc: updateState.latestServerVersion ?? "Unknown" },
				{ name: "Plugin version", desc: updateState.pluginVersion },
				{ name: "Latest plugin", desc: updateState.latestPluginVersion ?? "Unknown" },
				{ name: "Update path", desc: updateState.updateRepoUrl ?? "Not configured" },
				{ name: "Update status", desc: updateSummary },
				{
					name: "Compatibility warning",
					desc: updateState.pluginCompatibilityWarning ?? "",
					visible: () => this.host.getUpdateState().pluginCompatibilityWarning !== null,
				},
				{
					name: "Legacy server detected",
					desc: "Sync continues, but update metadata and one-click updates require a newer server.",
					visible: () => this.host.getUpdateState().legacyServerDetected,
				},
				{
					name: "Refresh update information",
					desc: "Fetch current server capabilities and release metadata.",
					action: () => { void this.refreshUpdateInformation(); },
				},
				{
					name: "Open update action",
					desc: "Open the deployment repository's update workflow.",
					visible: () => this.host.getUpdateState().updateActionUrl !== null,
					action: () => this.openCurrentUpdateAction(),
				},
				{
					name: "Initialize updater",
					desc: "Create the deployment repository's update workflow.",
					visible: () => this.host.getUpdateState().updateBootstrapUrl !== null,
					action: () => this.openCurrentUpdaterBootstrap(),
				},
			];
			definitions.push({ type: "group", heading: "Updates", items: updateItems });
		}

		definitions.push(
			{
				type: "group",
				heading: "This device",
				items: [
					{
						name: "Device name",
						desc: "Shown to other devices in live cursors and presence.",
						control: { type: "text", key: "deviceName", placeholder: "My laptop" },
					},
				],
			},
			{
				type: "group",
				heading: "What syncs",
				items: [
					{
						name: "Exclude paths",
						desc: "Comma-separated path prefixes to skip, such as templates/, .trash/, or daily-notes/.",
						control: { type: "text", key: "excludePatterns", placeholder: "templates/, daily-notes/" },
					},
					{
						name: "Maximum text file size in kilobytes",
						desc: "Text files larger than this are skipped for live document sync.",
						control: {
							type: "number",
							key: "maxFileSizeKB",
							min: 1,
							step: 1,
							validate: validatePositiveInteger,
						},
					},
				],
			},
		);

		const attachmentItems: SettingDefinition[] = [
			{
				name: "Attachment storage",
				desc: attachmentsAvailable
					? "Available on this server. The plugin can sync attachments and snapshots."
					: "Unavailable on this server. Add object storage in Cloudflare, then redeploy.",
			},
			{
				name: "Refresh attachment capability",
				desc: "Refresh server capabilities and the attachment sync runtime.",
				visible: () => Boolean(this.host.settings.host),
				action: () => { void this.refreshAttachmentCapability(); },
			},
			{
				name: "Set up attachment storage",
				desc: "Open the one-minute attachment storage setup video.",
				visible: () => Boolean(this.host.settings.host) && !this.host.serverSupportsAttachments,
				action: () => this.openUrl(ATTACHMENT_SETUP_VIDEO_URL),
			},
			{
				name: "Sync attachments",
				desc: "Sync images, PDF files, and other attachments through object storage.",
				visible: () => this.host.serverSupportsAttachments || !this.host.settings.host,
				control: { type: "toggle", key: "enableAttachmentSync" },
			},
			{
				name: "Maximum attachment size in kilobytes",
				desc: `Attachments larger than this are skipped. Maximum ${attachmentCapKB} KB.`,
				visible: () =>
					(this.host.serverSupportsAttachments || !this.host.settings.host)
					&& this.host.settings.enableAttachmentSync,
				control: {
					type: "number",
					key: "maxAttachmentSizeKB",
					min: 1,
					max: attachmentCapKB,
					step: 1,
					validate: (value) => {
						const integerError = validatePositiveInteger(value);
						if (integerError) return integerError;
						if (value > attachmentCapKB) return `Enter ${attachmentCapKB} or less.`;
						return undefined;
					},
				},
			},
			{
				name: "Parallel transfers",
				desc: "One transfer at a time favors reliability on slow or mobile networks.",
				visible: () =>
					(this.host.serverSupportsAttachments || !this.host.settings.host)
					&& this.host.settings.enableAttachmentSync,
				control: {
					type: "slider",
					key: "attachmentConcurrency",
					min: 1,
					max: 5,
					step: 1,
					displayFormat: (value) => String(value),
				},
			},
		];
		definitions.push({ type: "group", heading: "Attachments", items: attachmentItems });

		definitions.push({
			type: "group",
			heading: "Collaboration",
			items: [
				{
					name: "Show remote cursors",
					desc: "Show other devices' cursors and selections while editing.",
					control: { type: "toggle", key: "showRemoteCursors" },
				},
			],
		});

		definitions.push(
			{
				type: "page",
				name: "Manual connection",
				desc: "View or change this vault's server connection.",
				displayValue: () => this.host.settings.host || "Not configured",
				status: () => (!this.host.settings.host || !this.host.settings.token ? "warning" : null),
				items: [
					{
						name: "Server URL",
						desc: "Usually filled automatically by the setup flow.",
						control: { type: "text", key: "host", placeholder: "Paste the server URL" },
					},
					{
						name: "Unencrypted connection",
						desc: "This remote connection sends the sync token in plaintext. Use HTTPS for production.",
						visible: () => isInsecureRemoteHost(this.host.settings.host),
					},
					{
						name: "Sync token",
						desc: this.tokenDescription(),
						control: { type: "text", key: "token", placeholder: "Paste your sync token" },
					},
				],
			},
			{
				type: "page",
				name: "Advanced",
				desc: "Vault identity, deployment metadata, external edits, safety, and diagnostics.",
				items: [
					{
						name: "Vault ID",
						desc: "Devices syncing the same vault must use exactly the same vault ID.",
						control: { type: "text", key: "vaultId", placeholder: "Generated automatically" },
					},
					{
						name: "Deployment repository URL",
						desc: "Optional. The provider is inferred from this URL.",
						control: { type: "text", key: "updateRepoUrl", placeholder: "Paste the GitHub or GitLab repository URL" },
					},
					{
						name: "Deployment default branch",
						desc: "Used for GitLab pipeline links and provider-native update helpers.",
						control: { type: "text", key: "updateRepoBranch", placeholder: "main" },
					},
					{
						name: "Edits from other apps",
						desc: "Choose how file changes from Git, scripts, or other editors enter sync.",
						control: { type: "dropdown", key: "externalEditPolicy", options: EXTERNAL_EDIT_OPTIONS },
					},
					{
						name: "Frontmatter safety guard",
						desc: "Pause suspicious YAML property updates before they spread.",
						control: { type: "toggle", key: "frontmatterGuardEnabled" },
					},
					{
						name: "Debug mode",
						desc: "Record detailed sync events for an exportable diagnostics trace. Leave off for everyday use.",
						control: { type: "toggle", key: "debug" },
					},
					{
						name: "Reload required",
						desc: "Changing the server URL, sync token, or vault ID requires reloading the plugin.",
						searchable: false,
					},
				],
			},
		);

		return this.applyCarrierChoice(definitions);
	}

	/**
	 * The carrier choice is added to the finished list instead of being woven
	 * into it, so the Cloudflare screens above stay as they were. It shows up
	 * where the user is deciding how to sync:
	 *  - before a server is set up: in the Setup group, right above "Deploy your server";
	 *  - with the Drive carrier: in the Drive group, so it is easy to switch back;
	 *  - with a configured server: in Advanced (nobody is choosing anymore).
	 * With the Drive carrier the server-only screens are replaced by the Drive one.
	 */
	private applyCarrierChoice(definitions: SettingDefinitionItem[]): SettingDefinitionItem[] {
		return this.withStatusRows(this.applyCarrierChoiceRows(definitions));
	}

	/** Two switches for the status display, in Advanced for every carrier, just above the "Reload required" note. */
	private withStatusRows(definitions: SettingDefinitionItem[]): SettingDefinitionItem[] {
		const rows: SettingDefinition[] = [
			{
				name: "Status icon in the note header",
				desc: "A small icon at the top of each note that shows whether syncing is working. Also available on phones. Click it for details.",
				control: { type: "toggle", key: "showStatusIcon" },
			},
			{
				name: "Detailed status text",
				desc: "Show the long technical text in the bottom bar instead of a few simple words. The details are always available when you hover over the status.",
				control: { type: "toggle", key: "detailedStatus" },
			},
		];
		return definitions.map((item) => {
			if (!isPageDefinition(item) || item.name !== "Advanced" || !item.items) return item;
			const items = [...item.items];
			const note = items.findIndex((entry) => "name" in entry && entry.name === "Reload required");
			items.splice(note >= 0 ? note : items.length, 0, ...rows);
			return { ...item, items };
		});
	}

	private applyCarrierChoiceRows(definitions: SettingDefinitionItem[]): SettingDefinitionItem[] {
		const carrierRow: SettingDefinition = {
			name: "Sync carrier (experimental)",
			desc: "Where your notes are exchanged between devices. Changing it needs a reload of the plugin. Google Drive needs no server, but changes arrive in a few seconds instead of instantly.",
			control: { type: "dropdown", key: "carrier", options: CARRIER_OPTIONS },
		};
		const drive = isDriveCarrier(this.host.settings);
		const isSetupGroup = (item: SettingDefinitionItem): item is SettingDefinitionGroup =>
			isGroupDefinition(item) && item.heading === "Setup";
		const carrierInAdvanced = (item: SettingDefinitionItem): SettingDefinitionItem => {
			if (!isPageDefinition(item) || item.name !== "Advanced" || !item.items) return item;
			// A configured server only: the speed rows go just above the "Reload required" note.
			const items = [carrierRow, ...item.items];
			const note = items.findIndex((entry) => "name" in entry && entry.name === "Reload required");
			items.splice(note >= 0 ? note : items.length, 0, ...this.cloudflarePaceRows());
			return { ...item, items };
		};
		const carrierInSetup = (item: SettingDefinitionItem): SettingDefinitionItem => {
			if (!isSetupGroup(item)) return item;
			const items = [...(item.items ?? [])];
			const deploy = items.findIndex((entry) => "name" in entry && entry.name === "Deploy your server");
			items.splice(deploy >= 0 ? deploy : items.length, 0, carrierRow);
			return { ...item, items };
		};
		if (!drive) {
			return definitions.map(definitions.some(isSetupGroup) ? carrierInSetup : carrierInAdvanced);
		}

		const withoutServerRows = (item: SettingDefinitionItem): SettingDefinitionItem => {
			if (!isPageDefinition(item) || item.name !== "Advanced" || !item.items) return item;
			// "Vault ID" moved to the manual setup page, so it is not shown twice.
			const serverOnly = new Set(["Deployment repository URL", "Deployment default branch", "Vault ID"]);
			const items = item.items
				.filter((entry) => !("name" in entry && typeof entry.name === "string" && serverOnly.has(entry.name)))
				.map((entry) => "name" in entry && entry.name === "Reload required" && !("items" in entry)
					? { ...entry, desc: "Changing the sync carrier, the vault ID, or the encryption passphrase requires reloading the plugin." }
					: entry);
			return { ...item, desc: "External edits, safety checks and diagnostics.", items };
		};
		// "This device" only holds the device name, which is shown in live cursors; Drive mode has none.
		const serverOnlyGroups = new Set(["Setup", "Sync status", "Updates", "Collaboration", "This device"]);
		const kept = definitions.filter((item) => {
			if (isGroupDefinition(item) && typeof item.heading === "string") {
				return !serverOnlyGroups.has(item.heading);
			}
			if (isPageDefinition(item) && item.name === "Manual connection") return false;
			return true;
		});
		const rest = kept.map(withoutServerRows).map((item) => this.withDriveAttachmentText(item));
		const advanced = rest.findIndex((item) => isPageDefinition(item) && item.name === "Advanced");
		rest.splice(advanced >= 0 ? advanced : rest.length, 0, this.driveManualPage());
		return [...this.driveDefinitions(carrierRow), ...rest];
	}

	/** Attachments and snapshots live on Drive: the server wording is replaced and the server-only rows are removed. */
	private withDriveAttachmentText(item: SettingDefinitionItem): SettingDefinitionItem {
		if (!isGroupDefinition(item) || item.heading !== "Attachments") return item;
		const folder = `YAOS ${this.host.settings.vaultId || "..."} blobs`;
		const serverRows = new Set(["Refresh attachment capability", "Set up attachment storage"]);
		const items = (item.items ?? []).filter((entry) => !("name" in entry && typeof entry.name === "string" && serverRows.has(entry.name))).map((entry) => {
			if ("name" in entry && entry.name === "Attachment storage" && !("items" in entry)) {
				return { ...entry, desc: `Stored in your Google Drive (folder "${folder}"). Snapshots are kept there too.` };
			}
			return entry;
		});
		return { ...item, items };
	}

	private async runDriveAction(action: () => Promise<void> | undefined): Promise<void> {
		await action();
		this.update();
	}

	/**
	 * The Drive screen for beginners: status, the way of syncing, the guided
	 * setup and sign out. Everything that has to be typed by hand lives on the
	 * "Manual setup (advanced)" page (see `driveManualPage`).
	 */
	private driveDefinitions(carrierRow: SettingDefinition): SettingDefinitionItem[] {
		const settings = this.host.settings;
		const signedIn = isDriveSignedIn(settings);
		const status = this.host.getSettingsStatusSummary();
		return [
			{
				type: "group",
				heading: "Google Drive carrier",
				items: [
					{
						name: "Status",
						desc: signedIn
							? status.label + (isHostedSignIn(settings) ? " Signed in with the easy sign-in." : "")
							: "Not signed in. Press \"Set up Google Drive\" below for a step-by-step guide. To enter the details by hand, open \"Manual setup (advanced)\".",
					},
					carrierRow,
					{
						name: "Set up Google Drive",
						desc: "A short step-by-step guide: connect to Google, choose encryption, then create your vault or join one you already have.",
						visible: () => typeof this.host.openDriveWizard === "function",
						action: () => { this.host.openDriveWizard?.(); },
					},
					{
						name: "Sign out",
						desc: "Forget the Google sign-in on this device. Your notes on Drive stay where they are.",
						visible: () => isDriveSignedIn(this.host.settings),
						action: () => { void this.runDriveAction(() => this.host.signOutOfDrive?.()); },
					},
				],
			},
			{
				type: "group",
				heading: "Sync speed (Google Drive)",
				items: [
					{
						name: "Sync speed",
						desc: "How often YAOS asks Google Drive for changes. Normal is the default. If Google reports too many requests, choose Gentle or Minimal: changes then arrive a little later, and nothing else changes.",
						control: { type: "dropdown", key: "syncPace", options: SYNC_PACE_OPTIONS },
					},
					{
						name: "Current speed",
						desc: this.describeDrivePace(),
						visible: () => currentSyncPace(this.host.settings) !== "custom",
					},
					...this.drivePaceCustomRows(),
				],
			},
		];
	}

	/** Cloudflare has a live connection (nothing to poll), so its only speed control is how long edits are gathered before sending. */
	private cloudflarePaceRows(): SettingDefinition[] {
		const ms = resolveCloudflareBatchMs(this.host.settings);
		const now = ms === 0 ? "Every edit is sent at once." : `Edits are gathered for ${ms / 1000} s and sent together.`;
		const limit = CUSTOM_LIMITS.cloudflareBatchSec;
		return [
			{
				name: "Sync speed (Cloudflare)",
				desc: `Normal sends every edit at once (default). If your Cloudflare plan reports too many requests, choose Gentle or Minimal to send your edits in groups: a few seconds later for other devices, far fewer messages. Receiving is not affected. ${now}`,
				control: { type: "dropdown", key: "syncPace", options: SYNC_PACE_OPTIONS },
			},
			{
				name: "Group edits for (seconds)",
				desc: `Custom only. Allowed: 0 (send at once) or ${limit.min} to ${limit.max}.`,
				visible: () => currentSyncPace(this.host.settings) === "custom",
				control: {
					type: "number",
					key: "cloudflarePaceBatch",
					min: 0,
					step: 1,
					validate: (value) => {
						if (!Number.isInteger(value)) return "Enter a whole number.";
						if (value !== 0 && (value < limit.min || value > limit.max)) return `Enter 0 or a number from ${limit.min} to ${limit.max}.`;
						return undefined;
					},
				},
			},
		];
	}

	/** One plain sentence about the speed that is in effect now. */
	private describeDrivePace(): string {
		const pace = resolveDrivePace(this.host.settings, false);
		const s = (ms: number) => `${Math.round(ms / 1000)} s`;
		const hidden = pace.backgroundPollIntervalMs === 0 ? "paused while hidden" : `every ${s(pace.backgroundPollIntervalMs)} while hidden`;
		return `Checks Drive every ${s(pace.pollIntervalMs)} while you work, every ${s(pace.idlePollIntervalMs)} when idle, ${hidden}. Edits are uploaded in groups every ${s(pace.batchMs)}. On a phone, checks pause while the app is in the background.`;
	}

	private drivePaceCustomRows(): SettingDefinition[] {
		const custom = () => currentSyncPace(this.host.settings) === "custom";
		const row = (
			name: string,
			desc: string,
			key: keyof typeof DRIVE_PACE_KEYS,
			limit: { min: number; max: number },
			allowZero = false,
		): SettingDefinition => ({
			name,
			desc: `${desc} Allowed: ${allowZero ? "0 or " : ""}${limit.min} to ${limit.max}. Smaller values are not allowed, because that would be faster than the default.`,
			visible: custom,
			control: {
				type: "number",
				key,
				min: allowZero ? 0 : limit.min,
				step: 1,
				validate: (value) => {
					if (!Number.isInteger(value)) return "Enter a whole number.";
					if (allowZero && value === 0) return undefined;
					if (value < limit.min || value > limit.max) return `Enter ${allowZero ? "0 or " : ""}a number from ${limit.min} to ${limit.max}.`;
					return undefined;
				},
			},
		});
		return [
			row("Check while working (seconds)", "How often to ask Drive for changes while you are using Obsidian. Default 3.", "drivePaceActive", CUSTOM_LIMITS.driveActiveSec),
			row("Check when idle (seconds)", "How often to ask after a minute without activity. Default 30.", "drivePaceIdle", CUSTOM_LIMITS.driveIdleSec),
			row("Check while hidden (seconds)", "How often to ask while the window is hidden. 0 pauses until you come back. Default 120 on a computer; phones always pause.", "drivePaceHidden", CUSTOM_LIMITS.driveHiddenSec, true),
			row("Group edits for (seconds)", "Your edits are gathered for this long and uploaded together. Default 2.", "drivePaceBatch", CUSTOM_LIMITS.driveBatchSec),
			row("Full check every (minutes)", "How often to compare everything with Drive, as a safety net. Default 5.", "drivePaceFullCheck", CUSTOM_LIMITS.driveFullCheckMin),
		];
	}

	/** Everything the wizard fills in, for people who join by hand or need to repair a sign-in. */
	private driveManualPage(): SettingDefinitionPage {
		const settings = this.host.settings;
		const signedIn = isDriveSignedIn(settings);
		return {
			type: "page",
			name: "Manual setup (advanced)",
			desc: "The details the setup guide fills in for you: vault ID, Google sign-in and encryption passphrase. Only needed to join by hand or to repair a sign-in.",
			displayValue: () => (isDriveSignedIn(this.host.settings) ? "Signed in" : "Not signed in"),
			status: () => (isDriveSignedIn(this.host.settings) ? null : "warning"),
			items: [
				{
					name: "Vault ID",
					desc: `Every device that syncs this vault must use exactly this ID. Your notes are in the Google Drive folder "${driveFolderLabel(settings.vaultId || "Not set")}". Reload the plugin after changing it.`,
					control: { type: "text", key: "vaultId", placeholder: "Generated automatically" },
				},
				{
					name: "Google client ID",
					desc: "From your own Google Cloud project: an OAuth client of type \"TVs and limited-input devices\".",
					control: { type: "text", key: "driveClientId", placeholder: "Paste the client ID" },
					visible: () => !isHostedSignIn(this.host.settings),
				},
				{
					name: "Google client secret",
					desc: "From the same OAuth client. Stored only in this vault's plugin data.",
					control: { type: "text", key: "driveClientSecret", placeholder: "Paste the client secret" },
					visible: () => !isHostedSignIn(this.host.settings),
				},
				{
					name: "Sign-in code (easy sign-in)",
					desc: "Only shown for the easy sign-in. If sync says access was lost, sign in again at https://ogd.richardxiong.com and paste the new code here, then reload the plugin.",
					visible: () => isHostedSignIn(this.host.settings),
					control: { type: "text", key: "driveHostedToken", placeholder: "Paste the sign-in code" },
				},
				{
					name: "Encryption passphrase",
					desc: "Optional. Encrypts everything YAOS stores on Drive. Set it before the first sync of a new vault and use the same passphrase on every device; it cannot be added to a vault that already exists on Drive, and a lost passphrase cannot be recovered. Reload the plugin after changing it.",
					control: { type: "text", key: "driveEncryptionPassphrase", placeholder: "Leave empty for no encryption" },
				},
				{
					name: signedIn ? "Signed in to Google" : "Sign in with Google",
					desc: signedIn
						? "Sign in again if sync reports that access was lost."
						: "Shows a short code to enter at google.com/device. Only files created by YAOS are accessible.",
					// The easy sign-in is renewed with the sign-in code above; this button only does Google's own sign-in.
					visible: () => !isHostedSignIn(this.host.settings),
					action: () => { void this.runDriveAction(() => this.host.signInToDrive?.()); },
				},
			],
		};
	}

	getControlValue(key: string): unknown {
		switch (key as DeclarativeSettingKey) {
			case "deviceName": return this.host.settings.deviceName;
			case "excludePatterns": return this.host.settings.excludePatterns;
			case "maxFileSizeKB": return this.host.settings.maxFileSizeKB;
			case "enableAttachmentSync": return this.host.settings.enableAttachmentSync;
			case "maxAttachmentSizeKB": return this.host.settings.maxAttachmentSizeKB;
			case "attachmentConcurrency": return this.host.settings.attachmentConcurrency;
			case "showRemoteCursors": return this.host.settings.showRemoteCursors;
			case "host": return this.host.settings.host;
			case "token": return this.host.settings.token;
			case "vaultId": return this.host.settings.vaultId;
			case "updateRepoUrl": return this.host.settings.updateRepoUrl;
			case "updateRepoBranch": return this.host.settings.updateRepoBranch;
			case "externalEditPolicy": return this.host.settings.externalEditPolicy;
			case "frontmatterGuardEnabled": return this.host.settings.frontmatterGuardEnabled;
			case "debug": return this.host.settings.debug;
			case "carrier": return currentCarrier(this.host.settings);
			case "syncPace": return currentSyncPace(this.host.settings);
			case "cloudflarePaceBatch": return this.host.settings.syncPaceCustom?.cloudflareBatchSec ?? 0;
			case "showStatusIcon": return isStatusIconShown(this.host.settings);
			case "detailedStatus": return isDetailedStatusShown(this.host.settings);
			case "drivePaceActive":
			case "drivePaceIdle":
			case "drivePaceHidden":
			case "drivePaceBatch":
			case "drivePaceFullCheck": {
				// Show the number that is in effect, so switching to Custom starts from the current speed.
				const pace = resolveDrivePace({ syncPace: "custom", syncPaceCustom: this.host.settings.syncPaceCustom }, false);
				const shown = {
					drivePaceActive: pace.pollIntervalMs / 1000,
					drivePaceIdle: pace.idlePollIntervalMs / 1000,
					drivePaceHidden: pace.backgroundPollIntervalMs / 1000,
					drivePaceBatch: pace.batchMs / 1000,
					drivePaceFullCheck: pace.reconcileIntervalMs / 60_000,
				};
				return shown[key as keyof typeof shown];
			}
			case "driveClientId": return this.host.settings.driveClientId ?? "";
			case "driveClientSecret": return this.host.settings.driveClientSecret ?? "";
			case "driveHostedToken": return this.host.settings.driveRefreshToken ?? "";
			case "driveEncryptionPassphrase": return this.host.settings.driveEncryptionPassphrase ?? "";
			default: throw new Error(`Unknown Yaos setting: ${key}`);
		}
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		switch (key as DeclarativeSettingKey) {
			case "deviceName":
				await this.host.updateSettings((settings) => {
					settings.deviceName = expectStringValue(key, value).trim();
				}, "settings:device-name");
				return;
			case "excludePatterns":
				await this.host.updateSettings((settings) => {
					settings.excludePatterns = expectStringValue(key, value);
				}, "settings:exclude-patterns");
				return;
			case "maxFileSizeKB": {
				const nextValue = expectFiniteNumber(key, value);
				if (validatePositiveInteger(nextValue)) throw new RangeError("maxFileSizeKB must be a positive integer");
				await this.host.updateSettings((settings) => { settings.maxFileSizeKB = nextValue; }, "settings:max-file-size");
				return;
			}
			case "enableAttachmentSync":
				await this.host.updateSettings((settings) => {
					settings.enableAttachmentSync = expectBooleanValue(key, value);
					settings.attachmentSyncExplicitlyConfigured = true;
				}, "settings:attachment-toggle");
				await this.host.refreshAttachmentSyncRuntime("attachment-toggle");
				this.update();
				return;
			case "maxAttachmentSizeKB": {
				const nextValue = expectFiniteNumber(key, value);
				const cap = attachmentSizeCapKB(this.host.serverMaxBlobUploadBytes);
				if (validatePositiveInteger(nextValue) || nextValue > cap) {
					throw new RangeError(`maxAttachmentSizeKB must be an integer between 1 and ${cap}`);
				}
				await this.host.updateSettings((settings) => { settings.maxAttachmentSizeKB = nextValue; }, "settings:max-attachment-size");
				return;
			}
			case "attachmentConcurrency": {
				const nextValue = expectFiniteNumber(key, value);
				if (!Number.isInteger(nextValue) || nextValue < 1 || nextValue > 5) {
					throw new RangeError("attachmentConcurrency must be an integer between 1 and 5");
				}
				await this.host.updateSettings((settings) => { settings.attachmentConcurrency = nextValue; }, "settings:attachment-concurrency");
				return;
			}
			case "showRemoteCursors":
				await this.host.updateSettings((settings) => {
					settings.showRemoteCursors = expectBooleanValue(key, value);
				}, "settings:remote-cursors");
				return;
			case "host":
				await this.host.updateSettings((settings) => { settings.host = expectStringValue(key, value).trim(); }, "settings:host");
				this.update();
				return;
			case "token":
				await this.host.updateSettings((settings) => { settings.token = expectStringValue(key, value).trim(); }, "settings:token");
				this.update();
				return;
			case "vaultId":
				await this.host.updateSettings((settings) => { settings.vaultId = expectStringValue(key, value).trim(); }, "settings:vault-id");
				this.update();
				return;
			case "updateRepoUrl":
				await this.host.updateSettings((settings) => { settings.updateRepoUrl = expectStringValue(key, value).trim(); }, "settings:update-repo-url");
				return;
			case "updateRepoBranch":
				await this.host.updateSettings((settings) => {
					settings.updateRepoBranch = expectStringValue(key, value).trim() || "main";
				}, "settings:update-repo-branch");
				return;
			case "externalEditPolicy": {
				const nextValue = expectStringValue(key, value);
				if (!isExternalEditPolicy(nextValue)) throw new RangeError(`Unsupported external edit policy: ${nextValue}`);
				await this.host.updateSettings((settings) => { settings.externalEditPolicy = nextValue; }, "settings:external-edit-policy");
				return;
			}
			case "frontmatterGuardEnabled":
				await this.host.updateSettings((settings) => {
					settings.frontmatterGuardEnabled = expectBooleanValue(key, value);
				}, "settings:frontmatter-guard");
				return;
			case "debug":
				await this.host.updateSettings((settings) => {
					settings.debug = expectBooleanValue(key, value);
				}, "settings:debug");
				return;
			case "carrier": {
				const nextValue = expectStringValue(key, value);
				if (!isCarrierKind(nextValue)) throw new RangeError(`Unsupported sync carrier: ${nextValue}`);
				await this.host.updateSettings((settings) => { settings.carrier = nextValue; }, "settings:carrier");
				new Notice("Reload the plugin (or restart Obsidian) to switch the sync carrier.", 8000);
				this.update();
				// Choosing Drive for the first time: walk the user through the rest.
				if (nextValue === "drive" && !isDriveSignedIn(this.host.settings)) this.host.openDriveWizard?.();
				return;
			}
			case "syncPace": {
				const nextValue = expectStringValue(key, value);
				if (!isSyncPaceProfile(nextValue)) throw new RangeError(`Unsupported sync speed: ${nextValue}`);
				await this.host.updateSettings((settings) => {
					// "normal" is stored as "nothing set", exactly like a vault that never touched this.
					if (nextValue === "normal") delete settings.syncPace;
					else settings.syncPace = nextValue;
				}, "settings:sync-pace");
				this.host.applySyncPace?.();
				this.update();
				return;
			}
			case "showStatusIcon": {
				const on = expectBooleanValue(key, value);
				// On is the default, so it is stored as "nothing set".
				await this.host.updateSettings((settings) => {
					if (on) delete settings.showStatusIcon;
					else settings.showStatusIcon = false;
				}, "settings:status-icon");
				this.host.applyStatusDisplay?.();
				return;
			}
			case "detailedStatus": {
				const on = expectBooleanValue(key, value);
				await this.host.updateSettings((settings) => {
					if (on) settings.detailedStatus = true;
					else delete settings.detailedStatus;
				}, "settings:detailed-status");
				this.host.applyStatusDisplay?.();
				return;
			}
			case "cloudflarePaceBatch": {
				const nextValue = expectFiniteNumber(key, value);
				const limit = CUSTOM_LIMITS.cloudflareBatchSec;
				if (!Number.isInteger(nextValue) || !(nextValue === 0 || (nextValue >= limit.min && nextValue <= limit.max))) {
					throw new RangeError(`cloudflareBatchSec must be 0 or a whole number from ${limit.min} to ${limit.max}`);
				}
				await this.host.updateSettings((settings) => {
					settings.syncPaceCustom = { ...settings.syncPaceCustom, cloudflareBatchSec: nextValue };
				}, "settings:sync-pace-custom");
				this.host.applySyncPace?.();
				this.update();
				return;
			}
			case "drivePaceActive":
			case "drivePaceIdle":
			case "drivePaceHidden":
			case "drivePaceBatch":
			case "drivePaceFullCheck": {
				const nextValue = expectFiniteNumber(key, value);
				const field = DRIVE_PACE_KEYS[key as keyof typeof DRIVE_PACE_KEYS];
				const limit = CUSTOM_LIMITS[field];
				const zeroOk = field === "driveHiddenSec";
				if (!Number.isInteger(nextValue) || !((zeroOk && nextValue === 0) || (nextValue >= limit.min && nextValue <= limit.max))) {
					throw new RangeError(`${field} must be ${zeroOk ? "0 or " : ""}a whole number from ${limit.min} to ${limit.max}`);
				}
				await this.host.updateSettings((settings) => {
					settings.syncPaceCustom = { ...settings.syncPaceCustom, [field]: nextValue };
				}, "settings:sync-pace-custom");
				this.host.applySyncPace?.();
				return;
			}
			case "driveClientId":
				await this.host.updateSettings((settings) => { settings.driveClientId = expectStringValue(key, value).trim(); }, "settings:drive-client-id");
				this.update();
				return;
			case "driveClientSecret":
				await this.host.updateSettings((settings) => { settings.driveClientSecret = expectStringValue(key, value).trim(); }, "settings:drive-client-secret");
				this.update();
				return;
			case "driveHostedToken": {
				const pasted = normalizeHostedToken(expectStringValue(key, value));
				if (pasted && checkHostedToken(pasted)) {
					new Notice("That does not look like a sign-in code. Copy all of it from the sign-in page.", 8000);
					return;
				}
				await this.host.updateSettings((settings) => { settings.driveRefreshToken = pasted; }, "settings:drive-hosted-token");
				this.update();
				return;
			}
			case "driveEncryptionPassphrase":
				await this.host.updateSettings((settings) => { settings.driveEncryptionPassphrase = expectStringValue(key, value); }, "settings:drive-encryption-passphrase");
				this.update();
				return;
			default:
				throw new Error(`Unknown Yaos setting: ${key}`);
		}
	}

	private tokenDescription(): string {
		switch (this.host.serverAuthMode) {
			case "unclaimed":
				return "Leave blank until you claim the server, then use its setup link.";
			case "env":
				return "Must match the SYNC_TOKEN configured on the server.";
			default:
				return "Usually filled automatically by the setup link after you claim the server.";
		}
	}

	private openPairing(): void {
		const deepLink = this.host.buildSetupDeepLink();
		const mobileUrl = this.host.buildMobileSetupUrl();
		if (!deepLink || !mobileUrl) {
			new Notice("Configure the server URL, sync token, and vault ID before pairing.", 7000);
			return;
		}
		new PairDeviceModal(this.app, deepLink, mobileUrl).open();
	}

	private openRecoveryKit(): void {
		const recoveryKit = this.host.buildRecoveryKitText();
		if (!recoveryKit) {
			new Notice("Configure the server URL, sync token, and vault ID before exporting connection details.", 7000);
			return;
		}
		new RecoveryKitModal(this.app, recoveryKit).open();
	}

	private async refreshUpdateInformation(): Promise<void> {
		await this.host.refreshServerCapabilities("settings-refresh");
		await this.host.refreshUpdateManifest("settings-refresh", true);
		this.update();
	}

	private async refreshAttachmentCapability(): Promise<void> {
		await this.host.refreshServerCapabilities("settings-attachment-refresh");
		await this.host.refreshAttachmentSyncRuntime("capability-refresh");
		this.update();
	}

	private openCurrentUpdateAction(): void {
		const url = this.host.getUpdateState().updateActionUrl;
		if (url) this.openUrl(url);
	}

	private openCurrentUpdaterBootstrap(): void {
		const url = this.host.getUpdateState().updateBootstrapUrl;
		if (url) this.openUrl(url);
	}

	private openUrl(url: string): void {
		window.open(url, "_blank", "noopener");
	}
}

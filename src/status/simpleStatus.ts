import type { ConnectionState } from "../runtime/connectionController";
import type { ServerReceiptStatus, SyncStatus } from "./statusBarController";

/**
 * A plain-language status for people who just want to know "is it working?".
 *
 * The detailed labels in `statusBarController.ts` stay as they are (they are
 * still available behind a setting and in the tooltip). This module only
 * boils the same facts down to one of five levels and a few words.
 */

export type SimpleStatusLevel = "ok" | "busy" | "offline" | "attention" | "error";

export interface SimpleStatus {
	level: SimpleStatusLevel;
	/** One to three words, for the bottom bar and the icon tooltip. */
	text: string;
	/** One short sentence saying what it means and, if needed, what to do. */
	detail: string;
}

/** Settings read by the display. Absent = the default shown in the comment. */
export interface StatusDisplaySettings {
	/** Show the status icon in the header of each note. Absent = true. */
	showStatusIcon?: boolean;
	/** Show the long technical text in the bottom bar. Absent = false (the short text). */
	detailedStatus?: boolean;
}

export function isStatusIconShown(settings: StatusDisplaySettings): boolean {
	return settings.showStatusIcon !== false;
}

export function isDetailedStatusShown(settings: StatusDisplaySettings): boolean {
	return settings.detailedStatus === true;
}

export interface SimpleStatusInput {
	/** The rich state when the connection controller exists. */
	state: ConnectionState | undefined;
	/** Used only when `state` is missing (very early start-up). */
	coarse: SyncStatus;
	/** Files that need a look (kept copies, conflicts). */
	attentionCount: number;
	/** "↑1 ↓2" style text while attachments move. */
	transferStatus?: string | null;
	receipt?: ServerReceiptStatus | null;
}

const OFFLINE_DETAIL = "No connection. Your edits are saved on this device and will sync when you are back online.";

export function toSimpleStatus(input: SimpleStatusInput): SimpleStatus {
	const { state, coarse, attentionCount, transferStatus, receipt } = input;
	const kind = state?.kind ?? coarseKind(coarse);

	// Things the user has to act on come first.
	if (kind === "auth_failed" || kind === "unauthorized") {
		return { level: "error", text: "Sign-in problem", detail: "This device is not allowed to sync. Open the YAOS settings and check the sign-in details." };
	}
	if (kind === "server_update_required" || kind === "error") {
		return { level: "error", text: "Update needed", detail: "Sync stopped because this plugin or the server is out of date. Open the YAOS settings." };
	}
	if (receipt?.serverPersistenceDegraded === true) {
		return { level: "attention", text: "Not saving", detail: "The server is not saving changes. Edits still reach your open devices, but avoid bulk edits until this clears." };
	}
	if (attentionCount > 0) {
		const files = `${attentionCount} file${attentionCount === 1 ? "" : "s"}`;
		return { level: "attention", text: `Check ${files}`, detail: `${files} need${attentionCount === 1 ? "s" : ""} a look. Sync kept a copy instead of overwriting something.` };
	}
	if (kind === "offline") return { level: "offline", text: "Offline", detail: OFFLINE_DETAIL };
	if (kind === "disconnected") return { level: "offline", text: "Not connected", detail: "Sync is not connected yet." };
	if (kind === "loading_cache" || kind === "connecting" || kind === "loading" || kind === "syncing") {
		return { level: "busy", text: "Connecting…", detail: "Getting ready to sync." };
	}
	// Connected from here on.
	if (transferStatus) return { level: "busy", text: "Syncing…", detail: "Sending or receiving attachments." };
	if (receipt?.serverAppliedLocalState === false) {
		return { level: "busy", text: "Syncing…", detail: "Your latest edit is on its way." };
	}
	return { level: "ok", text: "Synced", detail: "Everything is up to date." };
}

function coarseKind(state: SyncStatus): string {
	return state === "connected" ? "online" : state;
}

/** Icons that exist in every Obsidian version; the shapes differ so colour is not the only cue. */
export const STATUS_ICONS: Record<SimpleStatusLevel, string> = {
	ok: "check",
	busy: "refresh-cw",
	offline: "cloud-off",
	attention: "alert-triangle",
	error: "alert-circle",
};

const LEVELS: readonly SimpleStatusLevel[] = ["ok", "busy", "offline", "attention", "error"];

/** The part of the status bar element this needs (Obsidian's `HTMLElement` satisfies it). */
export interface StatusBarElement {
	setText(text: string): void;
	setAttr(name: string, value: string): void;
	toggleClass(cls: string, value: boolean): void;
}

/** Draw the short text. The long technical label stays reachable as the tooltip. */
export function renderSimpleStatusBar(el: StatusBarElement, status: SimpleStatus, detailedLabel: string): void {
	el.setText(`YAOS: ${status.text}`);
	el.setAttr("title", `${status.detail}\n\nDetails: ${detailedLabel}`);
	for (const level of LEVELS) el.toggleClass(`yaos-status-${level}`, level === status.level);
}

/** Remove the colour classes (the detailed text keeps the theme's plain look, as before). */
export function clearSimpleStatusClasses(el: StatusBarElement): void {
	for (const level of LEVELS) el.toggleClass(`yaos-status-${level}`, false);
}

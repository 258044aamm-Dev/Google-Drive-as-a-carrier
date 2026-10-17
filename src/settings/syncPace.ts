/**
 * How often YAOS talks to the carrier, for people who hit rate limits.
 *
 * Nothing is stored by default and `normal` is exactly today's behaviour, so a
 * vault that never touches this setting syncs exactly as before. The other
 * profiles only SLOW things down: every custom value is clamped so it can never
 * be faster than `normal`.
 *
 * Google Drive polls, so its pace is a set of intervals. Cloudflare is a live
 * connection with nothing to poll, so its pace is one number (see
 * `resolveCloudflarePace`, added with the batching control).
 */

export type SyncPaceProfile = "normal" | "gentle" | "minimal" | "custom";

export function isSyncPaceProfile(value: string): value is SyncPaceProfile {
	return value === "normal" || value === "gentle" || value === "minimal" || value === "custom";
}

/** User-entered numbers, used when the profile is "custom". All optional. */
export interface SyncPaceCustom {
	/** Google Drive: seconds between checks while you are working. */
	driveActiveSec?: number;
	/** Google Drive: seconds between checks after a minute without activity. */
	driveIdleSec?: number;
	/** Google Drive: seconds between checks while the window is hidden. 0 = pause until it is shown. */
	driveHiddenSec?: number;
	/** Google Drive: seconds your edits are gathered before one upload. */
	driveBatchSec?: number;
	/** Google Drive: minutes between full "does Drive hold everything" checks. */
	driveFullCheckMin?: number;
	/** Cloudflare: seconds your edits are gathered before one message is sent. 0 = send each edit at once. */
	cloudflareBatchSec?: number;
}

export interface SyncPaceSettings {
	/** Absent = normal. */
	syncPace?: SyncPaceProfile;
	syncPaceCustom?: SyncPaceCustom;
}

/** The values the Drive transport runs with. */
export interface DrivePace {
	pollIntervalMs: number;
	idleAfterMs: number;
	idlePollIntervalMs: number;
	/** 0 = no checks while the window is hidden. */
	backgroundPollIntervalMs: number;
	batchMs: number;
	reconcileIntervalMs: number;
}

/** Today's behaviour. Do not change these without a changelog entry: they are the default for everyone. */
export const NORMAL_DRIVE_PACE = {
	pollIntervalMs: 3_000,
	idleAfterMs: 60_000,
	idlePollIntervalMs: 30_000,
	/** Desktop windows that are hidden still check every two minutes; phones suspend apps, so they pause. */
	backgroundPollIntervalMsDesktop: 120_000,
	backgroundPollIntervalMsMobile: 0,
	batchMs: 2_000,
	reconcileIntervalMs: 5 * 60_000,
} as const;

const GENTLE = { active: 10, idle: 60, hidden: 300, batch: 5, fullMin: 10 } as const;
const MINIMAL = { active: 30, idle: 120, hidden: 900, batch: 10, fullMin: 30 } as const;

/** Allowed custom ranges. The lower bound of each is today's value: custom can only slow things down. */
export const CUSTOM_LIMITS = {
	driveActiveSec: { min: 3, max: 600 },
	driveIdleSec: { min: 30, max: 3600 },
	driveHiddenSec: { min: 120, max: 7200 },
	driveBatchSec: { min: 2, max: 60 },
	driveFullCheckMin: { min: 5, max: 120 },
	/** 0 is allowed and means "off" (today's behaviour). */
	cloudflareBatchSec: { min: 1, max: 30 },
} as const;

function clamp(value: number | undefined, limit: { min: number; max: number }, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(limit.max, Math.max(limit.min, value));
}

export function currentSyncPace(settings: SyncPaceSettings): SyncPaceProfile {
	const value = settings.syncPace;
	return value !== undefined && isSyncPaceProfile(value) ? value : "normal";
}

export function resolveDrivePace(settings: SyncPaceSettings, isMobile: boolean): DrivePace {
	const normalBackground = isMobile
		? NORMAL_DRIVE_PACE.backgroundPollIntervalMsMobile
		: NORMAL_DRIVE_PACE.backgroundPollIntervalMsDesktop;
	const profile = currentSyncPace(settings);
	if (profile === "normal") {
		return {
			pollIntervalMs: NORMAL_DRIVE_PACE.pollIntervalMs,
			idleAfterMs: NORMAL_DRIVE_PACE.idleAfterMs,
			idlePollIntervalMs: NORMAL_DRIVE_PACE.idlePollIntervalMs,
			backgroundPollIntervalMs: normalBackground,
			batchMs: NORMAL_DRIVE_PACE.batchMs,
			reconcileIntervalMs: NORMAL_DRIVE_PACE.reconcileIntervalMs,
		};
	}
	if (profile === "gentle" || profile === "minimal") {
		const p = profile === "gentle" ? GENTLE : MINIMAL;
		return {
			pollIntervalMs: p.active * 1000,
			idleAfterMs: NORMAL_DRIVE_PACE.idleAfterMs,
			idlePollIntervalMs: p.idle * 1000,
			backgroundPollIntervalMs: isMobile ? 0 : p.hidden * 1000,
			batchMs: p.batch * 1000,
			reconcileIntervalMs: p.fullMin * 60_000,
		};
	}
	const c = settings.syncPaceCustom ?? {};
	const active = clamp(c.driveActiveSec, CUSTOM_LIMITS.driveActiveSec, NORMAL_DRIVE_PACE.pollIntervalMs / 1000);
	const idle = clamp(c.driveIdleSec, CUSTOM_LIMITS.driveIdleSec, NORMAL_DRIVE_PACE.idlePollIntervalMs / 1000);
	// 0 explicitly means "pause while hidden"; anything else is clamped; unset keeps today's value.
	const hiddenMs = c.driveHiddenSec === 0
		? 0
		: c.driveHiddenSec === undefined
			? normalBackground
			: clamp(c.driveHiddenSec, CUSTOM_LIMITS.driveHiddenSec, NORMAL_DRIVE_PACE.backgroundPollIntervalMsDesktop / 1000) * 1000;
	return {
		pollIntervalMs: active * 1000,
		idleAfterMs: NORMAL_DRIVE_PACE.idleAfterMs,
		idlePollIntervalMs: idle * 1000,
		backgroundPollIntervalMs: hiddenMs,
		batchMs: clamp(c.driveBatchSec, CUSTOM_LIMITS.driveBatchSec, NORMAL_DRIVE_PACE.batchMs / 1000) * 1000,
		reconcileIntervalMs: clamp(c.driveFullCheckMin, CUSTOM_LIMITS.driveFullCheckMin, NORMAL_DRIVE_PACE.reconcileIntervalMs / 60_000) * 60_000,
	};
}

/** Cloudflare: gather edits for this long before sending (ms). 0 = send each edit at once, which is today's behaviour. */
export const CLOUDFLARE_PROFILE_BATCH_MS = { normal: 0, gentle: 2_000, minimal: 5_000 } as const;

export function resolveCloudflareBatchMs(settings: SyncPaceSettings): number {
	const profile = currentSyncPace(settings);
	if (profile !== "custom") return CLOUDFLARE_PROFILE_BATCH_MS[profile];
	const sec = settings.syncPaceCustom?.cloudflareBatchSec;
	if (typeof sec !== "number" || !Number.isFinite(sec) || sec <= 0) return 0;
	return clamp(sec, CUSTOM_LIMITS.cloudflareBatchSec, 0) * 1000;
}

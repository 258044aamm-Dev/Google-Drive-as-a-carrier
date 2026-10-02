import { DriveError } from "./driveApi";

/**
 * Reject with a retryable DriveError if `work` has not settled after `ms`.
 * The work itself cannot be cancelled (Obsidian's requestUrl has no abort),
 * so a timed-out request may still finish in the background; every operation
 * this wraps is idempotent, so that is harmless.
 */
export async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
	if (!(ms > 0) || !Number.isFinite(ms)) return work;
	let timer: number | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = window.setTimeout(() => reject(new DriveError(408, `Timeout (${ms} ms) during ${what}`)), ms);
	});
	try {
		return await Promise.race([work, timeout]);
	} finally {
		if (timer !== undefined) window.clearTimeout(timer);
	}
}

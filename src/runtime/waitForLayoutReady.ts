/**
 * Wait until Obsidian has restored the workspace layout.
 *
 * At startup the notes you had open are still placeholder tabs until the layout
 * is ready, so they look "closed" to the first reconcile. For a note typed in
 * just before the last shutdown that meant the closed-file path ran against it
 * and, with no baseline hash, kept the disk text as a "- disk" conflict copy
 * (upstream issue #77). Reconciling after the layout is ready lets the open-file
 * rules see those notes as open.
 *
 * Never blocks sync for good: after `timeoutMs` it resolves `false` and the
 * caller carries on exactly as it did before this gate existed.
 */

export interface LayoutReadyWorkspace {
	readonly layoutReady: boolean;
	onLayoutReady(callback: () => void): void;
}

export interface WaitForLayoutReadyOptions {
	timeoutMs?: number;
	/** Injectable timers, for tests. Defaults to the window timers. */
	setTimer?: (callback: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
}

export const LAYOUT_READY_TIMEOUT_MS = 20_000;

/** `"already-ready"`, `"ready"` or `"timeout"`. */
export type LayoutReadyOutcome = "already-ready" | "ready" | "timeout";

export function waitForLayoutReady(
	workspace: LayoutReadyWorkspace,
	options: WaitForLayoutReadyOptions = {},
): Promise<LayoutReadyOutcome> {
	if (workspace.layoutReady) return Promise.resolve("already-ready");
	const setTimer = options.setTimer ?? ((cb, ms) => window.setTimeout(cb, ms));
	const clearTimer = options.clearTimer ?? ((h) => window.clearTimeout(h as number));
	return new Promise<LayoutReadyOutcome>((resolve) => {
		let done = false;
		const finish = (outcome: LayoutReadyOutcome, handle: unknown) => {
			if (done) return;
			done = true;
			clearTimer(handle);
			resolve(outcome);
		};
		const handle: unknown = setTimer(() => finish("timeout", handle), options.timeoutMs ?? LAYOUT_READY_TIMEOUT_MS);
		workspace.onLayoutReady(() => finish("ready", handle));
	});
}

import * as Y from "yjs";

/**
 * Optional "send my edits in groups" for the Cloudflare carrier.
 *
 * The Worker connection sends every edit the moment it happens, which is the
 * default and stays exactly so. For people who hit a request limit on their
 * Cloudflare plan, this gathers the edits made within a short window and sends
 * them as ONE merged message. Nothing is dropped or reordered: a merged Yjs
 * update contains exactly the same changes, and anything unsent when the
 * connection is down is caught up by the normal sync handshake on reconnect.
 *
 * It only touches ONE thing on the provider: the function that forwards local
 * document updates. While the batcher is off (the default) that function is the
 * provider's own and this class is not even constructed in the data path.
 */

/** The part of the y-partyserver provider this class needs. */
export interface UpdateForwarder {
	_updateHandler: (update: Uint8Array, origin: unknown) => void;
}

export interface BatcherTimers {
	set(fn: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

const windowTimers: BatcherTimers = {
	set: (fn, ms) => window.setTimeout(fn, ms),
	clear: (handle) => { window.clearTimeout(handle as number); },
};

export class OutgoingUpdateBatcher {
	private installed = false;
	private delayMs = 0;
	private pending: Uint8Array[] = [];
	private timer: unknown = null;
	/** The provider's own forwarder, kept while ours is installed. */
	private readonly original: UpdateForwarder["_updateHandler"];
	private readonly onUpdate = (update: Uint8Array, origin: unknown): void => {
		// The provider's own rule, kept: updates it applied itself are never sent back.
		if (origin === this.provider) return;
		this.pending.push(update);
		if (this.timer === null) {
			this.timer = this.timers.set(() => { this.flush(); }, this.delayMs);
		}
	};
	private readonly onVisibility = (): void => {
		if (typeof document !== "undefined" && document.visibilityState === "hidden") this.flush();
	};

	constructor(
		private readonly doc: Y.Doc,
		private readonly provider: UpdateForwarder,
		private readonly timers: BatcherTimers = windowTimers,
	) {
		this.original = provider._updateHandler;
	}

	/** 0 = send every edit at once (the provider's own behaviour). */
	setDelayMs(ms: number): void {
		const next = Number.isFinite(ms) && ms > 0 ? ms : 0;
		this.delayMs = next;
		if (next > 0 && !this.installed) this.install();
		else if (next === 0 && this.installed) this.uninstall();
	}

	get active(): boolean {
		return this.installed;
	}

	/** Send what is waiting now, as one message. */
	flush(): void {
		if (this.timer !== null) {
			this.timers.clear(this.timer);
			this.timer = null;
		}
		if (this.pending.length === 0) return;
		const batch = this.pending;
		this.pending = [];
		const merged = batch.length === 1 ? batch[0] : Y.mergeUpdates(batch);
		if (merged) this.original(merged, null);
	}

	/** Stop batching and hand everything back to the provider. Safe to call twice. */
	dispose(): void {
		if (this.installed) this.uninstall();
	}

	private install(): void {
		this.doc.off("update", this.original);
		this.doc.on("update", this.onUpdate);
		if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onVisibility);
		this.installed = true;
	}

	private uninstall(): void {
		this.doc.off("update", this.onUpdate);
		this.flush();
		if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisibility);
		this.doc.on("update", this.original);
		this.installed = false;
	}
}

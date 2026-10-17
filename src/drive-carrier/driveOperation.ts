/** A session ended; unlike a timeout this is not a connection failure. */
export class DriveOperationStopped extends Error {
	constructor() { super("Drive operation ended with its session"); }
}

/**
 * Fences late completions when requestUrl cannot abort the underlying request.
 * An already-sent write may reach Drive, but its obsolete continuation must
 * never mutate the document, emit receipts, or start more writes/deletions.
 */
export class DriveOperation {
	private error: Error | null = null;
	private readonly rollbacks = new Set<() => void>();
	private signal = () => {};
	private readonly cancelled = new Promise<void>((resolve) => { this.signal = resolve; });

	readonly check = (): void => {
		if (this.error) throw this.error;
	};

	cancel(error: Error = new DriveOperationStopped()): void {
		if (this.error) return;
		this.error = error;
		for (const rollback of this.rollbacks) rollback();
		this.rollbacks.clear();
		this.signal();
	}

	onCancel(rollback: () => void): () => void {
		this.check();
		this.rollbacks.add(rollback);
		return () => { this.rollbacks.delete(rollback); };
	}

	async wait<T>(work: () => Promise<T>): Promise<T> {
		this.check();
		const result = await Promise.race([
			work(),
			this.cancelled.then((): never => { throw this.error ?? new DriveOperationStopped(); }),
		]);
		this.check();
		return result;
	}
}

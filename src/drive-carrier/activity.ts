/**
 * When the user's window is in front, hidden, or the network comes back.
 * The Drive carrier only polls (there is no push channel), so it uses this to
 * poll immediately when it matters and to stay quiet when it does not.
 */
export type ActivityEvent = "visible" | "hidden" | "online";

export interface ActivitySource {
	isVisible(): boolean;
	/** Returns a function that stops listening. */
	subscribe(listener: (event: ActivityEvent) => void): () => void;
}

/** Window visibility and network events. Falls back to "always visible" where there is no document. */
export function browserActivity(): ActivitySource {
	return {
		isVisible: () => typeof document === "undefined" || document.visibilityState !== "hidden",
		subscribe(listener) {
			if (typeof document === "undefined" || typeof window === "undefined" || typeof window.addEventListener !== "function") {
				return () => undefined;
			}
			const onVisibility = (): void => listener(document.visibilityState === "hidden" ? "hidden" : "visible");
			const onOnline = (): void => listener("online");
			document.addEventListener("visibilitychange", onVisibility);
			window.addEventListener("online", onOnline);
			return () => {
				document.removeEventListener("visibilitychange", onVisibility);
				window.removeEventListener("online", onOnline);
			};
		},
	};
}

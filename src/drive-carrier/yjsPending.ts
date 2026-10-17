import type * as Y from "yjs";

/**
 * F9a: the only place in the carrier that reads Yjs internals.
 *
 * `Y.Doc.store.pendingStructs` / `pendingDs` are not public API. The transport
 * used to read them directly, which means a Yjs upgrade that renamed or dropped
 * them would turn `undefined === null` into "nothing is pending" and report a
 * document as synced while it was still waiting for an update it never got.
 *
 * Instead the read goes through here and reports whether it understood the
 * shape at all: `known: false` means the carrier cannot answer this way and
 * must fall back to comparing state vectors (see DriveTransport.isComplete).
 *
 * tests/client/drive-carrier-hardening.ts fails if the shape stops working, so
 * an upgrade is noticed in CI instead of in the field.
 */

export interface PendingState {
	/** True when this Yjs exposes the internals, so `pending` is meaningful. */
	known: boolean;
	/** True when the document is waiting for something it has not received. */
	pending: boolean;
}

const UNKNOWN: PendingState = { known: false, pending: false };

export function readPendingState(doc: Y.Doc): PendingState {
	// Reflect, not a cast: the fields are not in Yjs's public typings, and the
	// no-any guard (rightly) refuses `as unknown as`. Everything below narrows.
	const store: unknown = Reflect.get(doc, "store");
	if (typeof store !== "object" || store === null) return UNKNOWN;
	if (!("pendingStructs" in store) || !("pendingDs" in store)) return UNKNOWN;
	const { pendingStructs, pendingDs } = store;
	// Both are null (or absent) on a caught-up document; anything else is a wait.
	return { known: true, pending: (pendingStructs ?? null) !== null || (pendingDs ?? null) !== null };
}

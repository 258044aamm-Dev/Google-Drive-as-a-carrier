import type { Awareness } from "y-protocols/awareness";
import type { Doc } from "yjs";

/**
 * The surface of a sync carrier ("transport") that the rest of YAOS relies on.
 *
 * Until now the only carrier was the Cloudflare Worker, reached through a
 * `y-partyserver` provider, and the engine (VaultSync, ConnectionController,
 * EditorBindingManager, ...) was written against that class directly. This
 * interface names exactly the members the engine actually uses, so another
 * carrier can be plugged in without touching the engine.
 *
 * It deliberately does NOT include anything Cloudflare-specific (the socket,
 * the provider URL, ticket params). Those stay inside VaultSync's Cloudflare
 * code path.
 *
 * Contract for implementers:
 *  - Remote updates are applied to the Y.Doc with `origin === transport`
 *    (the transport object itself). The engine classifies local vs. remote
 *    edits by that identity (see origins.ts, updateTracker.ts, ackOrigins.ts).
 *  - `status` is emitted with `{ status: "connected" | "disconnected" |
 *    "connecting" }` whenever the carrier's reachability changes.
 *  - `sync` is emitted with `true` once the local document has caught up with
 *    everything the carrier currently holds, and `false` when that is lost.
 *  - `custom-message` and `message` are optional server-protocol channels
 *    (fatal admission errors, state-vector echoes). A carrier that has no such
 *    channel simply never emits them.
 */
export interface SyncTransport {
	/** Presence state shared with the editor binding. May be local-only. */
	readonly awareness: Awareness;
	/** True while the carrier is reachable (Cloudflare: websocket open). */
	readonly wsconnected: boolean;
	/** True while a connection attempt is in flight. */
	readonly wsconnecting: boolean;
	/** True once the document has caught up with the carrier. */
	readonly synced: boolean;

	/** Start (or resume) synchronisation. Safe to call repeatedly. */
	connect(): Promise<void>;
	/** Stop synchronisation without destroying local state. */
	disconnect(): void;
	/** Release every resource. The transport is unusable afterwards. */
	destroy(): void;

	on(event: "status", handler: (event: { status: string }) => void): unknown;
	on(event: "sync", handler: (synced: boolean) => void): unknown;
	on(event: "custom-message", handler: (payload: string) => void): unknown;
	on(event: "message", handler: (event: MessageEvent) => void): unknown;

	off(event: "status", handler: (event: { status: string }) => void): unknown;
	off(event: "sync", handler: (synced: boolean) => void): unknown;
	off(event: "custom-message", handler: (payload: string) => void): unknown;
	off(event: "message", handler: (event: MessageEvent) => void): unknown;
}

/**
 * Everything a transport factory may need to build a carrier for one vault.
 * `doc` is the vault-wide Y.Doc the transport must keep in sync.
 */
export interface SyncTransportContext {
	doc: Doc;
	vaultId: string;
}

export type SyncTransportFactory = (ctx: SyncTransportContext) => SyncTransport;

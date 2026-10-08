/**
 * Transport seam: VaultSync must run against any `SyncTransport`, not only the
 * Cloudflare provider.
 *
 * Builds a real VaultSync with an injected fake carrier and checks that the
 * engine uses the carrier through the documented surface only: it connects it,
 * follows its status and sync events, classifies updates applied with the
 * transport as the origin as remote, and tears it down.
 *
 * No Cloudflare provider is created on this path, so no Worker URL or token is
 * needed (both are left empty on purpose).
 */

import * as Y from "yjs";
import { Observable } from "lib0/observable";
import { Awareness } from "y-protocols/awareness";
import { VaultSync } from "../../src/sync/vaultSync";
import { DEFAULT_SETTINGS } from "../../src/settings/settingsStore";
import type { SyncTransport, SyncTransportContext } from "../../src/sync/transport";
import { isLocalOrigin } from "../../src/sync/origins";
import { suite } from "../harness.ts";

const s = suite("transport-seam");

// These tests run under Node, which has no IndexedDB. y-indexeddb then rejects
// its open promise; VaultSync captures that failure for diagnostics, but the
// library's own derived promise chain still surfaces as an unhandled rejection.
// Persistence is not what is under test here, so swallow exactly that error.
process.on("unhandledRejection", (reason) => {
	if (reason instanceof ReferenceError && /indexedDB/.test(reason.message)) return;
	throw reason instanceof Error ? reason : new Error(String(reason));
});

/** destroy() awaits the (failed) IndexedDB close last; the transport is released before that. */
async function destroyQuietly(vaultSync: VaultSync): Promise<void> {
	await vaultSync.destroy().catch(() => undefined);
}

class FakeTransport extends Observable<string> implements SyncTransport {
	readonly awareness: Awareness;
	wsconnected = false;
	wsconnecting = false;
	synced = false;
	connectCalls = 0;
	disconnectCalls = 0;
	destroyCalls = 0;

	constructor(readonly doc: Y.Doc) {
		super();
		this.awareness = new Awareness(doc);
	}

	connect(): Promise<void> {
		this.connectCalls++;
		return Promise.resolve();
	}

	disconnect(): void {
		this.disconnectCalls++;
		this.wsconnected = false;
	}

	destroy(): void {
		this.destroyCalls++;
		super.destroy();
	}

	/** Test helper: simulate the carrier becoming reachable. */
	goOnline(): void {
		this.wsconnected = true;
		this.emit("status", [{ status: "connected" }]);
	}

	/** Test helper: simulate catching up with the carrier. */
	finishSync(): void {
		this.synced = true;
		this.emit("sync", [true]);
	}
}

function makeVaultSync() {
	let created: FakeTransport | null = null;
	let context: SyncTransportContext | null = null;
	const vaultSync = new VaultSync(
		{ ...DEFAULT_SETTINGS, vaultId: "seam-vault", deviceName: "seam" },
		{
			transportFactory: (ctx) => {
				context = ctx;
				created = new FakeTransport(ctx.doc);
				return created;
			},
		},
	);
	if (!created || !context) throw new Error("transport factory was not called");
	return { vaultSync, transport: created as FakeTransport, context: context as SyncTransportContext };
}

s.section("Test 1: the factory is used and the engine connects the carrier");
{
	const { vaultSync, transport, context } = makeVaultSync();
	s.check(vaultSync.provider === transport, "VaultSync.provider is the injected transport");
	s.check(context.doc === vaultSync.ydoc, "the factory receives the vault Y.Doc");
	s.check(context.vaultId === "seam-vault", "the factory receives the vault id");
	s.check(transport.connectCalls === 1, `connect() called once (got ${transport.connectCalls})`);
	s.check(!vaultSync.connected, "not connected until the carrier reports it");
	await destroyQuietly(vaultSync);
}

s.section("Test 2: status and sync events drive the engine");
{
	const { vaultSync, transport } = makeVaultSync();
	const gen0 = vaultSync.connectionGeneration;
	transport.goOnline();
	s.check(vaultSync.connected, "connected follows wsconnected");
	s.check(vaultSync.connectionGeneration === gen0 + 1, "connected status bumps the connection generation");

	const waiting = vaultSync.waitForProviderSync();
	s.check(!vaultSync.providerSynced, "not synced before the carrier says so");
	transport.finishSync();
	s.check(await waiting === true, "waitForProviderSync resolves true after the sync event");
	s.check(vaultSync.providerSynced, "providerSynced is true afterwards");
	await destroyQuietly(vaultSync);
}

s.section("Test 3: updates applied with the transport as origin count as remote");
{
	const { vaultSync, transport } = makeVaultSync();
	s.check(vaultSync.lastRemoteUpdateAt === null, "no remote update yet");

	const remote = new Y.Doc();
	remote.getMap("pathToId").set("remote.md", "id-1");
	Y.applyUpdate(vaultSync.ydoc, Y.encodeStateAsUpdate(remote), transport);
	s.check(vaultSync.lastRemoteUpdateAt !== null, "update from the transport is tracked as remote");
	s.check(!isLocalOrigin(transport, vaultSync.provider), "the transport origin is not a local origin");
	s.check(isLocalOrigin(null, vaultSync.provider), "origin=null (user edit) is still local");
	await destroyQuietly(vaultSync);
}

s.section("Test 4: destroy releases the carrier and touches no Cloudflare state");
{
	const { vaultSync, transport } = makeVaultSync();
	await destroyQuietly(vaultSync);
	s.check(transport.destroyCalls === 1, "transport.destroy() called once");
}

s.section("Test 5: the carrier can be stopped through the engine's own reconnect controls");
{
	const { vaultSync, transport } = makeVaultSync();
	vaultSync.provider.disconnect();
	s.check(transport.disconnectCalls === 1, "disconnect() reaches the transport");
	await destroyQuietly(vaultSync);
}

s.section("Test 6: without a factory the default Cloudflare provider is still used");
{
	// The real provider registers unload listeners on `window`; Node has none.
	const host: { addEventListener?: unknown; removeEventListener?: unknown } = window;
	const hadListeners = "addEventListener" in host;
	if (!hadListeners) {
		host.addEventListener = () => undefined;
		host.removeEventListener = () => undefined;
	}
	const vaultSync = new VaultSync({
		...DEFAULT_SETTINGS,
		host: "https://sync.invalid",
		token: "t",
		vaultId: "cf-vault",
	});
	const provider = vaultSync.provider;
	s.check(!(provider instanceof FakeTransport), "default path builds a real provider");
	const url = Reflect.get(provider, "url");
	s.check(
		typeof url === "string" && url.includes("sync.invalid") && url.includes("cf-vault"),
		`provider points at the Worker host and vault room (url=${String(url)})`,
	);
	s.check(provider.awareness instanceof Awareness, "provider exposes awareness");
	provider.disconnect();
	await destroyQuietly(vaultSync);
	if (!hadListeners) {
		delete host.addEventListener;
		delete host.removeEventListener;
	}
}

await s.done();

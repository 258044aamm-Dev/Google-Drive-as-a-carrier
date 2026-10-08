import assert from "node:assert/strict";
import * as Y from "yjs";
import YSyncProvider from "y-partyserver/provider";
import WebSocket from "ws";
import { SCHEMA_VERSION } from "../../src/sync/schema";
import { CONFIG_NAMESPACE, ConfigRevisionStore } from "../../src/config-sync/revisionStore";

const host = process.env.YAOS_TEST_HOST || "http://127.0.0.1:8787";
const token = process.env.SYNC_TOKEN;
if (!token) throw new Error("SYNC_TOKEN is required");
const vault = `${process.env.YAOS_TEST_VAULT_ID || "integration"}-config-preview`;
const docs: Y.Doc[] = [];
const providers: YSyncProvider[] = [];
const stores: ConfigRevisionStore[] = [];
async function waitFor(check: () => boolean): Promise<void> {
	const end = Date.now() + 10000;
	while (!check()) {
		if (Date.now() > end) throw new Error("Configuration Worker integration timed out");
		await new Promise<void>((r) => setTimeout(r, 20));
	}
}
function device(author: string) {
	const doc = new Y.Doc(); docs.push(doc);
	const provider = new YSyncProvider(host, vault, doc, {
		prefix: `/vault/sync/${encodeURIComponent(vault)}`,
		params: { token: token!, schemaVersion: String(SCHEMA_VERSION) },
		WebSocketPolyfill: globalThis.WebSocket ?? WebSocket, connect: true,
	});
	providers.push(provider);
	const store = new ConfigRevisionStore(doc, vault, author); stores.push(store);
	return { doc, provider, store };
}
let exit = 0;
try {
	const a = device("worker-device-a"); const b = device("worker-device-b");
	await waitFor(() => a.provider.synced && b.provider.synced);
	a.doc.getText("ordinary-note").insert(0, "notes still work");
	await a.store.seed({ "app.json": '{"vimMode":true}' });
	await waitFor(() => b.doc.getMap(CONFIG_NAMESPACE).size === 1 && b.doc.getText("ordinary-note").length > 0);
	assert.equal((await b.store.view()).values["app.json"], '{"vimMode":true}');
	assert.equal(b.doc.getText("ordinary-note").toString(), "notes still work");
	await b.store.publish("appearance.json", '{"theme":"system"}');
	await waitFor(() => a.doc.getMap(CONFIG_NAMESPACE).size === 2);
	const c = device("worker-device-c");
	await waitFor(() => c.provider.synced && c.doc.getMap(CONFIG_NAMESPACE).size === 2);
	assert.deepEqual((await c.store.view()).values, (await a.store.view()).values);
	assert.equal(c.doc.getText("ordinary-note").toString(), "notes still work");
	console.log("PASS: configuration projections and ordinary notes traverse real local Worker; late joiner retains history.");
} catch (err) {
	console.error(err); exit = 1;
} finally {
	for (const store of stores) store.destroy();
	for (const p of providers) { if (p.ws instanceof WebSocket) p.ws.terminate(); p.destroy(); }
	for (const doc of docs) doc.destroy();
}
// Provider reconnect timers must not hold the standalone integration child open.
process.exit(exit);

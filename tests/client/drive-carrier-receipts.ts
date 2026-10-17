/**
 * Drive carrier: "saved" receipts. The transport reuses the server's
 * state-vector echo message so the existing receipt tracker (and the status
 * bar built on it) can say "saved" when Drive really holds the change.
 */

import * as Y from "yjs";
import type { DriveApi } from "../../src/drive-carrier/driveApi";
import { DriveTransport } from "../../src/drive-carrier/driveTransport";
import { ServerAckTracker } from "../../src/sync/serverAckTracker";
import { parseSvEchoMessageDetailed } from "../../src/sync/svEchoMessage";
import { FakeDrive } from "../mocks/fakeDrive";
import { suite } from "../harness.ts";

const s = suite("drive-carrier-receipts");
let clock = 20_000_000;

function setup(drive: FakeDrive, deviceId = "A", wrap: (api: DriveApi) => DriveApi = (api) => api) {
	const doc = new Y.Doc();
	const transport = new DriveTransport(doc, wrap(drive.client()), {
		vaultId: "v", deviceId, autoTimers: false, now: () => clock,
	});
	const tracker = new ServerAckTracker();
	tracker.attach(doc, () => Y.encodeStateVector(doc), transport, null);
	const echoes: ReturnType<typeof parseSvEchoMessageDetailed>[] = [];
	transport.on("custom-message", (payload: string) => {
		const parsed = parseSvEchoMessageDetailed(payload);
		echoes.push(parsed);
		if (parsed.kind === "valid_sv_echo") tracker.recordServerSvEcho(parsed.sv, parsed.durability);
	});
	return { doc, text: doc.getText("t"), transport, tracker, echoes };
}

function confirmed(tracker: ServerAckTracker): boolean | null {
	return tracker.serverAppliedLocalState;
}

s.section("Test 1: an edit is confirmed only after it is on Drive");
{
	const drive = new FakeDrive();
	const a = setup(drive);
	await a.transport.connect();
	const first = a.echoes[0];
	s.check(a.echoes.length === 1 && first?.kind === "valid_sv_echo" && first.durability?.generation === 0, "an empty vault sends one starting-point receipt (generation 0)");
	a.text.insert(0, "hello");
	s.check(confirmed(a.tracker) === false, "a fresh edit is unconfirmed");
	clock += 61_000;
	await a.transport.syncNow();
	const last = a.echoes.at(-1);
	s.check(last?.kind === "valid_sv_echo", "a valid echo message was emitted after the upload");
	s.check(last?.kind === "valid_sv_echo" && last.durability !== null && last.durability.generation >= 1, "it carries a persistence counter");
	s.check(confirmed(a.tracker) === true, "the tracker now reports the edit as saved");
}

s.section("Test 2: receipts follow the real stored state, not the clock");
{
	const drive = new FakeDrive();
	const a = setup(drive);
	await a.transport.connect();
	a.text.insert(0, "one");
	clock += 61_000;
	await a.transport.syncNow();
	s.check(confirmed(a.tracker) === true, "first edit saved");
	drive.failNext("createFile", 500, 3);
	a.text.insert(3, " two");
	clock += 61_000;
	await a.transport.syncNow();
	s.check(confirmed(a.tracker) === false, "while uploads fail the edit stays unconfirmed");
	s.check(a.transport.pendingParts > 0, "and it is still queued");
	for (let i = 0; i < 4; i++) {
		clock += 120_000;
		await a.transport.syncNow();
	}
	s.check(confirmed(a.tracker) === true && a.transport.pendingParts === 0, "once the upload succeeds it is confirmed");
}

s.section("Test 3: a deletion-only change is confirmed too");
{
	const drive = new FakeDrive();
	const a = setup(drive);
	await a.transport.connect();
	a.text.insert(0, "abcdef");
	clock += 61_000;
	await a.transport.syncNow();
	a.text.delete(1, 3);
	s.check(confirmed(a.tracker) === false, "the deletion is unconfirmed at first");
	clock += 61_000;
	await a.transport.syncNow();
	s.check(confirmed(a.tracker) === true, "confirmed after the upload (the counter advanced; the state vector alone could not show it)");
}

s.section("Test 4: an upload finishing must not confirm an edit made while it was running");
{
	const drive = new FakeDrive();
	let typeMidUpload: (() => void) | null = null;
	let injected = false;
	const a = setup(drive, "A", (api) => {
		const create = api.createFile.bind(api);
		api.createFile = async (...args) => {
			const info = await create(...args);
			if (typeMidUpload && !injected) {
				injected = true;
				typeMidUpload();
			}
			return info;
		};
		return api;
	});
	await a.transport.connect();
	a.text.insert(0, "first");
	typeMidUpload = () => { a.text.insert(5, " second"); };
	clock += 61_000;
	await a.transport.syncNow();
	s.check(injected, "the second edit was typed while the first upload was in flight");
	s.check(confirmed(a.tracker) === false, "the first upload's receipt does not confirm the newer edit");
	clock += 61_000;
	await a.transport.syncNow();
	s.check(confirmed(a.tracker) === true && a.transport.pendingParts === 0, "after the second upload it is confirmed");
}

s.section("Test 5: a restart starts a new receipt epoch");
{
	const drive = new FakeDrive();
	const a = setup(drive, "A");
	await a.transport.connect();
	a.text.insert(0, "x");
	clock += 61_000;
	await a.transport.syncNow();
	clock += 5000;
	const b = setup(drive, "A");
	await b.transport.connect();
	const ea = a.echoes.at(-1);
	const eb = b.echoes.at(-1);
	s.check(ea?.kind === "valid_sv_echo" && eb?.kind === "valid_sv_echo" && ea.durability?.epoch !== eb.durability?.epoch, "two sessions never share an epoch");
}

s.section("Test 6: a file vanishing from Drive leaves receipts well formed and the text intact");
{
	const drive = new FakeDrive();
	const a = setup(drive);
	await a.transport.connect();
	a.text.insert(0, "kept");
	clock += 61_000;
	await a.transport.syncNow();
	const before = a.echoes.length;
	const names = drive.namesIn("YAOS v").filter((n) => n.startsWith("seg-"));
	drive.remove(names[0]!);
	clock += 61_000;
	await a.transport.syncNow();
	const after = a.echoes.slice(before);
	s.check(after.every((e) => e.kind === "valid_sv_echo"), "any echo that is sent is well formed");
	clock += 61_000;
	await a.transport.syncNow();
	s.check(a.text.toString() === "kept", "the text is still intact");
}

await s.done();

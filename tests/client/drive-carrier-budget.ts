/**
 * Drive carrier: request budget, hidden-window and phone-suspend behaviour.
 *
 * Time is simulated: the test plays the part of the timer, asks the transport
 * how long it would wait (`nextPollDelayMs`), moves a fake clock forward by that
 * much and runs one cycle. FakeDrive counts the requests that result.
 */

import * as Y from "yjs";
import { DriveTransport, type DriveTransportOptions } from "../../src/drive-carrier/driveTransport";
import { browserActivity, type ActivityEvent, type ActivitySource } from "../../src/drive-carrier/activity";
import {
	DEFAULT_BACKGROUND_POLL_MS,
	DEFAULT_IDLE_AFTER_MS,
	DEFAULT_IDLE_POLL_MS,
	createDriveCarrier,
} from "../../src/drive-carrier/driveCarrierRuntime";
import { MeteredDriveApi } from "../../src/drive-carrier/requestMeter";
import { FakeDrive } from "../mocks/fakeDrive";
import { suite } from "../harness.ts";

const s = suite("drive-carrier-budget");
const VAULT = "v1";
const SEC = 1000;
const MIN = 60 * SEC;

class FakeActivity implements ActivitySource {
	visible = true;
	listeners = new Set<(e: ActivityEvent) => void>();
	isVisible(): boolean { return this.visible; }
	subscribe(l: (e: ActivityEvent) => void): () => void {
		this.listeners.add(l);
		return () => { this.listeners.delete(l); };
	}
	fire(e: ActivityEvent): void {
		if (e === "hidden") this.visible = false;
		if (e === "visible") this.visible = true;
		for (const l of this.listeners) l(e);
	}
}

const POLICY: Partial<DriveTransportOptions> = {
	pollIntervalMs: 3 * SEC,
	idleAfterMs: 60 * SEC,
	idlePollIntervalMs: 30 * SEC,
	backgroundPollIntervalMs: 120 * SEC,
};

function make(drive: FakeDrive, clock: { t: number }, extra: Partial<DriveTransportOptions> = {}, deviceId = "A") {
	const doc = new Y.Doc();
	const transport = new DriveTransport(doc, drive.client(), {
		vaultId: VAULT,
		deviceId,
		autoTimers: false,
		now: () => clock.t,
		...extra,
	});
	return { doc, text: doc.getText("t"), transport };
}

/** Let the transport schedule itself for `ms` of simulated time. Returns the number of cycles run. */
async function run(t: ReturnType<typeof make>, clock: { t: number }, ms: number): Promise<number> {
	const end = clock.t + ms;
	let cycles = 0;
	for (;;) {
		const delay = t.transport.nextPollDelayMs();
		if (delay === null || clock.t + delay > end) {
			clock.t = end;
			return cycles;
		}
		clock.t += delay;
		await t.transport.syncNow();
		cycles++;
	}
}

s.section("Test 1: poll interval by state");
{
	const drive = new FakeDrive();
	const clock = { t: 1_000_000 };
	const act = new FakeActivity();
	const t = make(drive, clock, { ...POLICY, activity: act });
	await t.transport.connect();
	s.check(t.transport.nextPollDelayMs() === 3 * SEC, "in use: every 3 seconds");
	clock.t += 59 * SEC;
	s.check(t.transport.nextPollDelayMs() === 3 * SEC, "still every 3 seconds just before the idle limit");
	clock.t += 2 * SEC;
	s.check(t.transport.nextPollDelayMs() === 30 * SEC, "idle for a minute: every 30 seconds");
	t.text.insert(0, "typing");
	s.check(t.transport.nextPollDelayMs() === 3 * SEC, "a local edit wakes it up");
	clock.t += 2 * MIN;
	s.check(t.transport.nextPollDelayMs() === 30 * SEC, "idle again");
	act.fire("hidden");
	s.check(t.transport.nextPollDelayMs() === 120 * SEC, "hidden window: every two minutes");
	act.fire("visible");
	s.check(t.transport.nextPollDelayMs() === 3 * SEC, "back in front: fast again at once");
	t.transport.destroy();
}
{
	// A remote change wakes an idle device.
	const drive = new FakeDrive();
	const clock = { t: 1_000_000 };
	const a = make(drive, clock, { ...POLICY }, "A");
	const b = make(drive, clock, { ...POLICY }, "B");
	await a.transport.connect();
	await b.transport.connect();
	clock.t += 5 * MIN;
	s.check(b.transport.nextPollDelayMs() === 30 * SEC, "B has been idle");
	a.text.insert(0, "hello from A");
	await a.transport.flush();
	await b.transport.syncNow();
	s.check(b.text.toString() === "hello from A" && b.transport.nextPollDelayMs() === 3 * SEC, "receiving an edit makes B fast again");
	a.transport.destroy();
	b.transport.destroy();
}

s.section("Test 2: failures back off and never poll faster than the budget");
{
	const drive = new FakeDrive();
	const clock = { t: 1_000_000 };
	const t = make(drive, clock, { ...POLICY });
	await t.transport.connect();
	drive.offline = true;
	const seen: number[] = [];
	for (let i = 0; i < 8; i++) {
		await t.transport.syncNow();
		seen.push(t.transport.nextPollDelayMs() ?? -1);
	}
	s.check(seen.join() === [1, 2, 4, 8, 16, 32, 60, 60].map((x) => x * SEC).join(), `1 s doubling to 60 s (${seen.join()})`);
	drive.offline = false;
	await t.transport.syncNow();
	s.check(t.transport.nextPollDelayMs() === 3 * SEC, "recovery returns to the normal interval");
	t.transport.destroy();
}

s.section("Test 3: the budget over simulated time");
{
	// Ten idle minutes with the window in front.
	const drive = new FakeDrive();
	const clock = { t: 1_000_000 };
	const meter = new MeteredDriveApi(drive.client(), () => clock.t);
	const doc = new Y.Doc();
	const t = new DriveTransport(doc, meter, { vaultId: VAULT, deviceId: "A", autoTimers: false, now: () => clock.t, ...POLICY, activity: new FakeActivity() });
	await t.connect();
	const base = meter.stats().total;
	const cycles = await run({ doc, text: doc.getText("t"), transport: t }, clock, 10 * MIN);
	const used = meter.stats().total - base;
	s.check(cycles <= 40 && used <= 45, `10 idle minutes: ${cycles} cycles, ${used} requests (a flat 3 s would be 200)`);
	t.destroy();
}
{
	// The same without the policy is the old behaviour, 3 s flat.
	const drive = new FakeDrive();
	const clock = { t: 1_000_000 };
	const t = make(drive, clock, {});
	await t.transport.connect();
	const cycles = await run(t, clock, 10 * MIN);
	s.check(cycles === 200, `without a policy nothing changed: ${cycles} cycles in 10 minutes`);
	t.transport.destroy();
}
{
	// Hidden desktop window: every two minutes. Hidden phone: nothing.
	for (const [label, background, max] of [["desktop", 120 * SEC, 5], ["phone", 0, 0]] as const) {
		const drive = new FakeDrive();
		const clock = { t: 1_000_000 };
		const act = new FakeActivity();
		const t = make(drive, clock, { ...POLICY, backgroundPollIntervalMs: background, activity: act });
		await t.transport.connect();
		act.fire("hidden");
		const before = drive.calls.listFiles;
		await run(t, clock, 10 * MIN);
		const lists = drive.calls.listFiles - before;
		s.check(lists <= max, `hidden ${label}, 10 minutes: ${lists} listings (limit ${max})`);
		t.transport.destroy();
	}
}
{
	// Typing for a minute: edits every 5 s are batched into one upload per 2 s window at most.
	const drive = new FakeDrive();
	const clock = { t: 1_000_000 };
	const meter = new MeteredDriveApi(drive.client(), () => clock.t);
	const doc = new Y.Doc();
	const text = doc.getText("t");
	const t = new DriveTransport(doc, meter, { vaultId: VAULT, deviceId: "A", autoTimers: false, now: () => clock.t, ...POLICY });
	await t.connect();
	const base = meter.stats().total;
	for (let i = 0; i < 12; i++) {
		text.insert(0, `edit ${i} `);
		for (let k = 0; k < 5; k++) {
			clock.t += SEC;
			if (k === 2) await t.syncNow(); // the 2 s batch timer plus the poll
			else if (k === 4) await t.syncNow();
		}
	}
	const used = meter.stats().total - base;
	s.check(used <= 12 * 2 * 3, `typing for a minute: ${used} requests (<= 72)`);
	t.destroy();
}

s.section("Test 4: window and network events");
{
	const drive = new FakeDrive();
	const clock = { t: 1_000_000 };
	const act = new FakeActivity();
	const t = make(drive, clock, { ...POLICY, activity: act });
	await t.transport.connect();
	act.fire("hidden");
	const l0 = drive.calls.listFiles;
	act.fire("visible");
	await new Promise((r) => setTimeout(r, 30));
	s.check(drive.calls.listFiles === l0 + 1, "coming to the front polls immediately");
	const l1 = drive.calls.listFiles;
	act.fire("online");
	await new Promise((r) => setTimeout(r, 30));
	s.check(drive.calls.listFiles === l1 + 1, "the network returning polls immediately");
	act.fire("hidden");
	const l2 = drive.calls.listFiles;
	act.fire("online");
	await new Promise((r) => setTimeout(r, 30));
	s.check(drive.calls.listFiles === l2, "a network event while hidden does not poll");
	t.transport.destroy();
	const l3 = drive.calls.listFiles;
	act.fire("visible");
	await new Promise((r) => setTimeout(r, 30));
	s.check(act.listeners.size === 0 && drive.calls.listFiles === l3, "a destroyed transport stops listening");
}
{
	// Going to the background sends waiting edits first.
	const drive = new FakeDrive();
	const clock = { t: 1_000_000 };
	const act = new FakeActivity();
	const t = make(drive, clock, { ...POLICY, activity: act });
	await t.transport.connect();
	t.text.insert(0, "written just before the app was put away");
	s.check(t.transport.pendingParts > 0, "an edit is waiting");
	act.fire("hidden");
	await new Promise((r) => setTimeout(r, 30));
	s.check(t.transport.pendingParts === 0 && drive.namesIn(`YAOS ${VAULT}`).some((n) => n.startsWith("seg-")), "it was uploaded when the window went away");
	t.transport.destroy();
}
{
	// Not connected: events do nothing.
	const drive = new FakeDrive();
	const clock = { t: 1_000_000 };
	const act = new FakeActivity();
	const t = make(drive, clock, { ...POLICY, activity: act });
	act.fire("visible");
	act.fire("online");
	await new Promise((r) => setTimeout(r, 30));
	s.check(drive.calls.listFiles === 0 && drive.calls.findFolders === 0, "before connect() events cause no requests");
	t.transport.destroy();
}

s.section("Test 5: real timers follow the same rules");
{
	const drive = new FakeDrive();
	const act = new FakeActivity();
	const doc = new Y.Doc();
	const t = new DriveTransport(doc, drive.client(), {
		vaultId: VAULT, deviceId: "A", pollIntervalMs: 20, backgroundPollIntervalMs: 0, activity: act,
	});
	await t.connect();
	await new Promise((r) => setTimeout(r, 120));
	const running = drive.calls.listFiles;
	s.check(running >= 3, `timer polls while visible (${running})`);
	act.fire("hidden");
	await new Promise((r) => setTimeout(r, 40));
	const atHide = drive.calls.listFiles;
	await new Promise((r) => setTimeout(r, 150));
	s.check(drive.calls.listFiles === atHide, "and stops while hidden (phone setting)");
	act.fire("visible");
	await new Promise((r) => setTimeout(r, 100));
	s.check(drive.calls.listFiles > atHide + 1, "and resumes when visible");
	t.destroy();
}

s.section("Test 6: the meter");
{
	const drive = new FakeDrive();
	const clock = { t: 5_000_000 };
	const meter = new MeteredDriveApi(drive.client(), () => clock.t);
	const folder = await meter.createFolder("f");
	await meter.findFolders("f");
	await meter.createFile(folder.id, "a", new Uint8Array([1]));
	const files = await meter.listFiles(folder.id);
	await meter.readFile(files[0]?.id ?? "");
	await meter.deleteFile(files[0]?.id ?? "");
	let st = meter.stats();
	s.check(st.total === 6 && st.lastMinute === 6, "every call is counted");
	s.check(st.byOperation.createFile === 1 && st.byOperation.listFiles === 1 && st.byOperation.deleteFile === 1, "per operation");
	clock.t += 61 * SEC;
	await meter.listFiles(folder.id);
	st = meter.stats();
	s.check(st.total === 7 && st.lastMinute === 1, "the last-minute figure forgets old requests");
	drive.offline = true;
	const err = await meter.listFiles(folder.id).catch((e: unknown) => e);
	s.check(err instanceof Error && meter.stats().total === 8, "failed requests are counted too");
}

s.section("Test 7: the carrier applies the production policy");
{
	s.check(DEFAULT_IDLE_AFTER_MS === 60_000 && DEFAULT_IDLE_POLL_MS === 30_000 && DEFAULT_BACKGROUND_POLL_MS === 120_000, "documented numbers: 1 minute, 30 s, 2 minutes");
	for (const mobile of [false, true]) {
		const act = new FakeActivity();
		const carrier = createDriveCarrier({
			getSettings: () => ({ carrier: "drive", driveClientId: "i", driveClientSecret: "x", driveRefreshToken: "r", driveDeviceId: "d" }),
			http: (async () => { throw new Error("no network in this test"); }) as never,
			log: () => {},
			onSignInLost: () => {},
			isMobile: () => mobile,
			activity: act,
		});
		s.check(carrier.requestStats() === null, "no request has been sent yet");
		const transport = carrier.transportFactory({ doc: new Y.Doc(), vaultId: VAULT, isLocalStoreOrigin: () => false });
		if (!(transport instanceof DriveTransport)) throw new Error("expected a DriveTransport");
		s.check(transport.nextPollDelayMs() === 3 * SEC, `${mobile ? "phone" : "desktop"}: 3 s while in use`);
		act.fire("hidden");
		s.check(transport.nextPollDelayMs() === (mobile ? null : 120 * SEC), mobile ? "phone: polling stops while hidden" : "desktop: every two minutes while hidden");
		transport.destroy();
	}
}

s.section("Test 8: browser events");
{
	const handlers: Record<string, () => void> = {};
	const removed: string[] = [];
	const fakeDocument = {
		visibilityState: "visible",
		addEventListener: (name: string, fn: () => void) => { handlers[`document:${name}`] = fn; },
		removeEventListener: (name: string) => { removed.push(`document:${name}`); },
	};
	const hadDocument = Reflect.has(globalThis, "document");
	const oldDocument: unknown = Reflect.get(globalThis, "document");
	const oldAdd: unknown = Reflect.get(window, "addEventListener");
	const oldRemove: unknown = Reflect.get(window, "removeEventListener");
	Reflect.set(globalThis, "document", fakeDocument);
	Reflect.set(window, "addEventListener", (name: string, fn: () => void) => { handlers[`window:${name}`] = fn; });
	Reflect.set(window, "removeEventListener", (name: string) => { removed.push(`window:${name}`); });
	try {
		const source = browserActivity();
		const events: ActivityEvent[] = [];
		const stop = source.subscribe((e) => events.push(e));
		s.check(source.isVisible(), "visible");
		fakeDocument.visibilityState = "hidden";
		handlers["document:visibilitychange"]?.();
		fakeDocument.visibilityState = "visible";
		handlers["document:visibilitychange"]?.();
		handlers["window:online"]?.();
		s.check(events.join() === "hidden,visible,online", `events are translated (${events.join()})`);
		fakeDocument.visibilityState = "hidden";
		s.check(!source.isVisible(), "hidden is reported");
		stop();
		s.check(removed.includes("document:visibilitychange") && removed.includes("window:online"), "listeners are removed");
	} finally {
		if (hadDocument) Reflect.set(globalThis, "document", oldDocument);
		else Reflect.deleteProperty(globalThis, "document");
		Reflect.set(window, "addEventListener", oldAdd);
		Reflect.set(window, "removeEventListener", oldRemove);
	}
	const bare = browserActivity();
	s.check(bare.isVisible() && typeof bare.subscribe(() => {}) === "function", "without a document it reports visible and does nothing");
}

await s.done();

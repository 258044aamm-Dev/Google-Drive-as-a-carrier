/**
 * P2P settings home page (Milestone B3) — the custom sub-page: a status
 * card (the single source of link state — dot + one line, RTT and last
 * seen when linked) and the pairing wizard (P2pPairingFlow).
 *
 * Rendered imperatively via the declarative page's `page` factory; Obsidian
 * calls display() when the page opens and hide() when it is left.
 *
 * Hardening (drive.16): display() is idempotent (safe against re-entry) and
 * catches its own render errors into a visible in-page line — the page can
 * never be a silent blank. All DOM classes are scoped under .yaos-p2p-*.
 */

import { SettingPage } from "obsidian";
import type { SpikeState } from "../p2p/spikeHost";
import { P2pPairingFlow } from "./P2pPairingFlow";
import type { VaultSyncSettingsHost } from "./settingsTab";

export class P2pHomeSettingPage extends SettingPage {
	title = "P2P (experimental)";

	private flow: P2pPairingFlow | null = null;
	private unmountFlow: (() => void) | null = null;
	private refreshTimer: number | null = null;
	private cardDot: HTMLSpanElement | null = null;
	private cardText: HTMLSpanElement | null = null;

	constructor(private readonly settingsHost: VaultSyncSettingsHost) {
		super();
	}

	display(): void {
		// Idempotent: Obsidian may re-enter display(); never leak a timer
		// or a mounted flow from a previous entry.
		this.teardown();
		const c = this.containerEl;
		c.empty();
		c.addClass("yaos-p2p-home");
		try {
			const card = c.createDiv({ cls: "yaos-p2p-status-card" });
			this.cardDot = card.createSpan({ cls: "yaos-p2p-dot" });
			this.cardText = card.createSpan({ cls: "yaos-p2p-status-text" });

			const pairBody = c.createDiv();
			const spikeHost = this.settingsHost.getP2pSpikeHost?.() ?? null;
			if (spikeHost) {
				this.flow = new P2pPairingFlow(spikeHost);
				this.unmountFlow = this.flow.mount(pairBody);
				// A pairing deep link may have handed a code over — the page
				// consumes it exactly once, switches the wizard to the join
				// step, and pre-fills the field.
				const pending = this.settingsHost.takePendingP2pPairCode?.() ?? null;
				if (pending) this.flow.prefillJoin(pending);
			} else {
				// The host only stays null for non-P2P carriers (the page
				// itself is dormant then) or a failed on-demand start — the
				// plugin already surfaced that failure with a Notice.
				pairBody.createEl("div", {
					text: "The P2P link could not be started on this device. Check the developer console for details.",
					cls: "yaos-p2p-error",
				});
			}

			this.refresh();
			this.refreshTimer = window.setInterval(() => this.refresh(), 1000);
		} catch (err) {
			console.error("[yaos] P2P home page render failed:", err);
			c.empty();
			c.createDiv({
				text: `The P2P page could not be rendered: ${err instanceof Error ? err.message : String(err)}`,
				cls: "yaos-p2p-error",
			});
		}
	}

	hide(): void {
		this.teardown();
	}

	private teardown(): void {
		if (this.refreshTimer !== null) {
			window.clearInterval(this.refreshTimer);
			this.refreshTimer = null;
		}
		if (this.unmountFlow) {
			this.unmountFlow();
			this.unmountFlow = null;
		}
		this.flow = null;
		this.cardDot = null;
		this.cardText = null;
	}

	private refresh(): void {
		const spikeHost = this.settingsHost.getP2pSpikeHost?.() ?? null;
		const s = spikeHost ? spikeHost.state() : null;
		if (this.cardDot && this.cardText) {
			if (s) {
				this.cardDot.className = p2pDotClass(s);
				this.cardText.setText(p2pCardText(s));
			} else {
				this.cardDot.className = "yaos-p2p-dot";
				this.cardText.setText("The P2P link could not be started on this device.");
			}
		}
		this.flow?.update();
	}
}

function p2pDotClass(s: SpikeState): string {
	if (s.phase === "connected") return "yaos-p2p-dot ok";
	if (s.phase === "error") return "yaos-p2p-dot error";
	if (s.phase === "idle" || s.phase === "closed") return "yaos-p2p-dot";
	return "yaos-p2p-dot wait";
}

function p2pCardText(s: SpikeState): string {
	switch (s.phase) {
		case "connected": {
			const rtt = s.lastRttMs === null ? "" : ` · ${s.lastRttMs} ms`;
			const seen = s.lastSeen !== null ? ` · last seen ${new Date(s.lastSeen).toLocaleTimeString()}` : "";
			return `Linked${rtt}${seen}`;
		}
		case "awaiting-peer":
			return "Waiting for a device to join — share the code or scan the QR below.";
		case "connecting":
			return "Connecting…";
		case "error":
			return s.error ? `Connection problem: ${s.error}` : "Connection problem.";
		default:
			return "No P2P link yet. Pair a device below to get started.";
	}
}

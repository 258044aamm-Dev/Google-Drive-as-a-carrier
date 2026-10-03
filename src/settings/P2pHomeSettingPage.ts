/**
 * P2P settings home page (Milestone B2) — the custom sub-page that replaces
 * the flat beginner group: a status card (link state, RTT, last seen), the
 * pairing flow (P2pPairingFlow) and the "This vault" peer line.
 *
 * Rendered imperatively via the declarative page's `page` factory; Obsidian
 * calls display() when the page opens and hide() when it is left. All DOM
 * classes are scoped under .yaos-p2p-*.
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
	private peerLine: HTMLDivElement | null = null;

	constructor(private readonly settingsHost: VaultSyncSettingsHost) {
		super();
	}

	display(): void {
		const c = this.containerEl;
		c.empty();
		c.addClass("yaos-p2p-home");

		const card = c.createDiv({ cls: "yaos-p2p-status-card" });
		this.cardDot = card.createSpan({ cls: "yaos-p2p-dot" });
		this.cardText = card.createSpan({ cls: "yaos-p2p-status-text" });

		const pairWrap = c.createDiv({ cls: "yaos-p2p-pair-section" });
		pairWrap.createEl("div", { text: "Pair another device", cls: "yaos-p2p-pair-heading" });
		pairWrap.createEl("div", {
			text: "Devices find each other with a pairing code or QR — nothing to deploy, nothing to sign up for.",
			cls: "yaos-p2p-copy",
		});
		const pairBody = pairWrap.createDiv();
		const spikeHost = this.settingsHost.getP2pSpikeHost?.() ?? null;
		if (spikeHost) {
			this.flow = new P2pPairingFlow(spikeHost);
			this.unmountFlow = this.flow.mount(pairBody);
			// A pairing deep link may have handed a code over — the page
			// consumes it exactly once and pre-fills the join field.
			const pending = this.settingsHost.takePendingP2pPairCode?.() ?? null;
			if (pending) this.flow.prefillJoin(pending);
		} else {
			pairBody.createEl("div", {
				text: "The P2P link is not ready — reload the plugin.",
				cls: "yaos-p2p-copy",
			});
		}

		this.peerLine = c.createDiv({ cls: "yaos-p2p-peer-line" });

		this.refresh();
		this.refreshTimer = window.setInterval(() => this.refresh(), 1000);
	}

	hide(): void {
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
		this.peerLine = null;
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
				this.cardText.setText("The P2P link is not ready — reload the plugin.");
			}
		}
		if (this.peerLine) {
			const summary = this.settingsHost.getP2pPeerSummary?.() ?? "No P2P link yet.";
			this.peerLine.setText(`This vault — ${summary}`);
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
			return "Waiting for a device to join — share the pairing code or QR.";
		case "connecting":
			return "Connecting…";
		case "error":
			return s.error ? `Connection problem: ${s.error}` : "Connection problem.";
		default:
			return "No P2P link yet. Pair a device below to get started.";
	}
}

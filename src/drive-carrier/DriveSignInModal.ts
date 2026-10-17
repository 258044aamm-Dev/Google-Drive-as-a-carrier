import { App, Modal } from "obsidian";
import type { DeviceCodeInfo } from "./googleAuth";
import type { SignInUi } from "./signIn";

/** Shows the code the user types in at google.com/device while the plugin waits for approval. */
export class DriveSignInModal extends Modal implements SignInUi {
	private cancelled = false;
	private codeEl: HTMLElement | null = null;
	private linkEl: HTMLAnchorElement | null = null;
	private statusEl: HTMLElement | null = null;

	constructor(app: App, private readonly onCancel: () => void) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: "Sign in with Google" });
		this.statusEl = contentEl.createEl("p", { text: "Asking Google for a sign-in code..." });
		this.codeEl = contentEl.createEl("p", { cls: "yaos-drive-signin-code" });
		this.linkEl = contentEl.createEl("a", { text: "", href: "#" });
		this.linkEl.hide();
		contentEl.createEl("p", {
			text: "YAOS only asks for access to the files it creates itself. It cannot see the rest of your Drive.",
		});
	}

	showCode(info: DeviceCodeInfo): void {
		this.statusEl?.setText("On any device, open the page below and enter this code. Keep this window open until you finish.");
		if (this.codeEl) {
			this.codeEl.setText(info.userCode);
		}
		if (this.linkEl) {
			this.linkEl.setText(info.verificationUrl);
			this.linkEl.setAttr("href", info.verificationUrl);
			this.linkEl.show();
		}
	}

	showMessage(text: string): void {
		this.statusEl?.setText(text);
	}

	isCancelled(): boolean {
		return this.cancelled;
	}

	onClose(): void {
		this.cancelled = true;
		this.contentEl.empty();
		this.onCancel();
	}
}

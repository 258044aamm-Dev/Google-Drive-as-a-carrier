import { STATUS_ICONS, type SimpleStatus } from "./simpleStatus";

/**
 * A small status icon in the header of every note, next to the other view
 * buttons. It works on phones too, where there is no bottom bar.
 *
 * Obsidian owns each view's header, so this only adds one action per view and
 * removes it again. Nothing else in the view is touched.
 */

/** The part of an Obsidian view this needs (`MarkdownView` satisfies it). */
export interface HeaderView {
	addAction(icon: string, title: string, callback: (evt: MouseEvent) => void): HeaderActionElement;
}

/** The part of the header button this needs (Obsidian's `HTMLElement` satisfies it). */
export interface HeaderActionElement {
	setAttr(name: string, value: string): void;
	toggleClass(cls: string, value: boolean): void;
	remove(): void;
}

export interface HeaderStatusIconsDeps {
	setIcon(el: HeaderActionElement, icon: string): void;
	onClick(evt: MouseEvent): void;
}

const LEVEL_CLASSES = ["ok", "busy", "offline", "attention", "error"] as const;

export class HeaderStatusIcons {
	private readonly elements = new Map<HeaderView, HeaderActionElement>();
	private status: SimpleStatus | null = null;
	private enabled = true;
	private lastKey = "";

	constructor(private readonly deps: HeaderStatusIconsDeps) {}

	/** Switch the icons on or off (the setting). Off removes every one. */
	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		if (!enabled) this.removeAll();
	}

	/** The latest status. Cheap to call often: the icons only change when the status does. */
	update(status: SimpleStatus): void {
		this.status = status;
		const key = `${status.level}|${status.text}|${status.detail}`;
		if (key === this.lastKey) return;
		this.lastKey = key;
		for (const el of this.elements.values()) this.paint(el, status);
	}

	/** Give every open note view an icon and forget views that are gone. Call on layout changes. */
	sync(views: readonly HeaderView[]): void {
		if (!this.enabled) {
			this.removeAll();
			return;
		}
		const open = new Set(views);
		for (const [view, el] of this.elements) {
			if (!open.has(view)) {
				el.remove();
				this.elements.delete(view);
			}
		}
		for (const view of views) {
			if (this.elements.has(view)) continue;
			const first = this.status;
			const el = view.addAction(
				first ? STATUS_ICONS[first.level] : STATUS_ICONS.busy,
				first ? `YAOS: ${first.text}` : "YAOS",
				(evt) => { this.deps.onClick(evt); },
			);
			this.elements.set(view, el);
			if (first) this.paint(el, first);
		}
	}

	/** Remove every icon (plugin unload). */
	dispose(): void {
		this.removeAll();
		this.status = null;
		this.lastKey = "";
	}

	get count(): number {
		return this.elements.size;
	}

	private paint(el: HeaderActionElement, status: SimpleStatus): void {
		this.deps.setIcon(el, STATUS_ICONS[status.level]);
		el.setAttr("aria-label", `YAOS: ${status.text}`);
		for (const level of LEVEL_CLASSES) el.toggleClass(`yaos-status-${level}`, level === status.level);
		el.toggleClass("yaos-header-status", true);
	}

	private removeAll(): void {
		for (const el of this.elements.values()) el.remove();
		this.elements.clear();
	}
}

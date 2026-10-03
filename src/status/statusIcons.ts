/**
 * The header status icons: one cloud, with a small mark inside that says how
 * syncing is going. Drawn here (not borrowed from Obsidian's icon set) so the
 * shapes are the same in every Obsidian version, and so they stay readable at
 * header size: one outline weight, no tiny parts.
 *
 * Colour is not set here: the strokes use `currentColor`, and styles.css
 * colours the icon by state. The shapes differ too, so colour is never the
 * only cue.
 */

/** The ids registered with Obsidian (`addIcon`) and used with `setIcon`. */
export const STATUS_ICON_IDS = {
	ok: "yaos-status-ok",
	busy: "yaos-status-busy",
	offline: "yaos-status-offline",
	attention: "yaos-status-attention",
	error: "yaos-status-error",
} as const;

const CLOUD = '<path d="M30 76H69a18 18 0 0 0 5-35.3A25 25 0 0 0 27 44a16 16 0 0 0 3 32z"/>';

/** Inner marks, drawn on Obsidian's 100 x 100 icon canvas. */
const MARKS = {
	ok: '<path d="M38 59l9 9 17-19"/>',
	// A three-quarter ring that styles.css turns while syncing; the cloud stays still.
	busy: '<g class="yaos-spin"><path d="M50 51a9 9 0 1 1-9 9"/></g>',
	// A slash across the whole cloud.
	offline: '<path d="M20 22L80 82"/>',
	attention: '<path d="M50 49v12"/><path d="M50 69v.5"/>',
	error: '<path d="M42 51l16 16"/><path d="M58 51L42 67"/>',
} as const;

export type StatusIconLevel = keyof typeof STATUS_ICON_IDS;

/** The SVG content (without the outer `<svg>`) for one level, as `addIcon` expects. */
export function statusIconSvg(level: StatusIconLevel): string {
	return `<g fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">${CLOUD}${MARKS[level]}</g>`;
}

/** Register all five icons. `add` is Obsidian's `addIcon`. Safe to call again. */
export function registerStatusIcons(add: (id: string, svg: string) => void): void {
	for (const level of Object.keys(STATUS_ICON_IDS) as StatusIconLevel[]) {
		add(STATUS_ICON_IDS[level], statusIconSvg(level));
	}
}

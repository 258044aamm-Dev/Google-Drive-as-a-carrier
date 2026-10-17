/**
 * How many Markdown notes a vault document holds right now.
 *
 * Under the v1 (legacy) path model `pathToId` lists them. From schema v2 on,
 * `meta` is authoritative and `pathToId` is frozen or empty, so counting it
 * reports a healthy vault as having zero notes (the snapshot index of upstream
 * issue #78 showed `markdownFileCount: 0` for a vault with thousands of notes).
 */

import type * as Y from "yjs";
import { usesLegacyPathModel } from "./schemaModel";
import { isTombstone } from "./tombstoneReaper";

export function countActiveMarkdownFiles(doc: Y.Doc): number {
	if (usesLegacyPathModel(doc)) return doc.getMap<string>("pathToId").size;
	let active = 0;
	doc.getMap("meta").forEach((value) => {
		if (!isTombstone(value)) active++;
	});
	return active;
}

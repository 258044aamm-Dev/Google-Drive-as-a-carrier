/**
 * The Node.js modules the Local network carrier needs, loaded on demand.
 *
 * Obsidian on a phone has none of them, so nothing here may be imported at
 * the top of a file that the rest of the plugin loads. They are only ever
 * requested after `isLanSupported()` said yes. The bundler leaves the built-in
 * names alone, so this is a plain `require` at run time on the desktop and is
 * never evaluated elsewhere.
 */
import type * as Dgram from "dgram";
import type * as Https from "https";
import type * as Net from "net";
import type * as Os from "os";
import type * as Tls from "tls";
import type * as Crypto from "crypto";

export interface LanNodeModules {
	dgram: typeof Dgram;
	https: typeof Https;
	net: typeof Net;
	os: typeof Os;
	tls: typeof Tls;
	crypto: typeof Crypto;
}

let cached: LanNodeModules | null = null;

/** True when this runtime can open server sockets (the desktop app). */
export function isLanSupported(): boolean {
	try {
		return typeof process !== "undefined"
			&& typeof process.versions?.node === "string"
			&& typeof require === "function";
	} catch {
		return false;
	}
}

export function loadLanNode(): LanNodeModules {
	if (cached) return cached;
	if (!isLanSupported()) throw new Error("The Local network carrier needs the desktop app");
	/* eslint-disable @typescript-eslint/no-require-imports -- desktop-only built-ins, loaded lazily on purpose */
	cached = {
		dgram: require("dgram") as typeof Dgram,
		https: require("https") as typeof Https,
		net: require("net") as typeof Net,
		os: require("os") as typeof Os,
		tls: require("tls") as typeof Tls,
		crypto: require("crypto") as typeof Crypto,
	};
	/* eslint-enable @typescript-eslint/no-require-imports -- end of the lazy desktop-only loading */
	return cached;
}

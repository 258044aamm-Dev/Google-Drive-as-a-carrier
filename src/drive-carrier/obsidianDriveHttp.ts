import { requestUrl } from "obsidian";
import type { DriveHttp } from "./googleDriveRest";

/**
 * Sends the carrier's HTTP requests through Obsidian's `requestUrl`, which
 * works on desktop and mobile and is not blocked by browser CORS rules.
 * Never throws for an HTTP error status (the callers read the status); only a
 * real network failure rejects.
 */
export const obsidianDriveHttp: DriveHttp = async (request) => {
	let body: string | ArrayBuffer | undefined;
	if (typeof request.body === "string") {
		body = request.body;
	} else if (request.body) {
		const bytes = request.body;
		body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
	}
	const response = await requestUrl({
		url: request.url,
		method: request.method,
		headers: request.headers,
		body,
		throw: false,
	});
	// Headers travel with the response: the resumable upload session URL arrives
	// in the Location header of the first request.
	return { status: response.status, body: new Uint8Array(response.arrayBuffer), headers: response.headers };
};

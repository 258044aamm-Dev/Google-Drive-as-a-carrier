import { DriveError, type DriveApi, type DriveFileInfo, type DriveFolderInfo } from "./driveApi";

/** One HTTP request. The carrier never sees how it is sent (Obsidian's requestUrl, fetch, a test double). */
export interface DriveHttpRequest {
	url: string;
	method: "GET" | "POST" | "DELETE";
	headers: Record<string, string>;
	body?: Uint8Array | string;
}

export interface DriveHttpResponse {
	status: number;
	body: Uint8Array;
}

export type DriveHttp = (request: DriveHttpRequest) => Promise<DriveHttpResponse>;

/** Returns a valid OAuth access token. `forceRefresh` discards any cached one. */
export type AccessTokenProvider = (forceRefresh?: boolean) => Promise<string>;

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const FILE_FIELDS = "id,name,size,createdTime";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function escapeQueryValue(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

interface RawFile {
	id?: unknown;
	name?: unknown;
	size?: unknown;
	createdTime?: unknown;
}

function toFileInfo(raw: RawFile): DriveFileInfo {
	if (typeof raw.id !== "string" || typeof raw.name !== "string") {
		throw new DriveError(502, "Drive returned a file without id or name");
	}
	const size = typeof raw.size === "string" ? Number(raw.size) : typeof raw.size === "number" ? raw.size : 0;
	const created = typeof raw.createdTime === "string" ? Date.parse(raw.createdTime) : NaN;
	return { id: raw.id, name: raw.name, size, createdTime: Number.isFinite(created) ? created : 0 };
}

/** Google Drive v3 REST implementation of DriveApi (scope `drive.file` is enough). */
export class GoogleDriveRest implements DriveApi {
	constructor(
		private readonly http: DriveHttp,
		private readonly getAccessToken: AccessTokenProvider,
	) {}

	private async send(
		build: (token: string) => DriveHttpRequest,
	): Promise<DriveHttpResponse> {
		let res = await this.attempt(build, false);
		if (res.status === 401) {
			// The cached token may have expired between refresh and use.
			res = await this.attempt(build, true);
		}
		if (res.status < 200 || res.status >= 300) {
			throw new DriveError(res.status, `Drive request failed (${res.status}): ${decoder.decode(res.body).slice(0, 200)}`);
		}
		return res;
	}

	private async attempt(
		build: (token: string) => DriveHttpRequest,
		forceRefresh: boolean,
	): Promise<DriveHttpResponse> {
		let token: string;
		try {
			token = await this.getAccessToken(forceRefresh);
		} catch (err) {
			throw new DriveError(401, `Could not get an access token: ${err instanceof Error ? err.message : String(err)}`);
		}
		try {
			return await this.http(build(token));
		} catch (err) {
			throw new DriveError(0, `Network error: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private json(res: DriveHttpResponse): unknown {
		try {
			return JSON.parse(decoder.decode(res.body));
		} catch {
			throw new DriveError(502, "Drive returned a body that is not JSON");
		}
	}

	async findFolders(name: string): Promise<DriveFolderInfo[]> {
		const q = `name='${escapeQueryValue(name)}' and mimeType='${FOLDER_MIME}' and trashed=false`;
		const url = `${API}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent("files(id,name,createdTime)")}&pageSize=100&spaces=drive`;
		const res = await this.send((token) => ({ url, method: "GET", headers: { Authorization: `Bearer ${token}` } }));
		const body = this.json(res);
		const files = typeof body === "object" && body !== null && "files" in body && Array.isArray(body.files) ? body.files : [];
		return files.map((f: RawFile) => {
			const info = toFileInfo(f);
			return { id: info.id, createdTime: info.createdTime };
		});
	}

	async createFolder(name: string): Promise<DriveFolderInfo> {
		const url = `${API}/files?fields=${encodeURIComponent("id,name,createdTime")}`;
		const payload = JSON.stringify({ name, mimeType: FOLDER_MIME });
		const res = await this.send((token) => ({
			url,
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" },
			body: payload,
		}));
		const info = toFileInfo(this.json(res) as RawFile);
		return { id: info.id, createdTime: info.createdTime };
	}

	async listFiles(folderId: string): Promise<DriveFileInfo[]> {
		const q = `'${escapeQueryValue(folderId)}' in parents and trashed=false and mimeType!='${FOLDER_MIME}'`;
		const out: DriveFileInfo[] = [];
		let pageToken: string | undefined;
		do {
			let url = `${API}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(`nextPageToken,files(${FILE_FIELDS})`)}&pageSize=1000&spaces=drive`;
			if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
			const res = await this.send((token) => ({ url, method: "GET", headers: { Authorization: `Bearer ${token}` } }));
			const body = this.json(res);
			if (typeof body !== "object" || body === null) throw new DriveError(502, "Unexpected list response");
			const files = "files" in body && Array.isArray(body.files) ? body.files : [];
			for (const f of files) out.push(toFileInfo(f as RawFile));
			pageToken = "nextPageToken" in body && typeof body.nextPageToken === "string" ? body.nextPageToken : undefined;
		} while (pageToken);
		return out;
	}

	async createFile(folderId: string, name: string, data: Uint8Array): Promise<DriveFileInfo> {
		const boundary = `ogd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
		const meta = JSON.stringify({ name, parents: [folderId] });
		const head = encoder.encode(
			`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
			`--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
		);
		const tail = encoder.encode(`\r\n--${boundary}--`);
		const body = new Uint8Array(head.length + data.length + tail.length);
		body.set(head, 0);
		body.set(data, head.length);
		body.set(tail, head.length + data.length);
		const url = `${UPLOAD}/files?uploadType=multipart&fields=${encodeURIComponent(FILE_FIELDS)}`;
		const res = await this.send((token) => ({
			url,
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
			body,
		}));
		return toFileInfo(this.json(res) as RawFile);
	}

	async readFile(fileId: string): Promise<Uint8Array> {
		const url = `${API}/files/${encodeURIComponent(fileId)}?alt=media`;
		const res = await this.send((token) => ({ url, method: "GET", headers: { Authorization: `Bearer ${token}` } }));
		return res.body;
	}

	async deleteFile(fileId: string): Promise<void> {
		const url = `${API}/files/${encodeURIComponent(fileId)}`;
		await this.send((token) => ({ url, method: "DELETE", headers: { Authorization: `Bearer ${token}` } }));
	}
}

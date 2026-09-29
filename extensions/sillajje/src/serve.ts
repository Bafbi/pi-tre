/**
 * Serve — expose a session's workspace as static files over HTTP.
 *
 * The controller owns one server per pi process. Its root is fixed when it
 * starts and every request resolves inside that root. The module knows nothing
 * of sessions, jj, or pi: the adapter resolves a session target and drives the
 * controller from its command and lifecycle hooks.
 *
 * The server is created lazily by `start`, never by the extension factory, so
 * a pi invocation that never serves a session binds no socket.
 */

import {
	closeSync,
	constants,
	createReadStream,
	existsSync,
	fstatSync,
	openSync,
	readdirSync,
	realpathSync,
	type Stats,
	statSync,
} from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { networkInterfaces } from "node:os";
import { extname, join, resolve, sep } from "node:path";

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

/** Content types for the extensions a workspace report tends to use. */
const CONTENT_TYPES: Record<string, string> = {
	".css": "text/css; charset=utf-8",
	".gif": "image/gif",
	".htm": "text/html; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".ico": "image/x-icon",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".md": "text/markdown; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".mp4": "video/mp4",
	".pdf": "application/pdf",
	".png": "image/png",
	".svg": "image/svg+xml",
	".txt": "text/plain; charset=utf-8",
	".wasm": "application/wasm",
	".webm": "video/webm",
	".webp": "image/webp",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".xml": "application/xml; charset=utf-8",
};

/** The response content type for a file path, by extension. */
function contentTypeFor(file: string): string {
	return (
		CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream"
	);
}

/** Whether `path` is `root` or lives under it. */
function containedIn(root: string, path: string): boolean {
	const prefix = root.endsWith(sep) ? root : root + sep;
	return path === root || path.startsWith(prefix);
}

/** The outcome of resolving a request URL against the served root. */
export type RequestPathResult =
	| { ok: true; absPath: string }
	| { ok: false; status: 400 | 403 };

/**
 * Map a request URL to an absolute path under `root`.
 *
 * The URL parser normalizes literal dot segments; percent-decoding after that
 * catches encoded ones. A malformed escape or a NUL is a `400`; a path that
 * escapes the root is a `403`. The caller realpath-checks the result before
 * serving, which catches a symlink pointing outside the root.
 */
export function resolveRequestPath(
	root: string,
	requestUrl: string,
): RequestPathResult {
	let pathname: string;
	try {
		pathname = decodeURIComponent(
			new URL(requestUrl, "http://localhost").pathname,
		);
	} catch {
		return { ok: false, status: 400 };
	}
	if (pathname.includes("\0")) return { ok: false, status: 400 };

	const absPath = resolve(root, `.${pathname}`);
	if (!containedIn(root, absPath)) return { ok: false, status: 403 };
	return { ok: true, absPath };
}

/** Send a bare status response. */
function sendStatus(res: ServerResponse, status: 400 | 403 | 404): void {
	const message =
		status === 404
			? "Not Found"
			: status === 403
				? "Forbidden"
				: "Bad Request";
	res.writeHead(status, {
		"Content-Type": "text/plain; charset=utf-8",
		"Cache-Control": "no-store",
	});
	res.end(message);
}

/**
 * Run `callback` when the response has closed, whether it completed or the
 * client disconnected first. `finish` alone misses a premature disconnect, so
 * a gone-root stop bound to it could leave the server listening.
 */
export function onResponseClosed(
	res: ServerResponse,
	callback: () => void,
): void {
	res.once("close", callback);
}

/** Escape a string for HTML text and attribute context. */
function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/**
 * Stream a file, or send its headers only for a `HEAD` request.
 *
 * The file is opened with `O_NOFOLLOW` and streamed from the descriptor, so a
 * path swapped for a symlink between the containment check and the open fails
 * the open instead of serving the target. `O_NONBLOCK` keeps a swap to a FIFO
 * from blocking `open` (a static FIFO never reaches here — the `isFile()`
 * check rejects it first).
 */
function sendFile(res: ServerResponse, file: string, headOnly: boolean): void {
	let fd: number;
	try {
		fd = openSync(
			file,
			constants.O_RDONLY |
				(constants.O_NOFOLLOW || 0) |
				(constants.O_NONBLOCK || 0),
		);
	} catch {
		sendStatus(res, 404);
		return;
	}

	let stats: Stats;
	try {
		stats = fstatSync(fd);
	} catch {
		closeSync(fd);
		sendStatus(res, 404);
		return;
	}
	if (!stats.isFile()) {
		closeSync(fd);
		sendStatus(res, 404);
		return;
	}

	res.writeHead(200, {
		"Content-Type": contentTypeFor(file),
		"Content-Length": String(stats.size),
		"Cache-Control": "no-store",
	});
	if (headOnly) {
		closeSync(fd);
		res.end();
		return;
	}
	// The stream owns the descriptor (`autoClose` is on by default).
	createReadStream(file, { fd })
		.on("error", () => res.destroy())
		.pipe(res);
}

/** Render a directory index. */
function sendListing(
	res: ServerResponse,
	dir: string,
	root: string,
	headOnly: boolean,
): void {
	let entries: Array<{ name: string; dir: boolean }>;
	try {
		entries = readdirSync(dir, { withFileTypes: true }).map((entry) => ({
			name: entry.name,
			dir: entry.isDirectory(),
		}));
	} catch {
		sendStatus(res, 404);
		return;
	}
	entries.sort((a, b) => a.name.localeCompare(b.name));

	const rows = entries
		.map((entry) => {
			const label = escapeHtml(entry.name) + (entry.dir ? "/" : "");
			const href =
				encodeURIComponent(entry.name) + (entry.dir ? "/" : "");
			return `<li><a href="${href}">${label}</a></li>`;
		})
		.join("\n");
	const parent =
		resolve(dir) === resolve(root)
			? ""
			: '<li><a href="../">../</a></li>\n';
	const body = `<!doctype html>
<meta charset="utf-8">
<title>${escapeHtml(dir)}</title>
<h1>${escapeHtml(dir)}</h1>
<ul>
${parent}${rows}
</ul>
`;
	const bytes = Buffer.byteLength(body);
	res.writeHead(200, {
		"Content-Type": "text/html; charset=utf-8",
		"Content-Length": String(bytes),
		"Cache-Control": "no-store",
	});
	res.end(headOnly ? undefined : body);
}

/** Serve one request from the root. */
function serveRequest(
	res: ServerResponse,
	req: IncomingMessage,
	root: string,
	rootReal: string,
): void {
	const resolved = resolveRequestPath(root, req.url ?? "/");
	if (!resolved.ok) {
		sendStatus(res, resolved.status);
		return;
	}

	let real: string;
	let stats: Stats;
	try {
		real = realpathSync(resolved.absPath);
		stats = statSync(real);
	} catch {
		sendStatus(res, 404);
		return;
	}
	if (!containedIn(rootReal, real)) {
		sendStatus(res, 403);
		return;
	}

	const headOnly = req.method === "HEAD";
	if (stats.isDirectory()) {
		// A listing's links are relative, so a request without the trailing
		// slash would resolve them against the parent URL.
		const url = new URL(req.url ?? "/", "http://localhost");
		if (!url.pathname.endsWith("/")) {
			res.writeHead(301, {
				Location: `${url.pathname}/${url.search}`,
				"Cache-Control": "no-store",
			});
			res.end();
			return;
		}
		const index = join(real, "index.html");
		try {
			const indexReal = realpathSync(index);
			if (!containedIn(rootReal, indexReal)) {
				sendStatus(res, 403);
				return;
			}
			if (statSync(indexReal).isFile()) {
				sendFile(res, indexReal, headOnly);
				return;
			}
		} catch {
			// No index.html — fall through to the listing.
		}
		sendListing(res, real, root, headOnly);
		return;
	}
	if (!stats.isFile()) {
		sendStatus(res, 404);
		return;
	}
	sendFile(res, real, headOnly);
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/** The live server's addressable facts. */
export interface ServeStatus {
	/** The session whose workspace is served. */
	sessionKey: string;
	/** The served directory, absolute. */
	root: string;
	/** The bound TCP port. */
	port: number;
	/**
	 * A URL reachable from this host: `localhost` for a wildcard bind, the
	 * bound address otherwise, IPv6 literals bracketed.
	 */
	localUrl: string;
	/**
	 * The LAN URLs reachable through the bound host: every non-internal IPv4
	 * for a wildcard bind, the named address for a specific one, and empty for
	 * a loopback bind.
	 */
	lanUrls: string[];
}

interface ServeStartInput {
	sessionKey: string;
	root: string;
	/** Called once when a request finds the root gone; the server stops. */
	onRootGone?: () => void;
}

export interface ServeControllerOptions {
	/** Interface to bind. Defaults to `0.0.0.0` so the LAN can reach it. */
	host?: string;
}

export interface ServeController {
	start(input: ServeStartInput): Promise<ServeStatus>;
	stop(): Promise<void>;
	status(): ServeStatus | undefined;
}

/**
 * The LAN URLs for a port under the bound host. A wildcard bind offers every
 * non-internal IPv4 address; a specific bind offers only its own address, so
 * a loopback bind offers none.
 */
function lanUrlsFor(port: number, host: string): string[] {
	const wildcard = host === "" || host === "0.0.0.0" || host === "::";
	const urls: string[] = [];
	for (const entries of Object.values(networkInterfaces())) {
		for (const entry of entries ?? []) {
			if (entry.family !== "IPv4" || entry.internal) continue;
			if (!wildcard && entry.address !== host) continue;
			urls.push(`http://${entry.address}:${port}`);
		}
	}
	return urls;
}

/**
 * The URL that reaches the server from this host. A wildcard bind answers on
 * `localhost`; a specific bind answers only on the bound address, so the URL
 * names it — a non-loopback `host` makes `localhost` unreachable.
 */
export function localUrlFor(port: number, host: string): string {
	const wildcard = host === "" || host === "0.0.0.0" || host === "::";
	const name = wildcard
		? "localhost"
		: host.includes(":")
			? `[${host}]`
			: host;
	return `http://${name}:${port}`;
}

/** Bind the server on an ephemeral port and resolve the chosen port. */
function listen(server: Server, host: string): Promise<number> {
	return new Promise((resolvePort, rejectPort) => {
		const onError = (error: Error) => rejectPort(error);
		server.once("error", onError);
		server.listen(0, host, () => {
			server.removeListener("error", onError);
			const address = server.address();
			if (address === null || typeof address === "string") {
				rejectPort(new Error("serve: server bound no TCP port"));
				return;
			}
			resolvePort(address.port);
		});
	});
}

export function createServeController(
	options: ServeControllerOptions = {},
): ServeController {
	const host = options.host ?? "0.0.0.0";
	let active:
		| { status: ServeStatus; server: Server; rootReal: string }
		| undefined;
	// A start that has not yet published `active`. Reserving here rejects a
	// concurrent start during the `listen` await, so one controller never
	// leaks a second bound socket.
	let reserved = false;
	let cancelled = false;

	const stop = async (): Promise<void> => {
		if (reserved) {
			cancelled = true;
			return;
		}
		const current = active;
		active = undefined;
		if (current === undefined) return;
		current.server.closeAllConnections();
		await new Promise<void>((done) => current.server.close(() => done()));
	};

	return {
		async start(input) {
			if (active !== undefined) {
				throw new Error(
					`serve: already serving session ${active.status.sessionKey}`,
				);
			}
			if (reserved) {
				throw new Error("serve: start already in progress");
			}
			reserved = true;
			cancelled = false;
			try {
				const root = resolve(input.root);
				if (!existsSync(root)) {
					throw new Error(
						`serve: workspace directory not found: ${root}`,
					);
				}
				const rootReal = realpathSync(root);

				let gone = false;
				const server = createServer((req, res) => {
					if (!gone && !existsSync(root)) {
						gone = true;
						sendStatus(res, 404);
						// Stop once the response closes: `close` fires for a completed
						// response and for a client that disconnects first. `stop` marks
						// the controller idle synchronously, so the callback sees
						// `status()` undefined and clears the footer.
						onResponseClosed(res, () => {
							void stop();
							input.onRootGone?.();
						});
						return;
					}
					serveRequest(res, req, root, rootReal);
				});

				let port: number;
				try {
					port = await listen(server, host);
				} catch (error) {
					server.close();
					throw error;
				}
				if (cancelled) {
					server.closeAllConnections();
					await new Promise<void>((done) =>
						server.close(() => done()),
					);
					throw new Error("serve: start cancelled");
				}

				const status: ServeStatus = {
					sessionKey: input.sessionKey,
					root,
					port,
					localUrl: localUrlFor(port, host),
					lanUrls: lanUrlsFor(port, host),
				};
				active = { status, server, rootReal };
				return status;
			} finally {
				reserved = false;
			}
		},
		stop,
		status: () => active?.status,
	};
}

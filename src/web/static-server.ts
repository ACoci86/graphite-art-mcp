/**
 * Minimal static file server for the pre-built Graphite web app. Loopback only, GET/HEAD only, no directory listings,
 * paths confined to the root. Unknown extension-less paths fall back to index.html (Graphite is a single-page app).
 */

import { createReadStream, promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";

export interface StaticServerOptions {
	root: string;
	host: string;
	/** 0 picks a free port. */
	port: number;
	log: (message: string) => void;
}

export interface StaticServer {
	url: string;
	port: number;
	close(): Promise<void>;
}

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".webmanifest": "application/manifest+json",
	".graphite": "application/json",
	".wasm": "application/wasm",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".xml": "application/xml",
	".txt": "text/plain; charset=utf-8",
	".map": "application/json",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".otf": "font/otf",
};

/** Files whose freshness matters (the entry page and the service worker) are never cached; hashed assets may be. */
function cacheControl(relativePath: string): string {
	const base = path.basename(relativePath);
	if (base === "index.html" || base === "service-worker.js") return "no-cache";
	return "public, max-age=3600";
}

export async function resolveRequestPath(root: string, urlPath: string): Promise<{ filePath: string; relative: string } | undefined> {
	let decoded: string;
	try {
		decoded = decodeURIComponent(urlPath.split("?")[0] ?? "/");
	} catch {
		return undefined;
	}
	if (decoded.includes("\0")) return undefined;
	const rootResolved = path.resolve(root);
	const candidate = path.resolve(rootResolved, `.${decoded.startsWith("/") ? decoded : `/${decoded}`}`);
	if (candidate !== rootResolved && !candidate.startsWith(rootResolved + path.sep)) return undefined;

	const tryFile = async (file: string): Promise<{ filePath: string; relative: string } | undefined> => {
		try {
			const stat = await fs.stat(file);
			if (stat.isFile()) return { filePath: file, relative: path.relative(rootResolved, file) };
			if (stat.isDirectory()) {
				const index = path.join(file, "index.html");
				const indexStat = await fs.stat(index).catch(() => undefined);
				if (indexStat?.isFile()) return { filePath: index, relative: path.relative(rootResolved, index) };
			}
		} catch {
			/* not found */
		}
		return undefined;
	};

	const direct = await tryFile(candidate);
	if (direct) return direct;
	// Single-page-app fallback: paths without an extension render the entry page
	if (path.extname(candidate) === "") return tryFile(path.join(rootResolved, "index.html"));
	return undefined;
}

export function startStaticServer(options: StaticServerOptions): Promise<StaticServer> {
	const root = path.resolve(options.root);
	const server = http.createServer(async (req, res) => {
		try {
			if (req.method !== "GET" && req.method !== "HEAD") {
				res.writeHead(405, { Allow: "GET, HEAD" }).end();
				return;
			}
			const resolved = await resolveRequestPath(root, req.url ?? "/");
			if (!resolved) {
				res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
				return;
			}
			const stat = await fs.stat(resolved.filePath);
			res.writeHead(200, {
				"Content-Type": CONTENT_TYPES[path.extname(resolved.filePath).toLowerCase()] ?? "application/octet-stream",
				"Content-Length": stat.size,
				"Cache-Control": cacheControl(resolved.relative),
				"X-Content-Type-Options": "nosniff",
			});
			if (req.method === "HEAD") {
				res.end();
				return;
			}
			createReadStream(resolved.filePath).pipe(res);
		} catch (error) {
			options.log(`static server error: ${error instanceof Error ? error.message : String(error)}`);
			if (!res.headersSent) res.writeHead(500).end();
		}
	});

	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port, options.host, () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : options.port;
			const hostForUrl = options.host.includes(":") ? `[${options.host}]` : options.host;
			resolve({
				url: `http://${hostForUrl}:${port}`,
				port,
				close: () => new Promise<void>((done) => server.close(() => done())),
			});
		});
	});
}

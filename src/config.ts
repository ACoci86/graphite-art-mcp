/**
 * Runtime configuration, read from environment variables so it works identically under Claude Desktop,
 * Claude Code, or any other MCP host that launches the binary over stdio.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import path from "node:path";
import { DEFAULT_BUNDLE_URL } from "./version.js";

export interface Config {
	host: string;
	port: number;
	token: string;
	/** Where the token came from: the environment, the cache file from an earlier run, or freshly generated (and cached). */
	tokenSource: "env" | "cache" | "generated";
	/** @deprecated use `tokenSource`; true when the token was not supplied through the environment. */
	tokenWasGenerated: boolean;
	allowedOrigins: string[];
	requestTimeoutMs: number;
	exportTimeoutMs: number;
	/** Extra budget per SVG element for insert_svg: Graphite builds one layer per element. */
	insertMsPerElement: number;
	/** After an insert wait expires, how long the connector keeps polling get_document before reporting failure. */
	insertGraceMs: number;
	/** Directories exports may be written to. Paths outside these are refused. */
	exportRoots: string[];
	/** Directory used when a tool call gives no path. Always inside `exportRoots`. */
	defaultExportDir: string;
	/** Per-user cache: downloaded Graphite web bundles and the generated token. */
	cacheDir: string;
	/** Serve a pre-built (patched) Graphite web app locally so users need no Rust toolchain. */
	serveWeb: boolean;
	/** Port for that local web server. */
	webPort: number;
	/** A ready-built Graphite `frontend/dist` folder to serve instead of downloading the release bundle. */
	webDir: string | undefined;
	/** Where to download the bundle from when `webDir` is not set. */
	bundleUrl: string;
	/** Optional hex SHA-256 the downloaded bundle must match. */
	bundleSha256: string | undefined;
	/** Open the served Graphite in the default browser when no tab connects shortly after start. */
	openBrowser: boolean;
	/** Extra directories with .ttf/.otf files for outlining `<text>`; the bundled Liberation faces are always included. */
	fontDirs: string[];
}

export const DEFAULT_PORT = 47832;
export const DEFAULT_WEB_PORT = 47833;
const TOKEN_FILE = "token";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	const host = env.GRAPHITE_MCP_HOST?.trim() || "127.0.0.1";
	const port = parsePort(env.GRAPHITE_MCP_PORT) ?? DEFAULT_PORT;
	const cacheDir = path.resolve(env.GRAPHITE_MCP_CACHE_DIR?.trim() || defaultCacheDir());

	const { token, tokenSource } = resolveToken(env.GRAPHITE_MCP_TOKEN?.trim(), cacheDir);

	const defaultExportDir = path.resolve(env.GRAPHITE_MCP_EXPORT_DIR?.trim() || path.join(homedir(), "graphite-mcp-exports"));
	const extraRoots = (env.GRAPHITE_MCP_EXPORT_ROOTS ?? "")
		.split(path.delimiter)
		.map((s) => s.trim())
		.filter(Boolean)
		.map((s) => path.resolve(s));

	const webDir = env.GRAPHITE_MCP_WEB_DIR?.trim();
	const bundleSha256 = env.GRAPHITE_MCP_BUNDLE_SHA256?.trim().toLowerCase();

	return {
		host,
		port,
		token,
		tokenSource,
		tokenWasGenerated: tokenSource !== "env",
		allowedOrigins: (env.GRAPHITE_MCP_ALLOWED_ORIGINS ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
		requestTimeoutMs: parsePositiveInt(env.GRAPHITE_MCP_REQUEST_TIMEOUT_MS) ?? 15_000,
		exportTimeoutMs: parsePositiveInt(env.GRAPHITE_MCP_EXPORT_TIMEOUT_MS) ?? 60_000,
		insertMsPerElement: parsePositiveInt(env.GRAPHITE_MCP_INSERT_MS_PER_ELEMENT) ?? 40,
		insertGraceMs: parsePositiveInt(env.GRAPHITE_MCP_INSERT_GRACE_MS) ?? 30_000,
		exportRoots: [defaultExportDir, ...extraRoots],
		defaultExportDir,
		cacheDir,
		serveWeb: !isFalse(env.GRAPHITE_MCP_SERVE),
		webPort: parsePort(env.GRAPHITE_MCP_WEB_PORT) ?? DEFAULT_WEB_PORT,
		webDir: webDir ? path.resolve(webDir) : undefined,
		bundleUrl: env.GRAPHITE_MCP_BUNDLE_URL?.trim() || DEFAULT_BUNDLE_URL,
		bundleSha256: bundleSha256 && /^[0-9a-f]{64}$/.test(bundleSha256) ? bundleSha256 : undefined,
		openBrowser: !isFalse(env.GRAPHITE_MCP_OPEN_BROWSER),
		fontDirs: (env.GRAPHITE_MCP_FONT_DIR ?? "")
			.split(path.delimiter)
			.map((s) => s.trim())
			.filter(Boolean)
			.map((s) => path.resolve(s)),
	};
}

/**
 * Prefer the environment; otherwise reuse the token generated on an earlier run (so a Graphite tab that remembered it
 * keeps working across restarts); otherwise generate one and try to cache it.
 */
function resolveToken(fromEnv: string | undefined, cacheDir: string): { token: string; tokenSource: Config["tokenSource"] } {
	if (fromEnv && fromEnv.length >= 16) return { token: fromEnv, tokenSource: "env" };
	const file = path.join(cacheDir, TOKEN_FILE);
	try {
		const cached = readFileSync(file, "utf8").trim();
		if (cached.length >= 16) return { token: cached, tokenSource: "cache" };
	} catch {
		/* no cached token yet */
	}
	const token = randomBytes(24).toString("base64url");
	try {
		mkdirSync(cacheDir, { recursive: true });
		writeFileSync(file, `${token}\n`, { mode: 0o600 });
	} catch {
		/* read-only cache: the token is per run, as before */
	}
	return { token, tokenSource: "generated" };
}

export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
	const home = homedir();
	switch (platform()) {
		case "win32":
			return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "graphite-art-mcp");
		case "darwin":
			return path.join(home, "Library", "Caches", "graphite-art-mcp");
		default:
			return path.join(env.XDG_CACHE_HOME || path.join(home, ".cache"), "graphite-art-mcp");
	}
}

function isFalse(value: string | undefined): boolean {
	const v = value?.trim().toLowerCase();
	return v === "0" || v === "false" || v === "no" || v === "off";
}

function parsePort(value: string | undefined): number | undefined {
	const n = parsePositiveInt(value);
	return n !== undefined && n <= 65535 ? n : undefined;
}

function parsePositiveInt(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const n = Number.parseInt(value, 10);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

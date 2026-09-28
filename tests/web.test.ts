/**
 * The local web server for the pre-built Graphite app, and the bundle installer, tested hermetically: the "release
 * asset" is a tarball created on the fly and served from a throwaway HTTP server.
 */
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { create as createTar } from "tar";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultCacheDir, loadConfig } from "../src/config.js";
import { ensureWebBundle } from "../src/web/bundle.js";
import { resolveRequestPath, startStaticServer, type StaticServer } from "../src/web/static-server.js";

let tmp: string;
beforeEach(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "graphite-web-test-"));
});
afterEach(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

async function makeSite(dir: string): Promise<void> {
	await fs.mkdir(path.join(dir, "assets"), { recursive: true });
	await fs.writeFile(path.join(dir, "index.html"), "<!doctype html><title>Graphite</title>");
	await fs.writeFile(path.join(dir, "assets", "index-abc123.js"), "console.log(1)");
	await fs.writeFile(path.join(dir, "assets", "graphite_wasm_wrapper_bg.wasm"), Buffer.from([0, 0x61, 0x73, 0x6d]));
	await fs.writeFile(path.join(dir, "service-worker.js"), "// sw");
}

describe("static server", () => {
	let server: StaticServer;
	afterEach(async () => {
		await server?.close();
	});

	it("serves files with the right types, falls back to index.html for routes, and confines paths to the root", async () => {
		const site = path.join(tmp, "site");
		await makeSite(site);
		server = await startStaticServer({ root: site, host: "127.0.0.1", port: 0, log: () => undefined });
		expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

		const index = await fetch(`${server.url}/`);
		expect(index.status).toBe(200);
		expect(index.headers.get("content-type")).toContain("text/html");
		expect(index.headers.get("cache-control")).toBe("no-cache");
		expect(await index.text()).toContain("Graphite");

		const js = await fetch(`${server.url}/assets/index-abc123.js`);
		expect(js.headers.get("content-type")).toContain("text/javascript");
		expect(js.headers.get("cache-control")).toContain("max-age");

		const wasm = await fetch(`${server.url}/assets/graphite_wasm_wrapper_bg.wasm`);
		expect(wasm.headers.get("content-type")).toBe("application/wasm");
		expect((await wasm.arrayBuffer()).byteLength).toBe(4);

		const route = await fetch(`${server.url}/some/app/route?automation=abc`);
		expect(route.status).toBe(200);
		expect(await route.text()).toContain("Graphite");

		expect((await fetch(`${server.url}/missing.png`)).status).toBe(404);
		expect((await fetch(`${server.url}/..%2F..%2Fetc%2Fpasswd`)).status).toBe(404);
		expect((await fetch(`${server.url}/`, { method: "POST" })).status).toBe(405);
		const head = await fetch(`${server.url}/assets/index-abc123.js`, { method: "HEAD" });
		expect(head.status).toBe(200);
		expect(await head.text()).toBe("");
	});

	it("falls back to a free port when the configured one is taken", async () => {
		const site = path.join(tmp, "site");
		await makeSite(site);
		server = await startStaticServer({ root: site, host: "127.0.0.1", port: 0, log: () => undefined });
		const logs: string[] = [];
		const second = await startStaticServer({ root: site, host: "127.0.0.1", port: server.port, log: (m) => logs.push(m) });
		expect(second.port).not.toBe(server.port);
		expect((await fetch(`${second.url}/`)).status).toBe(200);
		expect(logs.some((m) => m.includes("already in use"))).toBe(true);
		await second.close();
	});

	it("never resolves outside the root", async () => {
		const site = path.join(tmp, "site");
		await makeSite(site);
		await fs.writeFile(path.join(tmp, "secret.txt"), "x");
		expect(await resolveRequestPath(site, "/../secret.txt")).toBeUndefined();
		expect(await resolveRequestPath(site, "/%2e%2e/secret.txt")).toBeUndefined();
		expect((await resolveRequestPath(site, "/assets/index-abc123.js"))?.relative).toBe(path.join("assets", "index-abc123.js"));
		expect((await resolveRequestPath(site, "/"))?.relative).toBe("index.html");
	});
});

describe("bundle installer", () => {
	let assetServer: http.Server;
	let hits = 0;
	let assetUrl: string;

	async function publishTarball(archive: string): Promise<void> {
		hits = 0;
		assetServer = http.createServer((req, res) => {
			hits += 1;
			if (req.url?.endsWith("/missing.tar.gz")) {
				res.writeHead(404).end();
				return;
			}
			fs.readFile(archive).then((bytes) => res.writeHead(200, { "Content-Type": "application/gzip", "Content-Length": bytes.length }).end(bytes));
		});
		await new Promise<void>((r) => assetServer.listen(0, "127.0.0.1", () => r()));
		const address = assetServer.address();
		assetUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
	}
	afterEach(async () => {
		await new Promise<void>((r) => (assetServer ? assetServer.close(() => r()) : r()));
	});

	it("downloads once, verifies the hash, extracts, and reuses the cache afterwards", async () => {
		const dist = path.join(tmp, "dist");
		await makeSite(dist);
		const archive = path.join(tmp, "graphite-web.tar.gz");
		await createTar({ gzip: true, file: archive, cwd: dist }, ["."]);
		const { createHash } = await import("node:crypto");
		const sha = createHash("sha256").update(await fs.readFile(archive)).digest("hex");
		await publishTarball(archive);

		const cache = path.join(tmp, "cache");
		const logs: string[] = [];
		const dir = await ensureWebBundle({ url: `${assetUrl}/graphite-web.tar.gz`, sha256: sha, cacheDir: cache, version: "9.9.9", log: (m) => logs.push(m) });
		expect(dir).toBe(path.join(cache, "web", "9.9.9"));
		expect(await fs.readFile(path.join(dir, "index.html"), "utf8")).toContain("Graphite");
		expect(await fs.readFile(path.join(dir, "assets", "index-abc123.js"), "utf8")).toBe("console.log(1)");
		expect(hits).toBe(1);
		// No leftovers
		expect(await fs.readdir(path.join(cache, "downloads"))).toEqual([]);

		const again = await ensureWebBundle({ url: `${assetUrl}/graphite-web.tar.gz`, cacheDir: cache, version: "9.9.9", log: () => undefined });
		expect(again).toBe(dir);
		expect(hits).toBe(1);

		await expect(ensureWebBundle({ url: `${assetUrl}/graphite-web.tar.gz`, sha256: "0".repeat(64), cacheDir: cache, version: "1.0.0", log: () => undefined })).rejects.toThrow(/SHA-256/);
		await expect(ensureWebBundle({ url: `${assetUrl}/missing.tar.gz`, cacheDir: cache, version: "1.0.1", log: () => undefined })).rejects.toThrow(/HTTP 404/);
	});

	it("accepts an archive that wraps the site in one folder", async () => {
		const dist = path.join(tmp, "dist");
		await makeSite(dist);
		const archive = path.join(tmp, "wrapped.tar.gz");
		await createTar({ gzip: true, file: archive, cwd: tmp }, ["dist"]);
		await publishTarball(archive);
		const dir = await ensureWebBundle({ url: `${assetUrl}/wrapped.tar.gz`, cacheDir: path.join(tmp, "cache"), version: "2.0.0", log: () => undefined });
		expect(await fs.readFile(path.join(dir, "index.html"), "utf8")).toContain("Graphite");
	});
});

describe("config for the served app", () => {
	it("defaults to serving on 47833 with a cached token, and honours the overrides", () => {
		const cache = path.join(tmp, "cache");
		const a = loadConfig({ GRAPHITE_MCP_CACHE_DIR: cache });
		expect(a.serveWeb).toBe(true);
		expect(a.webPort).toBe(47833);
		expect(a.openBrowser).toBe(true);
		expect(a.tokenSource).toBe("generated");
		expect(a.bundleUrl).toMatch(/releases\/download\/v0\.2\.1\/graphite-web\.tar\.gz$/);
		// A second load reuses the generated token
		const b = loadConfig({ GRAPHITE_MCP_CACHE_DIR: cache });
		expect(b.token).toBe(a.token);
		expect(b.tokenSource).toBe("cache");
		// The environment wins
		const c = loadConfig({ GRAPHITE_MCP_CACHE_DIR: cache, GRAPHITE_MCP_TOKEN: "explicit-token-0123456789" });
		expect(c.tokenSource).toBe("env");
		expect(c.tokenWasGenerated).toBe(false);

		const d = loadConfig({
			GRAPHITE_MCP_CACHE_DIR: cache,
			GRAPHITE_MCP_SERVE: "0",
			GRAPHITE_MCP_OPEN_BROWSER: "false",
			GRAPHITE_MCP_WEB_PORT: "5000",
			GRAPHITE_MCP_WEB_DIR: "./somewhere",
			GRAPHITE_MCP_BUNDLE_URL: "https://example.invalid/x.tar.gz",
			GRAPHITE_MCP_BUNDLE_SHA256: "AB".repeat(32),
		});
		expect(d.serveWeb).toBe(false);
		expect(d.openBrowser).toBe(false);
		expect(d.webPort).toBe(5000);
		expect(d.webDir).toBe(path.resolve("./somewhere"));
		expect(d.bundleUrl).toBe("https://example.invalid/x.tar.gz");
		expect(d.bundleSha256).toBe("ab".repeat(32));
		expect(defaultCacheDir({})).toContain("graphite-art-mcp");
	});
});

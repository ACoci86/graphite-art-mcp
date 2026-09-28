#!/usr/bin/env node
/**
 * Entry point: stdio MCP transport (what Claude Desktop / Claude Code launch) plus the localhost WebSocket
 * endpoint that the Graphite editor tab connects to. Everything diagnostic goes to stderr; stdout is the MCP channel.
 *
 * Unless disabled, it also serves a pre-built patched Graphite web app locally (downloaded once per version) and opens
 * it in the browser with the session token, so end users need neither a Rust toolchain nor manual token handling.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { promises as fs } from "node:fs";
import { DEFAULT_PORT, loadConfig, type Config } from "./config.js";
import { runDoctor } from "./doctor.js";
import { createGraphiteMcp, type GraphiteMcp } from "./server.js";
import { CONNECTOR_VERSION } from "./version.js";
import { openInBrowser } from "./web/browser.js";
import { ensureWebBundle } from "./web/bundle.js";
import { startStaticServer, type StaticServer } from "./web/static-server.js";

const log = (message: string): void => {
	process.stderr.write(`[graphite-art-mcp] ${message}\n`);
};

/** The URL a browser must open to attach a Graphite tab to this connector. */
export function tabUrl(webUrl: string, config: Config): string {
	const params = new URLSearchParams({ automation: config.token });
	if (config.port !== DEFAULT_PORT || config.host !== "127.0.0.1") params.set("automationEndpoint", `ws://${config.host}:${config.port}`);
	return `${webUrl}/?${params.toString()}`;
}

async function serveGraphite(config: Config, mcp: GraphiteMcp): Promise<StaticServer | undefined> {
	try {
		const webDir = config.webDir ?? (await ensureWebBundle({ url: config.bundleUrl, sha256: config.bundleSha256, cacheDir: config.cacheDir, version: CONNECTOR_VERSION, log }));
		const web = await startStaticServer({ root: webDir, host: config.host, port: config.webPort, log });
		const url = tabUrl(web.url, config);
		mcp.runtime.webUrl = url;
		log(`serving Graphite at ${web.url}; open ${url} to connect a tab (the token is in the URL and is remembered by the tab)`);
		if (config.openBrowser) {
			// Give a tab from a previous run a moment to reconnect before opening another one
			setTimeout(() => {
				if (!mcp.client.connected) {
					log("no Graphite tab connected yet; opening one in your browser");
					openInBrowser(url, log);
				}
			}, 3_000).unref();
		}
		return web;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		log(`Graphite web app unavailable: ${reason}`);
		log("Fallback: run a patched Graphite yourself (README → Developer setup), or point GRAPHITE_MCP_WEB_DIR at a built frontend/dist folder, or set GRAPHITE_MCP_SERVE=0 to silence this.");
		return undefined;
	}
}

async function main(): Promise<void> {
	const command = process.argv[2];
	if (command === "doctor") {
		process.exit(await runDoctor(loadConfig()));
	}
	if (command === "--version" || command === "-v") {
		process.stdout.write(`graphite-art-mcp ${CONNECTOR_VERSION}\n`);
		return;
	}
	if (command === "--help" || command === "-h") {
		process.stdout.write("Usage: graphite-art-mcp            start the MCP server over stdio (what your MCP client runs)\n       graphite-art-mcp doctor     check Node, ports, token, web app, exports and fonts\n");
		return;
	}
	const config = loadConfig();
	await fs.mkdir(config.defaultExportDir, { recursive: true }).catch(() => undefined);

	const mcp = createGraphiteMcp(config, log);
	await mcp.client.listen();

	log(`v${CONNECTOR_VERSION} ready. Exports go to ${config.defaultExportDir}`);
	switch (config.tokenSource) {
		case "env":
			log("using GRAPHITE_MCP_TOKEN from the environment");
			break;
		case "cache":
			log(`using the session token saved in ${config.cacheDir} (set GRAPHITE_MCP_TOKEN to choose your own)`);
			break;
		case "generated":
			log(`generated a session token and saved it in ${config.cacheDir} so it stays stable across restarts`);
			break;
	}
	if (!config.serveWeb) {
		log(`GRAPHITE_MCP_SERVE=0: not serving Graphite. Open your own patched Graphite with ?automation=${config.token}`);
	}

	// Connect the MCP transport first so the host's handshake never waits for a download
	const transport = new StdioServerTransport();
	await mcp.server.connect(transport);

	let web: StaticServer | undefined;
	if (config.serveWeb) void serveGraphite(config, mcp).then((server) => (web = server));

	const shutdown = async (signal: string): Promise<void> => {
		log(`${signal} received, shutting down`);
		await web?.close().catch(() => undefined);
		await mcp.close().catch(() => undefined);
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
	// When the MCP host closes stdin or stdout, exit so we do not linger holding the port
	process.stdin.on("end", () => void shutdown("stdin closed"));
	process.stdout.on("error", (error: NodeJS.ErrnoException) => {
		if (error.code === "EPIPE") void shutdown("stdout closed");
		else log(`stdout error: ${error.message}`);
	});
}

main().catch((error) => {
	log(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
	process.exit(1);
});

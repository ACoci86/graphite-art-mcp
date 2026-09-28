/**
 * `graphite-art-mcp doctor`: checks the local setup and prints what to fix. Runs without an MCP host, so it can be
 * called from a terminal to answer "why does Graphite not connect?".
 */

import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { WebSocket } from "ws";
import type { Config } from "./config.js";
import { PROTOCOL_VERSION } from "./graphite/protocol.js";
import { bundledFontDir } from "./svg/fonts.js";
import { CONNECTOR_VERSION } from "./version.js";

type Status = "ok" | "warn" | "fail";
interface CheckResult {
	status: Status;
	name: string;
	detail: string;
}

export async function runDoctor(config: Config, write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): Promise<number> {
	const results: CheckResult[] = [];
	const add = (status: Status, name: string, detail: string): void => {
		results.push({ status, name, detail });
	};

	const [major] = process.versions.node.split(".").map(Number);
	add(major !== undefined && major >= 20 ? "ok" : "fail", "Node.js", `${process.version}${major !== undefined && major >= 20 ? "" : " (20 or newer is required)"}`);
	add("ok", "Connector", `v${CONNECTOR_VERSION}, protocol ${PROTOCOL_VERSION}`);
	add(config.tokenSource === "env" ? "ok" : "ok", "Session token", config.tokenSource === "env" ? "from GRAPHITE_MCP_TOKEN" : `cached in ${path.join(config.cacheDir, "token")}`);

	// Ports: is a connector already running (good, if it is ours), or is something else in the way?
	const wsState = await probePort(config.host, config.port);
	if (wsState === "free") add("ok", "WebSocket port", `${config.port} is free; the connector will bind it when your MCP client starts it`);
	else {
		const bridge = await probeConnector(config.host, config.port, config.token);
		if (bridge === "accepted") add("ok", "WebSocket port", `${config.port} has a running connector that accepts this token`);
		else if (bridge === "bad-token") add("fail", "WebSocket port", `${config.port} has a running connector with a different token; align GRAPHITE_MCP_TOKEN or the cached token file`);
		else add("warn", "WebSocket port", `${config.port} is in use by something that is not this connector`);
	}
	const webState = await probePort(config.host, config.webPort);
	add(webState === "free" ? "ok" : "warn", "Web port", webState === "free" ? `${config.webPort} is free` : `${config.webPort} is in use (a running connector, or set GRAPHITE_MCP_WEB_PORT)`);

	// Web app
	if (!config.serveWeb) add("warn", "Graphite web app", "GRAPHITE_MCP_SERVE=0: you run Graphite yourself (developer setup)");
	else if (config.webDir) {
		const ok = await isFile(path.join(config.webDir, "index.html"));
		add(ok ? "ok" : "fail", "Graphite web app", ok ? `served from GRAPHITE_MCP_WEB_DIR=${config.webDir}` : `GRAPHITE_MCP_WEB_DIR=${config.webDir} has no index.html`);
	} else {
		const cached = path.join(config.cacheDir, "web", CONNECTOR_VERSION);
		if (await isFile(path.join(cached, "index.html"))) add("ok", "Graphite web app", `cached at ${cached}`);
		else {
			const reachable = await headOk(config.bundleUrl);
			add(reachable ? "ok" : "warn", "Graphite web app", reachable ? `not downloaded yet; ${config.bundleUrl} is reachable and will be fetched on first start` : `not downloaded yet and ${config.bundleUrl} is not reachable (offline, or no release published yet)`);
		}
	}

	// Exports and fonts
	const exportOk = await writable(config.defaultExportDir);
	add(exportOk ? "ok" : "fail", "Export directory", `${config.defaultExportDir}${exportOk ? "" : " is not writable"}`);
	const fontFiles = await countFonts([...config.fontDirs, bundledFontDir()]);
	add(fontFiles > 0 ? "ok" : "warn", "Fonts for text", fontFiles > 0 ? `${fontFiles} font file(s) available` : "none found; <text> will be dropped");

	for (const r of results) write(`${r.status === "ok" ? " ok  " : r.status === "warn" ? "warn " : "FAIL "} ${r.name}: ${r.detail}`);
	const fails = results.filter((r) => r.status === "fail").length;
	write("");
	if (fails === 0) write("Everything looks fine. Start (or restart) your MCP client; the connector serves Graphite and opens a tab on first use.");
	else write(`${fails} problem(s) found.`);
	return fails === 0 ? 0 : 1;
}

function probePort(host: string, port: number): Promise<"free" | "in-use"> {
	return new Promise((resolve) => {
		const socket = net.connect({ host, port });
		socket.once("connect", () => {
			socket.destroy();
			resolve("in-use");
		});
		socket.once("error", () => resolve("free"));
		socket.setTimeout(1000, () => {
			socket.destroy();
			resolve("free");
		});
	});
}

/** Talks to a listening connector like a bridge would and reports whether the token is accepted. */
function probeConnector(host: string, port: number, token: string): Promise<"accepted" | "bad-token" | "not-connector"> {
	return new Promise((resolve) => {
		const socket = new WebSocket(`ws://${host}:${port}`);
		const done = (value: "accepted" | "bad-token" | "not-connector"): void => {
			clearTimeout(timer);
			socket.close();
			resolve(value);
		};
		const timer = setTimeout(() => done("accepted"), 1500);
		socket.once("open", () => socket.send(JSON.stringify({ type: "hello", token, protocol_version: PROTOCOL_VERSION, bridge_version: "doctor", graphite_commit: null })));
		socket.once("close", (code) => done(code === 4003 ? "bad-token" : code === 4000 || code === 1000 || code === 1005 ? "accepted" : "not-connector"));
		socket.once("error", () => done("not-connector"));
	});
}

async function headOk(url: string): Promise<boolean> {
	try {
		const response = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(5000) });
		return response.ok;
	} catch {
		return false;
	}
}

async function isFile(file: string): Promise<boolean> {
	return fs.stat(file).then((s) => s.isFile(), () => false);
}

async function writable(dir: string): Promise<boolean> {
	try {
		await fs.mkdir(dir, { recursive: true });
		await fs.access(dir, (await import("node:fs")).constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

async function countFonts(dirs: string[]): Promise<number> {
	let n = 0;
	for (const dir of dirs) {
		try {
			n += (await fs.readdir(dir)).filter((f) => /\.(ttf|otf)$/i.test(f)).length;
		} catch {
			/* missing directory */
		}
	}
	return n;
}

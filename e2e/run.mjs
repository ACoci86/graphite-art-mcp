#!/usr/bin/env node
/**
 * End-to-end test against a real Graphite build.
 *
 * Starts the built connector (dist/index.js) serving a Graphite web bundle, opens that page in headless Chromium so the
 * bridge connects, then drives the connector through a real MCP client: create a document, insert SVG with text, inspect,
 * restyle, transform, preview, export, delete, undo. Exits non-zero on the first failed check.
 *
 *   node e2e/run.mjs --web-dir /path/to/graphite/frontend/dist [--headed] [--timeout 120]
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chromium } from "playwright";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
	const key = process.argv[i];
	if (!key.startsWith("--")) continue;
	const next = process.argv[i + 1];
	if (next && !next.startsWith("--")) {
		args.set(key.slice(2), next);
		i += 1;
	} else args.set(key.slice(2), "true");
}
const webDir = path.resolve(args.get("web-dir") ?? process.env.GRAPHITE_E2E_WEB_DIR ?? "");
const headed = args.get("headed") === "true";
const timeoutS = Number(args.get("timeout") ?? 120);
if (!webDir || !(await exists(path.join(webDir, "index.html")))) {
	console.error("Pass --web-dir pointing at a built Graphite frontend/dist (with index.html).");
	process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const connector = path.resolve(here, "..", "dist", "index.js");
const token = "e2e-token-0123456789abcdef";
const port = 48_100 + Math.floor(Math.random() * 300);
const webPort = port + 1;
const exportDir = await fs.mkdtemp(path.join(os.tmpdir(), "graphite-e2e-"));
const cacheDir = path.join(exportDir, "cache");

let failures = 0;
function check(name, condition, detail = "") {
	if (condition) console.log(`  ok   ${name}`);
	else {
		failures += 1;
		console.error(`  FAIL ${name}${detail ? `: ${detail}` : ""}`);
	}
}
async function exists(file) {
	return fs.stat(file).then(() => true, () => false);
}
function structured(result) {
	if (result.isError) throw new Error(`tool error: ${result.content?.[0]?.text ?? JSON.stringify(result)}`);
	return result.structuredContent;
}

console.log(`connector: ${connector}\nweb dir:   ${webDir}\nports:     ws ${port}, web ${webPort}`);

const transport = new StdioClientTransport({
	command: process.execPath,
	args: [connector],
	env: {
		...process.env,
		GRAPHITE_MCP_TOKEN: token,
		GRAPHITE_MCP_PORT: String(port),
		GRAPHITE_MCP_WEB_PORT: String(webPort),
		GRAPHITE_MCP_WEB_DIR: webDir,
		GRAPHITE_MCP_OPEN_BROWSER: "0",
		GRAPHITE_MCP_EXPORT_DIR: exportDir,
		GRAPHITE_MCP_CACHE_DIR: cacheDir,
	},
	stderr: "pipe",
});
transport.stderr?.on("data", (chunk) => process.stderr.write(`    [connector] ${chunk}`));
const client = new Client({ name: "graphite-e2e", version: "0.0.0" });
await client.connect(transport);

const browser = await chromium.launch({ headless: !headed, args: ["--enable-unsafe-webgpu", "--use-angle=swiftshader", "--enable-features=Vulkan"] });
const page = await browser.newPage();
page.on("console", (message) => {
	if (message.type() === "error" || message.text().includes("automation-bridge")) console.log(`    [browser] ${message.text()}`);
});
page.on("pageerror", (error) => console.log(`    [browser error] ${error.message}`));

try {
	const url = `http://127.0.0.1:${webPort}/?automation=${token}&automationEndpoint=${encodeURIComponent(`ws://127.0.0.1:${port}`)}`;
	console.log(`opening ${url}`);
	await page.goto(url, { waitUntil: "load" });

	// 1. Wait for the tab to connect. The first load may reload once (service worker install), which briefly
	//    disconnects the bridge; keep polling until the deadline.
	const deadline = Date.now() + timeoutS * 1000;
	let caps;
	page.on("framenavigated", (frame) => {
		if (frame === page.mainFrame()) console.log(`    [browser] navigated to ${frame.url()}`);
	});
	while (Date.now() < deadline) {
		try {
			caps = structured(await client.callTool({ name: "graphite_get_capabilities", arguments: {} }));
			if (caps.connected) break;
		} catch (error) {
			console.log(`    [wait] ${error instanceof Error ? error.message : String(error)}`);
		}
		await new Promise((r) => setTimeout(r, 1000));
	}
	// Let the editor finish loading its demo artwork before we start
	await new Promise((r) => setTimeout(r, 2000));
	check("tab connected", caps?.connected === true, JSON.stringify(caps));
	if (!caps?.connected) throw new Error("Graphite tab never connected");
	console.log(`  graphite ${caps.graphite_commit}, bridge ${caps.bridge_version}`);

	// 2. Document and insert (with text, which the connector outlines)
	const doc = structured(await client.callTool({ name: "graphite_new_document", arguments: { name: "E2E" } }));
	check("new document", /^\d+$/.test(doc.document_id));
	const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200" viewBox="0 0 300 200"><rect x="20" y="20" width="120" height="80" fill="#2050e0"/><circle cx="220" cy="100" r="50" fill="#e02020"/><text x="20" y="170" font-size="28" font-family="sans-serif">E2E</text></svg>';
	const inserted = structured(await client.callTool({ name: "graphite_insert_svg", arguments: { svg, name: "Shapes" } }));
	check("insert returns a layer id", /^\d+$/.test(inserted.layer_id));
	check("text was outlined", inserted.text_outlined === 1, JSON.stringify(inserted));

	// 3. Inspect
	let info = structured(await client.callTool({ name: "graphite_get_document", arguments: {} }));
	check("layer listed", info.layer_ids.includes(inserted.layer_id), JSON.stringify(info.layer_ids));
	check("layer count > 1 (group plus children)", info.layer_count > 1, String(info.layer_count));

	// 4. Edit
	const styled = structured(await client.callTool({ name: "graphite_set_style", arguments: { layer_id: inserted.layer_id, opacity: 0.8 } }));
	check("set opacity", styled.changed.includes("opacity"));
	const moved = structured(await client.callTool({ name: "graphite_transform_layer", arguments: { layer_id: inserted.layer_id, translate: [10, 10] } }));
	check("transform applied", moved.matrix[4] === 10);
	const renamed = structured(await client.callTool({ name: "graphite_rename_layer", arguments: { layer_id: inserted.layer_id, name: "Renamed" } }));
	check("rename", renamed.name === "Renamed");
	info = structured(await client.callTool({ name: "graphite_get_document", arguments: {} }));
	const entry = info.layers.find((l) => l.id === inserted.layer_id);
	check("rename visible in get_document", entry?.name === "Renamed", JSON.stringify(entry));

	// 5. Preview and export
	const previewResult = await client.callTool({ name: "graphite_preview", arguments: { scale: 0.5 } });
	const image = previewResult.content?.find((c) => c.type === "image");
	check("preview returns an image", Boolean(image) && !previewResult.isError, previewResult.content?.[0]?.text);
	check("preview has dimensions", (previewResult.structuredContent?.width ?? 0) > 0, JSON.stringify(previewResult.structuredContent));
	const exported = structured(await client.callTool({ name: "graphite_export", arguments: { format: "svg", path: "e2e" } }));
	check("export written", await exists(exported.path), exported.path);
	const exportedSvg = await fs.readFile(exported.path, "utf8");
	check("export contains the shapes", /<path|<rect|<circle/.test(exportedSvg));

	// 5b. <defs>/<use> and gradients go through Graphite's importer unchanged; make sure they survive
	const reuse = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="200" height="100" viewBox="0 0 200 100"><defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient><symbol id="dot" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="url(#g)"/></symbol></defs><use href="#dot" x="10" y="10" width="40" height="40"/><use xlink:href="#dot" x="100" y="10" width="40" height="40"/></svg>';
	const reused = structured(await client.callTool({ name: "graphite_insert_svg", arguments: { svg: reuse, name: "Reuse" } }));
	check("defs/use insert accepted", /^\d+$/.test(reused.layer_id));
	const reuseExport = structured(await client.callTool({ name: "graphite_export", arguments: { format: "svg", path: "e2e-reuse" } }));
	const reuseSvg = await fs.readFile(reuseExport.path, "utf8");
	check("use elements rendered as shapes", (reuseSvg.match(/<path|<circle|<ellipse/g) ?? []).length >= 2, `${(reuseSvg.match(/<path|<circle|<ellipse/g) ?? []).length} shapes found`);
	structured(await client.callTool({ name: "graphite_delete_layer", arguments: { layer_id: reused.layer_id } }));

	// 6. Delete and undo
	const deleted = structured(await client.callTool({ name: "graphite_delete_layer", arguments: { layer_id: inserted.layer_id } }));
	check("delete", deleted.deleted === true);
	info = structured(await client.callTool({ name: "graphite_get_document", arguments: {} }));
	check("layer gone after delete", !info.layer_ids.includes(inserted.layer_id));
	structured(await client.callTool({ name: "graphite_undo", arguments: {} }));
	await new Promise((r) => setTimeout(r, 1000));
	info = structured(await client.callTool({ name: "graphite_get_document", arguments: {} }));
	check("undo restores the layer", info.layer_ids.includes(inserted.layer_id), JSON.stringify(info.layer_ids));
} catch (error) {
	failures += 1;
	console.error(`  FAIL ${error instanceof Error ? error.message : String(error)}`);
} finally {
	await browser.close().catch(() => undefined);
	await client.close().catch(() => undefined);
	await fs.rm(exportDir, { recursive: true, force: true }).catch(() => undefined);
}

console.log(failures === 0 ? "\nE2E PASSED" : `\nE2E FAILED (${failures} check(s))`);
process.exit(failures === 0 ? 0 : 1);

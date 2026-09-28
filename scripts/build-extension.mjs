#!/usr/bin/env node
/**
 * Builds the Claude Desktop extension (an .mcpb bundle) from the compiled connector.
 *
 * Stages dist/, fonts/, the production node_modules and a manifest generated from package.json and the server's own
 * tool list, validates the manifest, and packs it into build/graphite-art-mcp-<version>.mcpb. Run `npm run extension`.
 */

import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const stage = path.join(root, "build", "mcpb");
const output = path.join(root, "build", `graphite-art-mcp-${pkg.version}.mcpb`);
const mcpb = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "mcpb.cmd" : "mcpb");

async function exists(file) {
	return fs.stat(file).then(() => true, () => false);
}

if (!(await exists(path.join(root, "dist", "index.js")))) {
	console.error("dist/index.js is missing; run `npm run build` first.");
	process.exit(1);
}

/** Ask the real server for its tools so the manifest never drifts from the code. */
async function listTools() {
	const { createGraphiteMcp } = await import(path.join(root, "dist", "server.js"));
	const { loadConfig } = await import(path.join(root, "dist", "config.js"));
	const config = loadConfig({ GRAPHITE_MCP_CACHE_DIR: path.join(root, "build", "tmp-cache"), GRAPHITE_MCP_SERVE: "0", GRAPHITE_MCP_TOKEN: "manifest-generation-token-0000" });
	const mcp = createGraphiteMcp(config, () => undefined);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await mcp.server.connect(serverTransport);
	const client = new Client({ name: "manifest", version: "0.0.0" });
	await client.connect(clientTransport);
	const { tools } = await client.listTools();
	await client.close();
	await mcp.server.close();
	return tools.map((t) => ({ name: t.name, description: firstSentence(t.description ?? "") }));
}

function firstSentence(text) {
	const m = /^(.*?[.!?])(\s|$)/.exec(text.trim());
	return (m ? m[1] : text.trim()).slice(0, 200);
}

const tools = await listTools();
await fs.rm(path.join(root, "build", "tmp-cache"), { recursive: true, force: true });

const manifest = {
	manifest_version: "0.3",
	name: pkg.name,
	display_name: "Graphite Art",
	version: pkg.version,
	description: "Create and edit vector artwork in the Graphite editor from Claude.",
	long_description:
		"Unofficial connector for the Graphite vector editor (graphite.art). Claude writes SVG and Graphite turns it into fully editable layers; " +
		"Claude can then inspect, restyle, move, rename and delete layers, undo, preview the canvas and export files.\n\n" +
		"On first use the extension downloads a pre-built copy of Graphite (a few megabytes, once), serves it locally, and opens it in your browser already connected. " +
		"No Rust toolchain, no manual configuration. Text in SVG is converted to outlined paths automatically.\n\n" +
		"Not affiliated with the Graphite project. Graphite is MIT / Apache-2.0 licensed; this connector is MIT licensed.",
	author: { name: "ACoci86", url: "https://github.com/ACoci86" },
	repository: { type: "git", url: "https://github.com/ACoci86/graphite-art-mcp" },
	homepage: "https://github.com/ACoci86/graphite-art-mcp",
	documentation: "https://github.com/ACoci86/graphite-art-mcp#readme",
	support: "https://github.com/ACoci86/graphite-art-mcp/issues",
	icon: "icon.png",
	server: {
		type: "node",
		entry_point: "dist/index.js",
		mcp_config: {
			command: "node",
			args: ["${__dirname}/dist/index.js"],
			env: {
				GRAPHITE_MCP_EXPORT_DIR: "${user_config.export_dir}",
				GRAPHITE_MCP_OPEN_BROWSER: "${user_config.open_browser}",
				GRAPHITE_MCP_FONT_DIR: "${user_config.font_dir}",
			},
		},
	},
	tools,
	keywords: ["graphite", "vector", "svg", "graphics", "design", "illustration", "mcp"],
	license: "MIT",
	compatibility: {
		claude_desktop: ">=0.10.0",
		platforms: ["darwin", "win32", "linux"],
		runtimes: { node: ">=20.0.0" },
	},
	user_config: {
		export_dir: {
			type: "directory",
			title: "Export folder",
			description: "Where exported SVG and PNG files are written.",
			default: "${HOME}/graphite-mcp-exports",
			required: false,
		},
		open_browser: {
			type: "boolean",
			title: "Open Graphite automatically",
			description: "Open the Graphite tab in your browser when the connector starts and no tab is connected yet.",
			default: true,
			required: false,
		},
		font_dir: {
			type: "directory",
			title: "Extra fonts folder (optional)",
			description: "Folder with .ttf or .otf files to use when converting SVG text to paths. The bundled Liberation fonts are always available.",
			required: false,
		},
	},
};

console.log(`staging ${stage}`);
await fs.rm(stage, { recursive: true, force: true });
await fs.mkdir(stage, { recursive: true });
await fs.cp(path.join(root, "dist"), path.join(stage, "dist"), { recursive: true });
await fs.cp(path.join(root, "fonts"), path.join(stage, "fonts"), { recursive: true });
for (const file of ["package.json", "package-lock.json", "README.md", "LICENSE"]) await fs.copyFile(path.join(root, file), path.join(stage, file));
await fs.copyFile(path.join(root, "extension", "icon.png"), path.join(stage, "icon.png"));
await fs.writeFile(path.join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

console.log("installing production dependencies");
execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: stage, stdio: "inherit" });
// The lockfile is only needed for the install
await fs.rm(path.join(stage, "package-lock.json"), { force: true });

console.log("validating manifest");
execFileSync(mcpb, ["validate", path.join(stage, "manifest.json")], { stdio: "inherit" });

console.log("packing");
await fs.rm(output, { force: true });
execFileSync(mcpb, ["pack", stage, output], { stdio: "inherit" });
const size = (await fs.stat(output)).size;
console.log(`\nbuilt ${output} (${(size / 1024 / 1024).toFixed(1)} MB, ${tools.length} tools)`);

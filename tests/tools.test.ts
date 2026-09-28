/**
 * Runs the MCP server end-to-end over an in-memory transport with a fake Graphite bridge, so the tool contracts
 * (schemas, structured output, error envelopes, file writing) are tested without a browser.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { Config } from "../src/config.js";
import { createGraphiteMcp, type GraphiteMcp } from "../src/server.js";
import { countSvgElements, precheckSvg } from "../src/tools/insert-svg.js";
import { composeTransform, multiply } from "../src/tools/edit.js";
import { resolveExportPath, sanitizeBaseName } from "../src/graphite/export-path.js";

const TOKEN = "unit-test-token-0123456789";
let mcp: GraphiteMcp;
let mcpClient: Client;
let tmpDir: string;
let port: number;

type Handler = (command: string, params: Record<string, unknown>) => { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } };

async function fakeBridge(handler: Handler): Promise<WebSocket> {
	const socket = new WebSocket(`ws://127.0.0.1:${port}`);
	await new Promise<void>((resolve) => socket.once("open", () => resolve()));
	socket.send(JSON.stringify({ type: "hello", token: TOKEN, protocol_version: 1, bridge_version: "fake", graphite_commit: "deadbeef" }));
	socket.on("message", (data) => {
		const request = JSON.parse(data.toString());
		socket.send(JSON.stringify({ id: request.id, ...handler(request.command, request.params) }));
	});
	await new Promise((r) => setTimeout(r, 30));
	return socket;
}

function parseError(result: Awaited<ReturnType<Client["callTool"]>>): { code: string; message: string } {
	expect(result.isError).toBe(true);
	const content = result.content as Array<{ type: string; text: string }>;
	return JSON.parse(content[0]!.text);
}

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "graphite-mcp-test-"));
	port = 48_400 + Math.floor(Math.random() * 500);
	const config: Config = {
		host: "127.0.0.1",
		port,
		token: TOKEN,
		tokenSource: "env",
		tokenWasGenerated: false,
		allowedOrigins: [],
		requestTimeoutMs: 500,
		exportTimeoutMs: 6_000,
		insertMsPerElement: 40,
		insertGraceMs: 300,
		exportRoots: [tmpDir],
		defaultExportDir: tmpDir,
		cacheDir: tmpDir,
		serveWeb: false,
		webPort: 0,
		webDir: undefined,
		bundleUrl: "https://example.invalid/graphite-web.tar.gz",
		bundleSha256: undefined,
		openBrowser: false,
		fontDirs: [],
	};
	mcp = createGraphiteMcp(config, () => undefined);
	await mcp.client.listen();

	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await mcp.server.connect(serverTransport);
	mcpClient = new Client({ name: "test-client", version: "0.0.0" });
	await mcpClient.connect(clientTransport);
});

afterEach(async () => {
	await mcpClient.close();
	await mcp.close();
	await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("tool registration", () => {
	it("exposes exactly the v0.1 tools with schemas", async () => {
		const { tools } = await mcpClient.listTools();
		expect(tools.map((t) => t.name).sort()).toEqual([
			"graphite_delete_layer",
			"graphite_export",
			"graphite_get_capabilities",
			"graphite_get_document",
			"graphite_insert_svg",
			"graphite_new_document",
			"graphite_preview",
			"graphite_redo",
			"graphite_rename_layer",
			"graphite_select_document",
			"graphite_set_style",
			"graphite_transform_layer",
			"graphite_undo",
		]);
		const insert = tools.find((t) => t.name === "graphite_insert_svg")!;
		expect(Object.keys(insert.inputSchema.properties ?? {})).toEqual(expect.arrayContaining(["svg", "svg_path"]));
		expect(insert.outputSchema).toBeDefined();
	});
});

describe("graphite_get_capabilities", () => {
	it("answers even when Graphite is not connected", async () => {
		const result = await mcpClient.callTool({ name: "graphite_get_capabilities", arguments: {} });
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toMatchObject({ connected: false, protocol_version: 1, web_url: null });
	});

	it("tells the model where the served Graphite lives once the entry point has started it", async () => {
		mcp.runtime.webUrl = "http://127.0.0.1:47833/?automation=abc";
		const result = await mcpClient.callTool({ name: "graphite_get_capabilities", arguments: {} });
		expect(result.structuredContent).toMatchObject({ connected: false, web_url: "http://127.0.0.1:47833/?automation=abc" });
		expect((result.content as Array<{ text: string }>)[0]!.text).toContain("http://127.0.0.1:47833/?automation=abc");
	});

	it("reports bridge details when connected", async () => {
		const socket = await fakeBridge(() => ({ ok: true, result: { protocol_version: 1, bridge_version: "fake", graphite_commit: "deadbeef", commands: ["new_document"] } }));
		const result = await mcpClient.callTool({ name: "graphite_get_capabilities", arguments: {} });
		expect(result.structuredContent).toMatchObject({ connected: true, graphite_commit: "deadbeef", bridge_commands: ["new_document"] });
		socket.close();
	});
});

describe("graphite_new_document", () => {
	it("returns GRAPHITE_NOT_CONNECTED as a structured error when no tab is attached", async () => {
		const result = await mcpClient.callTool({ name: "graphite_new_document", arguments: { name: "x" } });
		expect(parseError(result).code).toBe("GRAPHITE_NOT_CONNECTED");
	});

	it("passes the name through and returns the document id", async () => {
		const socket = await fakeBridge((command, params) => {
			expect(command).toBe("new_document");
			return { ok: true, result: { document_id: "987", name: `${params.name} 2` } };
		});
		const result = await mcpClient.callTool({ name: "graphite_new_document", arguments: { name: "Logo" } });
		expect(result.structuredContent).toEqual({ document_id: "987", name: "Logo 2" });
		socket.close();
	});
});

describe("graphite_insert_svg", () => {
	const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';

	it("prechecks obviously invalid SVG locally", () => {
		expect(() => precheckSvg("<div>hi</div>")).toThrow(/<svg>/);
		expect(() => precheckSvg("<svg><rect/>")).toThrow(/closed/);
		expect(() => precheckSvg('<svg><script>alert(1)</script></svg>')).toThrow(/Scripts/);
		expect(() => precheckSvg(svg)).not.toThrow();
	});

	it("allocates a non-zero layer id, forwards params with a scaled timeout and echoes the id", async () => {
		let seen: Record<string, unknown> = {};
		const socket = await fakeBridge((command, params) => {
			seen = params;
			return { ok: true, result: { layer_id: params.layer_id, document_id: "1" } };
		});
		const result = await mcpClient.callTool({ name: "graphite_insert_svg", arguments: { svg, x: 10, y: 20, center: true, name: "Star" } });
		expect(result.isError).toBeFalsy();
		expect(seen).toMatchObject({ svg, x: 10, y: 20, center: true, name: "Star", timeout_ms: 10_000 + 40 * 2 });
		expect(String(seen.layer_id)).toMatch(/^\d+$/);
		expect(BigInt(seen.layer_id as string)).not.toBe(0n);
		expect(result.structuredContent).toEqual({ layer_id: seen.layer_id, document_id: "1", elements: 2, confirmed_late: false, text_outlined: 0 });
		socket.close();
	});

	it("outlines <text> to paths before sending, unless asked not to", async () => {
		const withText = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><text x="5" y="30" font-size="20">Hi</text></svg>';
		let seen: Record<string, unknown> = {};
		const socket = await fakeBridge((command, params) => {
			seen = params;
			return { ok: true, result: { layer_id: params.layer_id, document_id: "1" } };
		});
		const outlined = await mcpClient.callTool({ name: "graphite_insert_svg", arguments: { svg: withText } });
		expect(outlined.isError).toBeFalsy();
		expect(String(seen.svg)).not.toMatch(/<text/);
		expect(String(seen.svg)).toMatch(/<path d="M/);
		expect(outlined.structuredContent).toMatchObject({ text_outlined: 1 });

		const raw = await mcpClient.callTool({ name: "graphite_insert_svg", arguments: { svg: withText, outline_text: false } });
		expect(raw.isError).toBeFalsy();
		expect(String(seen.svg)).toMatch(/<text/);
		expect(raw.structuredContent).toMatchObject({ text_outlined: 0 });
		socket.close();
	});

	it("counts elements to size the wait", () => {
		expect(countSvgElements(svg)).toBe(2);
		expect(countSvgElements("<svg><g><path/><path/></g><!-- c --></svg>")).toBe(4);
	});

	it("reads the markup from svg_path and requires exactly one source", async () => {
		const file = path.join(tmpDir, "art.svg");
		await fs.writeFile(file, svg);
		let seen: Record<string, unknown> = {};
		const socket = await fakeBridge((command, params) => {
			seen = params;
			return { ok: true, result: { layer_id: params.layer_id, document_id: "1" } };
		});
		const fromFile = await mcpClient.callTool({ name: "graphite_insert_svg", arguments: { svg_path: file } });
		expect(fromFile.isError).toBeFalsy();
		expect(seen.svg).toBe(svg);

		expect(parseError(await mcpClient.callTool({ name: "graphite_insert_svg", arguments: {} })).code).toBe("INVALID_PARAMS");
		expect(parseError(await mcpClient.callTool({ name: "graphite_insert_svg", arguments: { svg, svg_path: file } })).code).toBe("INVALID_PARAMS");
		expect(parseError(await mcpClient.callTool({ name: "graphite_insert_svg", arguments: { svg_path: path.join(tmpDir, "missing.svg") } })).code).toBe("INVALID_PARAMS");
		socket.close();
	});

	it("confirms a timed-out insert through get_document instead of failing", async () => {
		let layerId = "";
		const socket = await fakeBridge((command, params) => {
			if (command === "insert_svg") {
				layerId = params.layer_id as string;
				return { ok: false, error: { code: "BRIDGE_TIMEOUT", message: "Graphite has not reported layer yet" } };
			}
			return { ok: true, result: { document_id: "1", name: "Doc", layer_count: 1, layer_ids: [layerId] } };
		});
		const result = await mcpClient.callTool({ name: "graphite_insert_svg", arguments: { svg } });
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toMatchObject({ layer_id: layerId, confirmed_late: true });
		socket.close();
	});

	it("keeps BRIDGE_TIMEOUT, with the layer id, when the layer never shows up", async () => {
		const socket = await fakeBridge((command) =>
			command === "insert_svg"
				? { ok: false, error: { code: "BRIDGE_TIMEOUT", message: "Graphite has not reported layer yet" } }
				: { ok: true, result: { document_id: "1", name: "Doc", layer_count: 0, layer_ids: [] } },
		);
		const result = await mcpClient.callTool({ name: "graphite_insert_svg", arguments: { svg } });
		const error = parseError(result) as { code: string; message: string; details?: { layer_id?: string } };
		expect(error.code).toBe("BRIDGE_TIMEOUT");
		expect(error.message).toMatch(/graphite_get_document/);
		expect(error.details?.layer_id).toMatch(/^\d+$/);
		socket.close();
	});

	it("rejects schema violations before contacting Graphite", async () => {
		const result = await mcpClient.callTool({ name: "graphite_insert_svg", arguments: { svg, parent_id: "not-a-number" } });
		expect(result.isError).toBe(true);
	});

	it("relays a bridge-side INVALID_SVG", async () => {
		const socket = await fakeBridge(() => ({ ok: false, error: { code: "INVALID_SVG", message: "usvg choked" } }));
		const result = await mcpClient.callTool({ name: "graphite_insert_svg", arguments: { svg } });
		expect(parseError(result)).toEqual({ code: "INVALID_SVG", message: "usvg choked" });
		socket.close();
	});
});

describe("graphite_get_document", () => {
	it("relays the bridge snapshot, filling in defaults for an older bridge", async () => {
		const socket = await fakeBridge(() => ({ ok: true, result: { document_id: "77", name: "Poster", layer_count: 2, layer_ids: ["1", "2"] } }));
		const result = await mcpClient.callTool({ name: "graphite_get_document", arguments: {} });
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toEqual({
			document_id: "77",
			name: "Poster",
			layer_count: 2,
			layer_ids: ["1", "2"],
			layers: [
				{ id: "1", name: null, kind: null, visible: true, parent_id: null },
				{ id: "2", name: null, kind: null, visible: true, parent_id: null },
			],
			open_documents: [],
		});
		socket.close();
	});
});

describe("editing tools", () => {
	it("composes transforms like SVG does", () => {
		expect(composeTransform({ translate: [10, 20] })).toEqual([1, 0, 0, 1, 10, 20]);
		expect(composeTransform({ scale: 2 })).toEqual([2, 0, 0, 2, 0, 0]);
		expect(composeTransform({ scale: [2, 3], origin: [10, 10] })).toEqual([2, 0, 0, 3, -10, -20]);
		const r = composeTransform({ rotate: 90, origin: [5, 5] }).map((v) => Math.round(v * 1000) / 1000);
		expect(r).toEqual([0, 1, -1, 0, 10, 0]);
		expect(multiply([1, 0, 0, 1, 5, 0], [2, 0, 0, 2, 0, 0])).toEqual([2, 0, 0, 2, 5, 0]);
	});

	it("maps style, transform, rename, delete, undo, redo and select_document onto bridge commands", async () => {
		const seen: Array<[string, Record<string, unknown>]> = [];
		const socket = await fakeBridge((command, params) => {
			seen.push([command, params]);
			if (command === "select_document") return { ok: true, result: { document_id: params.document_id, name: "Other" } };
			if (command === "delete_layer") return { ok: true, result: { layer_id: params.layer_id, deleted: true } };
			if (command === "rename_layer") return { ok: true, result: { layer_id: params.layer_id, name: params.name } };
			if (command === "undo" || command === "redo") return { ok: true, result: { ok: true } };
			return { ok: true, result: { layer_id: params.layer_id } };
		});
		const style = await mcpClient.callTool({ name: "graphite_set_style", arguments: { layer_id: "9", fill: "#ff0000", stroke: null, stroke_width: 3, opacity: 0.5 } });
		expect(style.isError).toBeFalsy();
		expect(style.structuredContent).toEqual({ layer_id: "9", changed: ["fill", "stroke", "opacity"] });
		expect(seen.slice(0, 3)).toEqual([
			["set_fill", { layer_id: "9", color: "#ff0000" }],
			["set_stroke", { layer_id: "9", color: null, weight: 3 }],
			["set_opacity", { layer_id: "9", opacity: 0.5 }],
		]);
		expect(parseError(await mcpClient.callTool({ name: "graphite_set_style", arguments: { layer_id: "9" } })).code).toBe("INVALID_PARAMS");

		const moved = await mcpClient.callTool({ name: "graphite_transform_layer", arguments: { layer_id: "9", translate: [5, -5], scale: 2 } });
		expect(moved.structuredContent).toEqual({ layer_id: "9", matrix: [2, 0, 0, 2, 5, -5], replace: false });
		expect(seen.at(-1)).toEqual(["set_transform", { layer_id: "9", matrix: [2, 0, 0, 2, 5, -5], replace: false }]);
		const raw = await mcpClient.callTool({ name: "graphite_transform_layer", arguments: { layer_id: "9", matrix: [1, 0, 0, 1, 0, 0], replace: true } });
		expect(raw.structuredContent).toMatchObject({ replace: true });
		expect(parseError(await mcpClient.callTool({ name: "graphite_transform_layer", arguments: { layer_id: "9" } })).code).toBe("INVALID_PARAMS");

		expect((await mcpClient.callTool({ name: "graphite_rename_layer", arguments: { layer_id: "9", name: "Sky" } })).structuredContent).toEqual({ layer_id: "9", name: "Sky" });
		expect((await mcpClient.callTool({ name: "graphite_delete_layer", arguments: { layer_id: "9" } })).structuredContent).toEqual({ layer_id: "9", deleted: true });
		expect((await mcpClient.callTool({ name: "graphite_undo", arguments: {} })).structuredContent).toEqual({ ok: true });
		expect((await mcpClient.callTool({ name: "graphite_redo", arguments: {} })).structuredContent).toEqual({ ok: true });
		expect((await mcpClient.callTool({ name: "graphite_select_document", arguments: { document_id: "3" } })).structuredContent).toEqual({ document_id: "3", name: "Other" });
		expect(seen.map(([c]) => c).slice(-5)).toEqual(["rename_layer", "delete_layer", "undo", "redo", "select_document"]);
		socket.close();
	});
});

describe("graphite_export", () => {
	const svgBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');

	it("writes the returned bytes to the default export directory", async () => {
		const socket = await fakeBridge((command, params) => {
			expect(command).toBe("export");
			expect(params).toMatchObject({ format: "svg", scale_factor: 1, name: "logo", timeout_ms: 5_000 });
			return { ok: true, result: { file_name: "logo.svg", format: "svg", content_base64: svgBytes.toString("base64"), byte_length: svgBytes.length } };
		});
		const result = await mcpClient.callTool({ name: "graphite_export", arguments: { format: "svg", path: "logo" } });
		expect(result.isError).toBeFalsy();
		const structured = result.structuredContent as { path: string; bytes: number };
		expect(structured.path).toBe(path.join(await fs.realpath(tmpDir), "logo.svg"));
		expect(structured.bytes).toBe(svgBytes.length);
		expect((await fs.readFile(structured.path)).equals(svgBytes)).toBe(true);
		socket.close();
	});

	it("refuses paths outside the approved roots", async () => {
		const socket = await fakeBridge(() => ({ ok: true, result: {} }));
		const result = await mcpClient.callTool({ name: "graphite_export", arguments: { format: "png", path: path.join(os.tmpdir(), "..", "etc", "x.png") } });
		expect(parseError(result).code).toBe("EXPORT_PATH_NOT_ALLOWED");
		socket.close();
	});

	it("turns an empty export into EXPORT_FAILED", async () => {
		const socket = await fakeBridge(() => ({ ok: true, result: { file_name: "a.svg", format: "svg", content_base64: "", byte_length: 0 } }));
		const result = await mcpClient.callTool({ name: "graphite_export", arguments: {} });
		expect(parseError(result).code).toBe("EXPORT_FAILED");
		socket.close();
	});
});

describe("graphite_preview", () => {
	// 1x1 transparent PNG
	const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

	it("returns the rendered PNG as an image block with its dimensions, without writing a file", async () => {
		let seen: Record<string, unknown> = {};
		const socket = await fakeBridge((command, params) => {
			expect(command).toBe("export");
			seen = params;
			return { ok: true, result: { file_name: "preview.png", format: "png", content_base64: png.toString("base64"), byte_length: png.length } };
		});
		const result = await mcpClient.callTool({ name: "graphite_preview", arguments: {} });
		expect(result.isError).toBeFalsy();
		expect(seen).toMatchObject({ format: "png", scale_factor: 0.5, name: "preview" });
		const content = result.content as Array<{ type: string; data?: string; mimeType?: string; text?: string }>;
		expect(content[0]).toMatchObject({ type: "image", mimeType: "image/png", data: png.toString("base64") });
		expect(content[1]?.text).toContain("1×1 px");
		expect(result.structuredContent).toEqual({ width: 1, height: 1, bytes: png.length, scale: 0.5 });
		expect(await fs.readdir(tmpDir)).toEqual([]);
		socket.close();
	});

	it("relays an empty document as EXPORT_FAILED", async () => {
		const socket = await fakeBridge(() => ({ ok: false, error: { code: "EXPORT_FAILED", message: "no layers" } }));
		expect(parseError(await mcpClient.callTool({ name: "graphite_preview", arguments: { scale: 1 } })).code).toBe("EXPORT_FAILED");
		socket.close();
	});
});

describe("export resources", () => {
	it("lists and reads files from the export directory, and nothing outside it", async () => {
		await fs.writeFile(path.join(tmpDir, "logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
		await fs.writeFile(path.join(tmpDir, "shot.png"), Buffer.from([1, 2, 3]));
		await fs.writeFile(path.join(tmpDir, "notes.txt"), "ignored");
		const listed = await mcpClient.listResources();
		expect(listed.resources.map((r) => r.uri).sort()).toEqual(["graphite-export://logo.svg", "graphite-export://shot.png"]);
		const svg = await mcpClient.readResource({ uri: "graphite-export://logo.svg" });
		expect(svg.contents[0]).toMatchObject({ mimeType: "image/svg+xml", text: expect.stringContaining("<svg") });
		const png = await mcpClient.readResource({ uri: "graphite-export://shot.png" });
		expect(png.contents[0]).toMatchObject({ mimeType: "image/png", blob: Buffer.from([1, 2, 3]).toString("base64") });
		await expect(mcpClient.readResource({ uri: "graphite-export://notes.txt" })).rejects.toThrow();
		await expect(mcpClient.readResource({ uri: "graphite-export://..%2Fsecret.svg" })).rejects.toThrow();
	});
});

describe("export path resolution", () => {
	it("sanitizes names and forces the extension", async () => {
		expect(sanitizeBaseName('bad/name:*?"<>|')).toBe("bad_name_______");
		expect(sanitizeBaseName("   ")).toBe("graphite-export");
		const resolved = await resolveExportPath("my logo.txt", "png", [tmpDir], tmpDir, "fallback");
		expect(resolved.filePath.endsWith(`${path.sep}my logo.txt.png`)).toBe(true);
		expect(resolved.baseName).toBe("my logo.txt");
	});

	it("uses the fallback name when no path is given", async () => {
		const resolved = await resolveExportPath(undefined, "svg", [tmpDir], tmpDir, "Untitled");
		expect(path.basename(resolved.filePath)).toBe("Untitled.svg");
	});
});

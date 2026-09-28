// @vitest-environment jsdom
/**
 * Behavioural test of the in-tab automation bridge (graphite-patch/frontend/src/automation-bridge.ts).
 *
 * The bridge runs under jsdom with a fake `EditorWrapper` that reacts to the automation* calls by emitting the same
 * FrontendMessages Graphite would (UpdateActiveDocument, UpdateDocumentLayerStructure, TriggerSaveFile). It talks to the
 * real `GraphiteClient` over a real localhost WebSocket, so the whole protocol is exercised end to end minus Rust.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GraphiteClient } from "../src/graphite/client.js";
import { createAutomationBridge, type AutomationBridge } from "../graphite-patch/frontend/src/automation-bridge.js";

const TOKEN = "bridge-test-token-0123456789";

type Emit = (type: string, data: unknown) => void;

/** Stand-in for the wasm EditorWrapper: each automation call emits what the Rust editor would. */
class FakeEditor {
	crashed = false;
	/** How long the fake executor takes to hand back an export. */
	exportDelayMs = 10;
	calls: Array<{ fn: string; args: unknown[] }> = [];
	private nextDocumentId = 1000n;
	private layers: bigint[] = [];
	constructor(private readonly emit: Emit) {}

	hasCrashed() {
		return this.crashed;
	}
	graphiteCommitHash() {
		return "ae321b34";
	}
	automationNewDocument(name: string) {
		this.calls.push({ fn: "automationNewDocument", args: [name] });
		const id = this.nextDocumentId++;
		this.layers = [];
		// Graphite emits the documents list, then the active document (synchronously, inside dispatch)
		this.emit("UpdateOpenDocumentsList", { openDocuments: [{ id, name: `${name} (resolved)`, path: null, is_saved: true }] });
		this.emit("UpdateActiveDocument", { documentId: id });
		this.emit("UpdateDocumentLayerStructure", { layerStructure: [] });
	}
	automationInsertSvg(id: bigint, svg: string, x: number, y: number, center: boolean, parentId?: bigint, name?: string) {
		this.calls.push({ fn: "automationInsertSvg", args: [id, svg, x, y, center, parentId, name] });
		if (svg.includes("usvg-will-reject")) return; // Rust only shows a dialog; nothing is created
		this.layers.push(id);
		this.emit("UpdateDocumentLayerStructure", { layerStructure: this.layers.map((layerId) => ({ layerId, children: [], childrenPresent: false, descendantSelected: false })) });
	}
	selectDocument(id: bigint) {
		this.calls.push({ fn: "selectDocument", args: [id] });
		this.emit("UpdateActiveDocument", { documentId: id });
	}
	automationSetFill(id: bigint, color?: string) {
		this.calls.push({ fn: "automationSetFill", args: [id, color] });
	}
	automationSetStroke(id: bigint, color: string | undefined, weight: number) {
		this.calls.push({ fn: "automationSetStroke", args: [id, color, weight] });
	}
	automationSetOpacity(id: bigint, opacity: number) {
		this.calls.push({ fn: "automationSetOpacity", args: [id, opacity] });
	}
	automationSetTransform(id: bigint, a: number, b: number, c: number, d: number, e: number, f: number, replace: boolean) {
		this.calls.push({ fn: "automationSetTransform", args: [id, a, b, c, d, e, f, replace] });
	}
	automationDeleteLayer(id: bigint) {
		this.calls.push({ fn: "automationDeleteLayer", args: [id] });
		this.layers = this.layers.filter((l) => l !== id);
		this.emit("UpdateDocumentLayerStructure", { layerStructure: this.layers.map((layerId) => ({ layerId, children: [], childrenPresent: false, descendantSelected: false })) });
	}
	automationRenameLayer(id: bigint, name: string) {
		this.calls.push({ fn: "automationRenameLayer", args: [id, name] });
		this.emit("UpdateDocumentLayerDetails", { data: { id, alias: name, implementationName: "Group", visible: true } });
	}
	automationUndo() {
		this.calls.push({ fn: "automationUndo", args: [] });
	}
	automationRedo() {
		this.calls.push({ fn: "automationRedo", args: [] });
	}
	automationExport(name: string, fileType: string, scaleFactor: number) {
		this.calls.push({ fn: "automationExport", args: [name, fileType, scaleFactor] });
		// The executor is asynchronous in Graphite; emulate that with a macrotask
		setTimeout(() => {
			const bytes = new TextEncoder().encode(`<svg data-name="${name}" data-type="${fileType}" data-scale="${scaleFactor}"/>`);
			this.emit("TriggerSaveFile", { name: `${name}.${fileType.toLowerCase()}`, folder: null, filters: [], content: bytes });
		}, this.exportDelayMs);
	}
}

let client: GraphiteClient;
let bridge: AutomationBridge;
let editor: FakeEditor;
let routerSaw: string[];
let port: number;

/** Wires the bridge the way App.svelte does: intercept first, then the subscriptions router. */
function mountBridge(): void {
	routerSaw = [];
	bridge = createAutomationBridge();
	editor = new FakeEditor((type, data) => {
		const message = { [type]: data } as never;
		if (bridge.intercept(type, message)) return;
		routerSaw.push(type);
	});
	bridge.attach(editor as never);
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
		await new Promise((r) => setTimeout(r, 15));
	}
}

beforeEach(async () => {
	client = new GraphiteClient({ host: "127.0.0.1", port: 0, token: TOKEN, allowedOrigins: [], requestTimeoutMs: 2000, log: () => undefined });
	await client.listen();
	port = client.port;
	localStorage.setItem("graphiteAutomationToken", TOKEN);
	localStorage.setItem("graphiteAutomationEndpoint", `ws://127.0.0.1:${port}`);
});

afterEach(async () => {
	bridge?.destroy();
	await client.close();
	localStorage.clear();
});

describe("automation bridge", () => {
	it("is inert without a token", () => {
		localStorage.removeItem("graphiteAutomationToken");
		const inert = createAutomationBridge();
		expect(inert.enabled).toBe(false);
		expect(inert.intercept("TriggerSaveFile", { TriggerSaveFile: {} } as never)).toBe(false);
	});

	it("reads the token from ?automation= and scrubs it from the URL", () => {
		localStorage.clear();
		window.history.replaceState(null, "", "/?automation=from-url&other=1");
		const fromUrl = createAutomationBridge();
		expect(fromUrl.enabled).toBe(true);
		expect(localStorage.getItem("graphiteAutomationToken")).toBe("from-url");
		expect(window.location.search).toBe("?other=1");
		fromUrl.destroy();
	});

	it("connects, authenticates and answers get_capabilities", async () => {
		mountBridge();
		await waitUntil(() => client.connected);
		expect(client.info?.graphite_commit).toBe("ae321b34");
		const caps = await client.request("get_capabilities", {});
		expect(caps).toMatchObject({ protocol_version: 1, graphite_commit: "ae321b34", commands: expect.arrayContaining(["insert_svg", "get_document", "set_fill", "set_transform", "delete_layer", "undo"]) });
	});

	it("new_document returns the id Graphite activated and the resolved name", async () => {
		mountBridge();
		await waitUntil(() => client.connected);
		const result = await client.request("new_document", { name: "Logo" });
		expect(result).toEqual({ document_id: "1000", name: "Logo (resolved)" });
		expect(editor.calls[0]).toEqual({ fn: "automationNewDocument", args: ["Logo"] });
		// Nothing was swallowed from the router
		expect(routerSaw).toEqual(["UpdateOpenDocumentsList", "UpdateActiveDocument", "UpdateDocumentLayerStructure"]);
	});

	it("insert_svg requires an active document", async () => {
		mountBridge();
		await waitUntil(() => client.connected);
		await expect(client.request("insert_svg", { svg: "<svg xmlns='http://www.w3.org/2000/svg'/>", x: 0, y: 0, center: false, layer_id: "7" })).rejects.toMatchObject({
			code: "NO_ACTIVE_DOCUMENT",
		});
	});

	it("insert_svg passes bigint ids through and confirms via the layer structure", async () => {
		mountBridge();
		await waitUntil(() => client.connected);
		await client.request("new_document", { name: "Doc" });
		const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
		const result = await client.request("insert_svg", { svg, x: 12.5, y: -3, center: true, layer_id: "18446744073709551000", name: "Star" });
		expect(result).toEqual({ layer_id: "18446744073709551000", document_id: "1000" });
		const call = editor.calls.find((c) => c.fn === "automationInsertSvg")!;
		expect(call.args).toEqual([18446744073709551000n, svg, 12.5, -3, true, undefined, "Star"]);
	});

	it("insert_svg validates the parent and the SVG locally", async () => {
		mountBridge();
		await waitUntil(() => client.connected);
		await client.request("new_document", { name: "Doc" });
		await expect(client.request("insert_svg", { svg: "<svg xmlns='http://www.w3.org/2000/svg'/>", x: 0, y: 0, center: false, layer_id: "1", parent_id: "999" })).rejects.toMatchObject({
			code: "LAYER_NOT_FOUND",
		});
		await expect(client.request("insert_svg", { svg: "<svg><rect></svg>", x: 0, y: 0, center: false, layer_id: "1" })).rejects.toMatchObject({ code: "INVALID_SVG" });
		await expect(client.request("insert_svg", { svg: "<svg xmlns='http://www.w3.org/2000/svg'><script>1</script></svg>", x: 0, y: 0, center: false, layer_id: "1" })).rejects.toMatchObject({
			code: "INVALID_SVG",
		});
		expect(editor.calls.filter((c) => c.fn === "automationInsertSvg")).toHaveLength(0);
	});

	it("insert_svg reports BRIDGE_TIMEOUT (not INVALID_SVG) when Graphite has not reported the layer in time", async () => {
		mountBridge();
		await waitUntil(() => client.connected);
		await client.request("new_document", { name: "Doc" });
		const svg = "<svg xmlns='http://www.w3.org/2000/svg'><g><!-- usvg-will-reject --><rect/><rect/></g></svg>";
		const pending = client.request("insert_svg", { svg, x: 0, y: 0, center: false, layer_id: "5", timeout_ms: 300 });
		await expect(pending).rejects.toMatchObject({
			code: "BRIDGE_TIMEOUT",
			message: expect.stringContaining("get_document"),
			details: { layer_id: "5", elements: 4, timeout_ms: 500 }, // 300 requested, clamped to the 500 ms floor
		});
	});

	it("get_document reports the active document and its layer ids", async () => {
		mountBridge();
		await waitUntil(() => client.connected);
		await expect(client.request("get_document", {})).rejects.toMatchObject({ code: "NO_ACTIVE_DOCUMENT" });
		await client.request("new_document", { name: "Doc" });
		expect(await client.request("get_document", {})).toMatchObject({ document_id: "1000", name: "Doc (resolved)", layer_count: 0, layer_ids: [], layers: [], open_documents: [{ document_id: "1000", name: "Doc (resolved)" }] });
		await client.request("insert_svg", { svg: "<svg xmlns='http://www.w3.org/2000/svg'><rect/></svg>", x: 0, y: 0, center: false, layer_id: "42" });
		expect(await client.request("get_document", {})).toMatchObject({ layer_count: 1, layer_ids: ["42"], layers: [{ id: "42", name: null, visible: true, parent_id: null }] });
		await client.request("rename_layer", { layer_id: "42", name: "Hero" });
		expect(await client.request("get_document", {})).toMatchObject({ layers: [{ id: "42", name: "Hero", kind: "Group" }] });
	});

	it("edits existing layers: style, transform, rename, delete, undo/redo, and refuses unknown ids", async () => {
		mountBridge();
		await waitUntil(() => client.connected);
		await client.request("new_document", { name: "Doc" });
		await client.request("insert_svg", { svg: "<svg xmlns='http://www.w3.org/2000/svg'><rect/></svg>", x: 0, y: 0, center: false, layer_id: "7" });

		expect(await client.request("set_fill", { layer_id: "7", color: "#FF8800" })).toEqual({ layer_id: "7" });
		expect(await client.request("set_fill", { layer_id: "7", color: null })).toEqual({ layer_id: "7" });
		expect(await client.request("set_stroke", { layer_id: "7", color: "112233aa", weight: 2.5 })).toEqual({ layer_id: "7" });
		expect(await client.request("set_opacity", { layer_id: "7", opacity: 0.4 })).toEqual({ layer_id: "7" });
		expect(await client.request("set_transform", { layer_id: "7", matrix: [1, 0, 0, 1, 10, 20], replace: false })).toEqual({ layer_id: "7" });
		await client.request("undo", {});
		await client.request("redo", {});
		expect(editor.calls.filter((c) => c.fn.startsWith("automationSet")).map((c) => c.args)).toEqual([
			[7n, "ff8800"],
			[7n, undefined],
			[7n, "112233aa", 2.5],
			[7n, 0.4],
			[7n, 1, 0, 0, 1, 10, 20, false],
		]);
		expect(editor.calls.map((c) => c.fn)).toEqual(expect.arrayContaining(["automationUndo", "automationRedo"]));

		await expect(client.request("set_fill", { layer_id: "7", color: "red" })).rejects.toMatchObject({ code: "INVALID_COLOR" });
		await expect(client.request("set_opacity", { layer_id: "7", opacity: 2 })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
		await expect(client.request("set_transform", { layer_id: "7", matrix: [1, 0, 0], replace: false })).rejects.toMatchObject({ code: "INVALID_TRANSFORM" });
		await expect(client.request("set_fill", { layer_id: "999", color: "#000000" })).rejects.toMatchObject({ code: "LAYER_NOT_FOUND" });

		expect(await client.request("delete_layer", { layer_id: "7" })).toEqual({ layer_id: "7", deleted: true });
		expect(await client.request("get_document", {})).toMatchObject({ layer_count: 0 });
		await expect(client.request("delete_layer", { layer_id: "7" })).rejects.toMatchObject({ code: "LAYER_NOT_FOUND" });
	});

	it("switches between open documents", async () => {
		mountBridge();
		await waitUntil(() => client.connected);
		await client.request("new_document", { name: "A" });
		// The fake replaces the open list on every new document; emulate two open documents by hand
		const secondId = (await client.request("new_document", { name: "B" })) as { document_id: string };
		editor["emit"]("UpdateOpenDocumentsList", { openDocuments: [{ id: 1000n, name: "A" }, { id: BigInt(secondId.document_id), name: "B" }] });
		expect(await client.request("select_document", { document_id: "1000" })).toEqual({ document_id: "1000", name: "A" });
		expect(editor.calls.at(-1)).toEqual({ fn: "selectDocument", args: [1000n] });
		await expect(client.request("select_document", { document_id: "5" })).rejects.toMatchObject({ code: "DOCUMENT_NOT_FOUND" });
	});

	it("export refuses an empty document instead of waiting for a timeout", async () => {
		mountBridge();
		await waitUntil(() => client.connected);
		await client.request("new_document", { name: "Doc" });
		await expect(client.request("export", { format: "svg", scale_factor: 1, name: "empty" })).rejects.toMatchObject({
			code: "EXPORT_FAILED",
			message: expect.stringContaining("no layers"),
		});
		expect(editor.calls.filter((c) => c.fn === "automationExport")).toHaveLength(0);
	});

	it("export reports a slow render honestly and swallows the late file", async () => {
		mountBridge();
		await waitUntil(() => client.connected);
		await client.request("new_document", { name: "Doc" });
		await client.request("insert_svg", { svg: "<svg xmlns='http://www.w3.org/2000/svg'><rect/></svg>", x: 0, y: 0, center: false, layer_id: "1" });
		editor.exportDelayMs = 900;
		routerSaw.length = 0;
		await expect(client.request("export", { format: "png", scale_factor: 1, name: "slow", timeout_ms: 500 })).rejects.toMatchObject({
			code: "BRIDGE_TIMEOUT",
			message: expect.stringContaining("1 layers"),
			details: { timeout_ms: 500, layer_count: 1 },
		});
		await new Promise((r) => setTimeout(r, 400));
		expect(routerSaw).not.toContain("TriggerSaveFile");
		// The bridge is usable again afterwards
		editor.exportDelayMs = 10;
		const result = (await client.request("export", { format: "png", scale_factor: 1, name: "slow" })) as { file_name: string };
		expect(result.file_name).toBe("slow.png");
	});

	it("export intercepts TriggerSaveFile and returns base64 bytes without letting the router download it", async () => {
		mountBridge();
		await waitUntil(() => client.connected);
		await client.request("new_document", { name: "Doc" });
		await client.request("insert_svg", { svg: "<svg xmlns='http://www.w3.org/2000/svg'><rect/></svg>", x: 0, y: 0, center: false, layer_id: "1" });
		routerSaw.length = 0;
		const result = (await client.request("export", { format: "png", scale_factor: 2, name: "hero" })) as { file_name: string; content_base64: string; byte_length: number; format: string };
		expect(result.file_name).toBe("hero.png");
		expect(result.format).toBe("png");
		const decoded = Buffer.from(result.content_base64, "base64").toString();
		expect(decoded).toBe('<svg data-name="hero" data-type="Png" data-scale="2"/>');
		expect(result.byte_length).toBe(decoded.length);
		expect(routerSaw).not.toContain("TriggerSaveFile");
		expect(editor.calls.at(-1)).toEqual({ fn: "automationExport", args: ["hero", "Png", 2] });
	});

	it("export rejects unsupported formats and reports a crashed editor", async () => {
		mountBridge();
		await waitUntil(() => client.connected);
		await client.request("new_document", { name: "Doc" });
		await client.request("insert_svg", { svg: "<svg xmlns='http://www.w3.org/2000/svg'><rect/></svg>", x: 0, y: 0, center: false, layer_id: "1" });
		await expect(client.request("export", { format: "pdf" as never, scale_factor: 1, name: "x" })).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT" });
		editor.crashed = true;
		await expect(client.request("export", { format: "svg", scale_factor: 1, name: "x" })).rejects.toMatchObject({ code: "GRAPHITE_CRASHED" });
	});

	it("refuses unknown commands", async () => {
		mountBridge();
		await waitUntil(() => client.connected);
		// Bypass the client's own whitelist to make sure the bridge enforces its own
		const raw = (client as unknown as { socket: { send(data: string): void } }).socket;
		const reply = new Promise<string>((resolve) => {
			(client as unknown as { pending: Map<string, { resolve(v: unknown): void; reject(e: { code: string }): void; timer: NodeJS.Timeout; command: string }> }).pending.set("raw-1", {
				resolve: () => resolve("ok"),
				reject: (e) => resolve(e.code),
				timer: setTimeout(() => undefined, 0),
				command: "raw",
			});
		});
		raw.send(JSON.stringify({ id: "raw-1", command: "execute_raw_message", params: {} }));
		expect(await reply).toBe("UNKNOWN_COMMAND");
	});
});

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { GraphiteError } from "../graphite/errors.js";
import type { ExportResult } from "../graphite/protocol.js";
import { run, type ToolContext } from "./shared.js";

/** Image blocks travel inside the model's context, so keep previews small. */
const MAX_PREVIEW_BYTES = 4 * 1024 * 1024;
const BRIDGE_MARGIN_MS = 3_000;
const SOCKET_SLACK_MS = 5_000;

export const previewInput = {
	scale: z
		.number()
		.finite()
		.positive()
		.max(2)
		.default(0.5)
		.describe("Raster scale relative to the document's pixel size. 0.5 is enough to judge composition; use 1 for detail. Larger previews cost more context."),
};

export const previewOutput = {
	width: z.number().int().nonnegative().describe("Pixel width of the preview."),
	height: z.number().int().nonnegative().describe("Pixel height of the preview."),
	bytes: z.number().int().nonnegative(),
	scale: z.number(),
};

/** Reads the IHDR chunk of a PNG; returns zeros for anything that is not a PNG. */
export function pngDimensions(png: Uint8Array): { width: number; height: number } {
	const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	if (png.length < 24 || signature.some((b, i) => png[i] !== b)) return { width: 0, height: 0 };
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
	return { width: view.getUint32(16), height: view.getUint32(20) };
}

export function registerPreview(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"graphite_preview",
		{
			title: "Graphite: look at the canvas",
			description:
				"Render the active document to a PNG and return it as an image so you can see what Graphite actually drew. Nothing is written to disk. " +
				"Use it after inserting artwork to check composition, alignment and missing elements before iterating; default scale 0.5 keeps the image small. " +
				"Fails with EXPORT_FAILED when the document has no layers and BRIDGE_TIMEOUT when rendering is slow (retry).",
			inputSchema: previewInput,
			outputSchema: previewOutput,
			annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
		},
		async ({ scale }) =>
			run(async (): Promise<CallToolResult> => {
				const bridgeTimeoutMs = Math.max(5_000, ctx.config.exportTimeoutMs - BRIDGE_MARGIN_MS);
				const result = (await ctx.client.request(
					"export",
					{ format: "png", scale_factor: scale, name: "preview", timeout_ms: bridgeTimeoutMs },
					bridgeTimeoutMs + SOCKET_SLACK_MS,
				)) as ExportResult;
				if (!result.content_base64) throw new GraphiteError("EXPORT_FAILED", "Graphite returned an empty preview.");
				const bytes = Buffer.from(result.content_base64, "base64");
				if (bytes.byteLength === 0) throw new GraphiteError("EXPORT_FAILED", "Graphite returned zero bytes.");
				if (bytes.byteLength > MAX_PREVIEW_BYTES) {
					throw new GraphiteError("EXPORT_FAILED", `The preview is ${bytes.byteLength} bytes; request a smaller scale (the limit is ${MAX_PREVIEW_BYTES} bytes).`);
				}
				const { width, height } = pngDimensions(bytes);
				const structured = { width, height, bytes: bytes.byteLength, scale };
				return {
					content: [
						{ type: "image", data: bytes.toString("base64"), mimeType: "image/png" },
						{ type: "text", text: `Preview of the active document at scale ${scale}: ${width}×${height} px, ${bytes.byteLength} bytes.` },
					],
					structuredContent: structured,
				};
			}),
	);
}

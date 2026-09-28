import { promises as fs } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveExportPath } from "../graphite/export-path.js";
import { GraphiteError } from "../graphite/errors.js";
import { EXPORT_FORMATS, type ExportResult } from "../graphite/protocol.js";
import { ok, run, type ToolContext } from "./shared.js";

/** The bridge's own wait is kept a little shorter than the socket timeout so its detailed error is the one reported. */
const BRIDGE_MARGIN_MS = 3_000;
const SOCKET_SLACK_MS = 5_000;

export const exportInput = {
	format: z.enum(EXPORT_FORMATS).default("svg").describe("Output format. svg keeps vectors; the raster formats are rendered at the document's pixel size times scale."),
	path: z
		.string()
		.trim()
		.min(1)
		.max(1000)
		.optional()
		.describe(
			"Where to write the file. A bare file name goes into the connector's export directory; an absolute path must lie inside one of the approved export roots. The extension is fixed to match format. Omit to use the document name.",
		),
	scale: z.number().finite().positive().max(16).default(1).describe("Raster scale factor (2 = 2× resolution; 0.25–0.5 gives a quick preview). Ignored for svg."),
};

export const exportOutput = {
	success: z.literal(true),
	path: z.string().describe("Absolute path of the written file."),
	format: z.enum(EXPORT_FORMATS),
	bytes: z.number().int().nonnegative(),
};

export function registerExport(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"graphite_export",
		{
			title: "Graphite: export the active document",
			description:
				"Render the active Graphite document (all artwork) to a file and write it to disk. Returns the absolute path. " +
				"Use svg for editable/scalable output and png for a bitmap; png with scale 0.25–0.5 is a cheap way to check what Graphite actually rendered. " +
				"Fails with EXPORT_FAILED if the document has no layers, BRIDGE_TIMEOUT if rendering did not finish within GRAPHITE_MCP_EXPORT_TIMEOUT_MS " +
				"(the first raster render of a large document can be slow: simply retry, or raise the limit), and EXPORT_PATH_NOT_ALLOWED if path escapes the approved export directories.",
			inputSchema: exportInput,
			outputSchema: exportOutput,
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		async ({ format, path: requestedPath, scale }) =>
			run(async () => {
				const resolved = await resolveExportPath(requestedPath, format, ctx.config.exportRoots, ctx.config.defaultExportDir, "graphite-export");
				const bridgeTimeoutMs = Math.max(5_000, ctx.config.exportTimeoutMs - BRIDGE_MARGIN_MS);

				const result = (await ctx.client.request(
					"export",
					{ format, scale_factor: scale, name: resolved.baseName, timeout_ms: bridgeTimeoutMs },
					bridgeTimeoutMs + SOCKET_SLACK_MS,
				)) as ExportResult;
				if (!result.content_base64) throw new GraphiteError("EXPORT_FAILED", "Graphite returned an empty export.");

				const bytes = Buffer.from(result.content_base64, "base64");
				if (bytes.byteLength === 0) throw new GraphiteError("EXPORT_FAILED", "Graphite returned zero bytes.");
				await fs.writeFile(resolved.filePath, bytes);
				ctx.log(`wrote ${bytes.byteLength} bytes to ${resolved.filePath}`);

				return ok(`Exported the active document as ${format.toUpperCase()} to ${resolved.filePath} (${bytes.byteLength} bytes).`, {
					success: true as const,
					path: resolved.filePath,
					format,
					bytes: bytes.byteLength,
				});
			}),
	);
}

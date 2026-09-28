import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import { GraphiteClient } from "./graphite/client.js";
import { registerEditTools } from "./tools/edit.js";
import { registerExport } from "./tools/export.js";
import { registerGetCapabilities } from "./tools/get-capabilities.js";
import { registerGetDocument } from "./tools/get-document.js";
import { registerInsertSvg } from "./tools/insert-svg.js";
import { registerNewDocument } from "./tools/new-document.js";
import { registerExportResources } from "./resources.js";
import { registerPreview } from "./tools/preview.js";
import { fontLoader, type RuntimeState, type ToolContext } from "./tools/shared.js";
import { CONNECTOR_VERSION } from "./version.js";

export interface GraphiteMcp {
	server: McpServer;
	client: GraphiteClient;
	/** Mutable state the entry point fills in after start-up (e.g. where the served Graphite lives). */
	runtime: RuntimeState;
	close(): Promise<void>;
}

/** Builds the MCP server and the Graphite bridge endpoint. The caller picks the MCP transport (stdio in `index.ts`). */
export function createGraphiteMcp(config: Config, log: (message: string) => void): GraphiteMcp {
	const client = new GraphiteClient({
		host: config.host,
		port: config.port,
		token: config.token,
		allowedOrigins: config.allowedOrigins,
		// Default per-command budget; insert_svg and export pass their own, larger ones per call
		requestTimeoutMs: config.requestTimeoutMs,
		log,
	});

	const server = new McpServer(
		{ name: "graphite-art-mcp", version: CONNECTOR_VERSION },
		{
			instructions:
				"Unofficial connector for the Graphite vector/raster editor (graphite.art). Workflow: graphite_new_document (optional) → generate SVG → graphite_insert_svg → graphite_export. " +
				"All artwork is created by writing SVG; Graphite converts it into editable vector layers. If a call returns GRAPHITE_NOT_CONNECTED, ask the user to open Graphite with the automation bridge enabled and check graphite_get_capabilities. " +
				"Working well: (1) <text> in inserted SVG is converted to outlined paths automatically (bundled Liberation fonts; put .ttf/.otf files in GRAPHITE_MCP_FONT_DIR for other typefaces), since Graphite itself cannot render it. " +
				"(2) Every SVG element becomes a layer, so large artwork takes tens of seconds to insert; write it to a file and pass svg_path instead of inline markup, and never re-insert after a BRIDGE_TIMEOUT without checking graphite_get_document for the returned layer_id, or the artwork ends up twice. " +
				"(3) After inserting, call graphite_preview to look at the canvas and check the result before iterating; preview locally too (render the SVG with any local tool) while designing. " +
				"(4) Existing layers can be changed with graphite_set_style, graphite_transform_layer, graphite_rename_layer and graphite_delete_layer, and mistakes reverted with graphite_undo; prefer that over re-inserting. " +
				"(5) For illustrative work look up references first, and construct 3D-looking objects (boxes, trays, rooms) as real 3D geometry under one parallel projection, drawing faces back to front, rather than placing quadrilaterals by eye.",
		},
	);

	const runtime: RuntimeState = { webUrl: null };
	const ctx: ToolContext = { client, config, log, runtime, fonts: fontLoader(config, log) };
	registerGetCapabilities(server, ctx);
	registerNewDocument(server, ctx);
	registerInsertSvg(server, ctx);
	registerExport(server, ctx);
	registerGetDocument(server, ctx);
	registerPreview(server, ctx);
	registerEditTools(server, ctx);
	registerExportResources(server, ctx);

	return {
		server,
		client,
		runtime,
		async close() {
			await client.close();
			await server.close();
		},
	};
}

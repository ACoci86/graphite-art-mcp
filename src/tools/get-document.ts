import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GetDocumentResult } from "../graphite/protocol.js";
import { ok, run, type ToolContext } from "./shared.js";

export const getDocumentOutput = {
	document_id: z.string().describe("Graphite DocumentId of the active document, as a decimal string."),
	name: z.string().nullable().describe("Tab name of the active document, when known."),
	layer_count: z.number().int().nonnegative(),
	layer_ids: z.array(z.string()).describe("Every layer id in the active document (decimal strings), nested groups included."),
	layers: z
		.array(z.object({ id: z.string(), name: z.string().nullable(), kind: z.string().nullable(), visible: z.boolean(), parent_id: z.string().nullable() }))
		.describe("Per-layer details: display name, node kind, visibility and parent (null = document root)."),
	open_documents: z.array(z.object({ document_id: z.string(), name: z.string() })).describe("All open documents; switch with graphite_select_document."),
};

export function registerGetDocument(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"graphite_get_document",
		{
			title: "Graphite: inspect the active document",
			description:
				"Return the active document's id and name, all its layers (id, name, kind, visibility, parent) and the list of open documents. Read-only. " +
				"Use it to verify that a graphite_insert_svg reported as BRIDGE_TIMEOUT did or did not land (look for the layer_id in layer_ids) before deciding to retry, " +
				"and to confirm a document is not empty before exporting. Fails with NO_ACTIVE_DOCUMENT when nothing is open.",
			inputSchema: {},
			outputSchema: getDocumentOutput,
			annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
		},
		async () =>
			run(async () => {
				const doc = (await ctx.client.request("get_document", {})) as GetDocumentResult;
				return ok(`Active document "${doc.name ?? "unnamed"}" (document_id ${doc.document_id}) has ${doc.layer_count} layer${doc.layer_count === 1 ? "" : "s"}.`, {
					document_id: doc.document_id,
					name: doc.name,
					layer_count: doc.layer_count,
					layer_ids: doc.layer_ids,
					layers: doc.layers ?? doc.layer_ids.map((id) => ({ id, name: null, kind: null, visible: true, parent_id: null })),
					open_documents: doc.open_documents ?? [],
				});
			}),
	);
}

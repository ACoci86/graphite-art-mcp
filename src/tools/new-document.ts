import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { NewDocumentResult } from "../graphite/protocol.js";
import { ok, run, type ToolContext } from "./shared.js";

export const newDocumentInput = {
	name: z.string().trim().min(1).max(200).default("Untitled Document").describe("Tab name for the new document."),
};

export const newDocumentOutput = {
	document_id: z.string().describe("Graphite DocumentId as a decimal string. Pass it back to other tools when they accept a document_id."),
	name: z.string().describe("The name Graphite actually assigned (it de-duplicates names of open documents)."),
};

export function registerNewDocument(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"graphite_new_document",
		{
			title: "Graphite: new document",
			description:
				"Create a new, empty Graphite document and make it the active tab. Returns its document_id. " +
				"The document has no artboard; artwork inserted afterwards lands at document coordinates where (0,0) is the origin and y grows downward. " +
				"Use this before graphite_insert_svg when the user asks for a fresh document; do not call it if they want to edit what is already open.",
			inputSchema: newDocumentInput,
			outputSchema: newDocumentOutput,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async ({ name }) =>
			run(async () => {
				const result = (await ctx.client.request("new_document", { name })) as NewDocumentResult;
				return ok(`Created document "${result.name}" (document_id ${result.document_id}); it is now the active tab.`, {
					document_id: result.document_id,
					name: result.name,
				});
			}),
	);
}

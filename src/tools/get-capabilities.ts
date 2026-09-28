import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CONNECTOR_VERSION } from "../version.js";
import { COMMAND_NAMES, PROTOCOL_VERSION, type Capabilities } from "../graphite/protocol.js";
import { ok, run, type ToolContext } from "./shared.js";

export const capabilitiesOutput = {
	connector_version: z.string(),
	protocol_version: z.number().int(),
	connected: z.boolean(),
	bridge_version: z.string().nullable(),
	graphite_commit: z.string().nullable(),
	endpoint: z.string(),
	tools: z.array(z.string()),
	bridge_commands: z.array(z.string()).nullable(),
	web_url: z.string().nullable().describe("URL of the Graphite web app served by this connector (token included); open it in a browser to connect a tab. Null when the connector is not serving one."),
};

export function registerGetCapabilities(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"graphite_get_capabilities",
		{
			title: "Graphite: connection status and capabilities",
			description:
				"Report whether a Graphite editor tab is connected to this connector, which Graphite commit it runs, and which commands are available. " +
				"Call this first if another graphite_* tool returned GRAPHITE_NOT_CONNECTED. Read-only; never changes the document.",
			inputSchema: {},
			outputSchema: capabilitiesOutput,
			annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
		},
		async () =>
			run(async () => {
				const endpoint = `ws://${ctx.config.host}:${ctx.config.port}`;
				const tools = [
					"graphite_get_capabilities",
					"graphite_new_document",
					"graphite_insert_svg",
					"graphite_export",
					"graphite_get_document",
					"graphite_preview",
					"graphite_set_style",
					"graphite_transform_layer",
					"graphite_rename_layer",
					"graphite_delete_layer",
					"graphite_undo",
					"graphite_redo",
					"graphite_select_document",
				];
				const webUrl = ctx.runtime.webUrl;
				if (!ctx.client.connected) {
					const hint = webUrl
						? `Ask the user to open ${webUrl} in a browser (the connector serves Graphite there; the token is in the URL). It may also still be downloading Graphite on first run.`
						: "Open Graphite with the automation bridge enabled and the matching token (see docs/claude.md).";
					return ok(`Not connected. No Graphite tab has attached to ${endpoint}. ${hint}`, {
							connector_version: CONNECTOR_VERSION,
							protocol_version: PROTOCOL_VERSION,
							connected: false,
							bridge_version: null,
							graphite_commit: null,
							endpoint,
							tools,
							bridge_commands: null,
							web_url: webUrl,
						},
					);
				}
				const capabilities = (await ctx.client.request("get_capabilities", {})) as Capabilities;
				return ok(`Connected to Graphite (commit ${capabilities.graphite_commit ?? "unknown"}, bridge ${capabilities.bridge_version}) at ${endpoint}.`, {
					connector_version: CONNECTOR_VERSION,
					protocol_version: PROTOCOL_VERSION,
					connected: true,
					bridge_version: capabilities.bridge_version,
					graphite_commit: capabilities.graphite_commit,
					endpoint,
					tools,
					bridge_commands: capabilities.commands.length > 0 ? capabilities.commands : [...COMMAND_NAMES],
					web_url: webUrl,
				});
			}),
	);
}

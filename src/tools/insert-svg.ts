import { promises as fs } from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GraphiteError } from "../graphite/errors.js";
import type { GetDocumentResult, InsertSvgResult } from "../graphite/protocol.js";
import { hasText, outlineText } from "../svg/outline-text.js";
import { generateNodeId, ok, run, type ToolContext } from "./shared.js";

const MAX_SVG_BYTES = 4 * 1024 * 1024;
/** Floor for the bridge-side wait; the bridge itself uses the same floor when no timeout is passed. */
const INSERT_BASE_TIMEOUT_MS = 10_000;
const INSERT_MAX_TIMEOUT_MS = 120_000;
/** Slack between the bridge's own wait and the connector's socket timeout, so the bridge's honest error wins over a generic one. */
const SOCKET_SLACK_MS = 5_000;

export const insertSvgInput = {
	svg: z
		.string()
		.min(1)
		.max(MAX_SVG_BYTES)
		.optional()
		.describe(
			"Complete SVG markup starting with <svg …>. Give it a viewBox and explicit width/height; gradients, groups, paths, basic shapes and text are supported " +
				"(<text> is converted to outlined paths by the connector, see outline_text). Provide either svg or svg_path.",
		),
	svg_path: z
		.string()
		.trim()
		.min(1)
		.max(1000)
		.optional()
		.describe(
			"Absolute path of a local SVG file to insert instead of inline markup. Prefer this for large artwork (hundreds of elements): the file is read by the connector, so the markup is not re-sent on every call.",
		),
	x: z.number().finite().default(0).describe("Horizontal position in document units (pixels). With center=false this is the left edge of the SVG viewBox."),
	y: z.number().finite().default(0).describe("Vertical position in document units; y grows downward. With center=false this is the top edge of the SVG viewBox."),
	center: z.boolean().default(false).describe("When true, (x, y) becomes the visual centre of the artwork instead of its top-left corner."),
	name: z.string().trim().min(1).max(200).optional().describe("Optional layer name shown in the Layers panel."),
	parent_id: z
		.string()
		.regex(/^\d+$/)
		.optional()
		.describe("Optional layer_id of a group or artboard to insert into. Omit to insert at the document root."),
	outline_text: z
		.boolean()
		.default(true)
		.describe(
			"Convert <text> elements to outlined paths before inserting (default). Graphite's web build cannot render text itself. " +
				"Uses the bundled Liberation Sans/Serif/Mono faces, or fonts from GRAPHITE_MCP_FONT_DIR matched by family name; italic is synthesised.",
		),
};

export const insertSvgOutput = {
	layer_id: z.string().describe("Node id of the new group layer, as a decimal string. Refer to it in later edits."),
	document_id: z.string().nullable().describe("Active document the layer was inserted into, when known."),
	elements: z.number().int().nonnegative().describe("Number of SVG elements sent; each becomes a layer."),
	confirmed_late: z.boolean().describe("True when the bridge's wait expired but graphite_get_document then showed the layer, so nothing needs to be retried."),
	text_outlined: z.number().int().nonnegative().describe("Number of <text> elements converted to paths before inserting."),
};

const SVG_OPEN_TAG = /<svg[\s>]/i;

/** Cheap pre-checks done here so obviously bad input never reaches Graphite (which would only show a dialog). */
export function precheckSvg(svg: string): void {
	const trimmed = svg.trim();
	if (!SVG_OPEN_TAG.test(trimmed)) throw new GraphiteError("INVALID_SVG", "The svg parameter must contain an <svg> root element.");
	const selfClosingRoot = /^<svg\b[^>]*\/>$/i.test(trimmed);
	if (!selfClosingRoot && !/<\/svg>\s*$/i.test(trimmed)) throw new GraphiteError("INVALID_SVG", "The SVG markup is not closed with </svg>.");
	if (/<script[\s>]/i.test(trimmed)) throw new GraphiteError("INVALID_SVG", "Scripts are not allowed inside inserted SVG.");
}

/** Rough element count (opening tags); it only sizes the wait, so exactness does not matter. */
export function countSvgElements(svg: string): number {
	return (svg.match(/<[a-zA-Z]/g) ?? []).length;
}

/** How long the bridge should wait for Graphite to report the layer: grows with the element count, bounded by config. */
export function insertTimeoutMs(elements: number, ctx: ToolContext): number {
	const scaled = INSERT_BASE_TIMEOUT_MS + ctx.config.insertMsPerElement * elements;
	return Math.min(INSERT_MAX_TIMEOUT_MS, Math.max(ctx.config.requestTimeoutMs, scaled));
}

async function readSvgFile(svgPath: string): Promise<string> {
	const resolved = path.resolve(svgPath);
	let stat;
	try {
		stat = await fs.stat(resolved);
	} catch {
		throw new GraphiteError("INVALID_PARAMS", `svg_path "${resolved}" does not exist or is not readable.`);
	}
	if (!stat.isFile()) throw new GraphiteError("INVALID_PARAMS", `svg_path "${resolved}" is not a file.`);
	if (stat.size > MAX_SVG_BYTES) throw new GraphiteError("INVALID_PARAMS", `svg_path "${resolved}" is ${stat.size} bytes; the limit is ${MAX_SVG_BYTES}.`);
	return fs.readFile(resolved, "utf8");
}

/**
 * After the bridge's wait expires the layer often still lands a few seconds later (Graphite builds one layer per
 * element). Poll get_document for a grace period so the caller gets a success instead of retrying and duplicating.
 */
async function confirmLate(layerId: string, ctx: ToolContext): Promise<boolean> {
	const grace = ctx.config.insertGraceMs;
	const interval = Math.min(2_000, Math.max(50, Math.floor(grace / 5)));
	const deadline = Date.now() + grace;
	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, interval));
		let doc: GetDocumentResult;
		try {
			doc = (await ctx.client.request("get_document", {})) as GetDocumentResult;
		} catch (error) {
			// An older bridge without get_document, or a dropped connection: nothing more we can learn here
			if (error instanceof GraphiteError && (error.code === "UNKNOWN_COMMAND" || error.code === "GRAPHITE_NOT_CONNECTED")) return false;
			continue;
		}
		if (doc.layer_ids.includes(layerId)) return true;
	}
	return false;
}

export function registerInsertSvg(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"graphite_insert_svg",
		{
			title: "Graphite: insert SVG as editable artwork",
			description:
				"Insert SVG markup into the active Graphite document as an editable group layer (each SVG element becomes its own vector layer; the user can keep editing it by hand). " +
				"This is the main way to create artwork: generate the SVG yourself, then call this with either svg (inline markup) or svg_path (a local file; preferred for anything large). Returns the new layer_id. " +
				"The operation is one undo step. <text> is converted to outlined paths automatically (Graphite cannot render text from SVG); pass outline_text=false to skip that. " +
				"Large artwork is slow to build (roughly 40 ms per element); the wait scales with the element count. " +
				"Fails with NO_ACTIVE_DOCUMENT if no document is open (call graphite_new_document first), INVALID_SVG if the markup does not parse, " +
				"and BRIDGE_TIMEOUT if Graphite has not reported the layer in time even after a grace period — in that case call graphite_get_document and look for the returned layer_id before retrying, because the layer may still appear and a retry would duplicate it.",
			inputSchema: insertSvgInput,
			outputSchema: insertSvgOutput,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async ({ svg: inlineSvg, svg_path, x, y, center, name, parent_id, outline_text }) =>
			run(async () => {
				if ((inlineSvg === undefined) === (svg_path === undefined)) {
					throw new GraphiteError("INVALID_PARAMS", "Provide exactly one of svg (inline markup) or svg_path (a local file).");
				}
				let svg = inlineSvg ?? (await readSvgFile(svg_path as string));
				precheckSvg(svg);
				let textOutlined = 0;
				if (outline_text && hasText(svg)) {
					const outlined = outlineText(svg, await ctx.fonts());
					svg = outlined.svg;
					textOutlined = outlined.converted;
					if (outlined.skipped > 0) ctx.log(`${outlined.skipped} <text> element(s) could not be outlined and will not render in Graphite`);
				}
				const elements = countSvgElements(svg);
				const timeoutMs = insertTimeoutMs(elements, ctx);
				const layerId = generateNodeId();
				const params: { svg: string; x: number; y: number; center: boolean; layer_id: string; parent_id?: string; name?: string; timeout_ms: number } = {
					svg,
					x,
					y,
					center,
					layer_id: layerId,
					timeout_ms: timeoutMs,
				};
				if (parent_id !== undefined) params.parent_id = parent_id;
				if (name !== undefined) params.name = name;

				const where = center ? `centred at (${x}, ${y})` : `with its top-left at (${x}, ${y})`;
				const source = svg_path ? ` from ${svg_path}` : "";
				let result: InsertSvgResult;
				let confirmedLate = false;
				try {
					result = (await ctx.client.request("insert_svg", params, timeoutMs + SOCKET_SLACK_MS)) as InsertSvgResult;
				} catch (error) {
					if (!(error instanceof GraphiteError) || error.code !== "BRIDGE_TIMEOUT") throw error;
					if (!(await confirmLate(layerId, ctx))) {
						throw new GraphiteError(
							"BRIDGE_TIMEOUT",
							`${error.message} The connector then polled graphite_get_document for ${ctx.config.insertGraceMs} ms without seeing layer ${layerId}. ` +
								"Do not retry blindly: call graphite_get_document first, because the layer may still appear and a retry would insert the artwork twice. " +
								"If it never appears, split the artwork into smaller inserts or raise GRAPHITE_MCP_INSERT_MS_PER_ELEMENT.",
							{ layer_id: layerId, elements, timeout_ms: timeoutMs, grace_ms: ctx.config.insertGraceMs },
						);
					}
					confirmedLate = true;
					result = { layer_id: layerId, document_id: null };
				}
				const late = confirmedLate ? " Graphite reported it after the initial wait expired; it is in place and must not be re-inserted." : "";
				const text = textOutlined > 0 ? ` ${textOutlined} text element(s) were outlined to paths.` : "";
				return ok(`Inserted SVG (${elements} elements${source}) as layer ${result.layer_id}${name ? ` ("${name}")` : ""} ${where}. It is selected in Graphite and remains fully editable.${text}${late}`, {
					layer_id: result.layer_id,
					document_id: result.document_id,
					elements,
					confirmed_late: confirmedLate,
					text_outlined: textOutlined,
				});
			}),
	);
}

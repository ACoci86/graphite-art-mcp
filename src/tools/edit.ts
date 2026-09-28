/**
 * Tools that change existing layers: style, transform, rename, delete, undo/redo, and switching documents.
 * They map one-to-one onto bridge commands; the bridge verifies the layer exists before touching it.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GraphiteError } from "../graphite/errors.js";
import type { LayerResult, SelectDocumentResult } from "../graphite/protocol.js";
import { ok, run, type ToolContext } from "./shared.js";

const layerId = z.string().regex(/^\d+$/).describe("layer_id as returned by graphite_insert_svg or listed by graphite_get_document.");
const hexColor = z
	.string()
	.regex(/^#?[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/)
	.nullable()
	.describe("Hex colour #rrggbb or #rrggbbaa, or null for none.");

export type Affine = [number, number, number, number, number, number];

/** Row-major 2×3 affine multiply: (m × n) applies n first, then m. */
export function multiply(m: Affine, n: Affine): Affine {
	const [a1, b1, c1, d1, e1, f1] = m;
	const [a2, b2, c2, d2, e2, f2] = n;
	return [a1 * a2 + c1 * b2, b1 * a2 + d1 * b2, a1 * c2 + c1 * d2, b1 * c2 + d1 * d2, a1 * e2 + c1 * f2 + e1, b1 * e2 + d1 * f2 + f1];
}

/** Builds `matrix(a b c d e f)` from translate / scale / rotate about an origin, in that visual order. */
export function composeTransform(input: { translate?: [number, number]; scale?: number | [number, number]; rotate?: number; origin?: [number, number] }): Affine {
	const [ox, oy] = input.origin ?? [0, 0];
	const [sx, sy] = input.scale === undefined ? [1, 1] : typeof input.scale === "number" ? [input.scale, input.scale] : input.scale;
	const angle = ((input.rotate ?? 0) * Math.PI) / 180;
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	const [tx, ty] = input.translate ?? [0, 0];
	const toOrigin: Affine = [1, 0, 0, 1, -ox, -oy];
	const scale: Affine = [sx, 0, 0, sy, 0, 0];
	const rotate: Affine = [cos, sin, -sin, cos, 0, 0];
	const back: Affine = [1, 0, 0, 1, ox + tx, oy + ty];
	return multiply(back, multiply(rotate, multiply(scale, toOrigin))).map((v) => (Math.abs(v) < 1e-12 ? 0 : v)) as Affine;
}

export function registerEditTools(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"graphite_set_style",
		{
			title: "Graphite: set fill, stroke or opacity of a layer",
			description:
				"Change the solid fill colour, stroke colour and width, and/or opacity of an existing layer. Only the fields given are changed; null removes a fill or stroke. " +
				"Each change is one undo step. Fails with LAYER_NOT_FOUND if the id is not in the active document.",
			inputSchema: {
				layer_id: layerId,
				fill: hexColor.optional(),
				stroke: hexColor.optional().describe("Stroke colour, or null to remove the stroke colour."),
				stroke_width: z.number().finite().nonnegative().optional().describe("Stroke width in document pixels (default 1 when a stroke colour is set)."),
				opacity: z.number().min(0).max(1).optional().describe("Layer opacity from 0 (transparent) to 1 (opaque)."),
			},
			outputSchema: { layer_id: z.string(), changed: z.array(z.string()) },
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async ({ layer_id, fill, stroke, stroke_width, opacity }) =>
			run(async () => {
				const changed: string[] = [];
				if (fill !== undefined) {
					await ctx.client.request("set_fill", { layer_id, color: fill });
					changed.push("fill");
				}
				if (stroke !== undefined || stroke_width !== undefined) {
					await ctx.client.request("set_stroke", { layer_id, color: stroke ?? null, weight: stroke_width ?? 1 });
					changed.push("stroke");
				}
				if (opacity !== undefined) {
					await ctx.client.request("set_opacity", { layer_id, opacity });
					changed.push("opacity");
				}
				if (changed.length === 0) throw new GraphiteError("INVALID_PARAMS", "Give at least one of fill, stroke, stroke_width or opacity.");
				return ok(`Updated ${changed.join(", ")} of layer ${layer_id}.`, { layer_id, changed });
			}),
	);

	server.registerTool(
		"graphite_transform_layer",
		{
			title: "Graphite: move, scale or rotate a layer",
			description:
				"Apply a transform to an existing layer, in its parent's coordinate space (document pixels for top-level layers). " +
				"Give translate, scale and/or rotate (applied as scale, then rotate about origin, then translate), or a raw SVG matrix [a, b, c, d, e, f]. " +
				"By default the transform is combined with the layer's current one; replace=true sets it outright. One undo step.",
			inputSchema: {
				layer_id: layerId,
				translate: z.tuple([z.number().finite(), z.number().finite()]).optional().describe("[dx, dy] in pixels."),
				scale: z.union([z.number().finite().positive(), z.tuple([z.number().finite(), z.number().finite()])]).optional().describe("Uniform factor or [sx, sy]."),
				rotate: z.number().finite().optional().describe("Degrees, clockwise (y grows downward)."),
				origin: z.tuple([z.number().finite(), z.number().finite()]).optional().describe("Pivot [x, y] for scale and rotate; default [0, 0]."),
				matrix: z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number()]).optional().describe("Raw affine matrix; overrides translate/scale/rotate."),
				replace: z.boolean().default(false).describe("true sets the layer's transform to exactly this matrix instead of combining."),
			},
			outputSchema: { layer_id: z.string(), matrix: z.array(z.number()).length(6), replace: z.boolean() },
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async ({ layer_id, translate, scale, rotate, origin, matrix, replace }) =>
			run(async () => {
				const compose: Parameters<typeof composeTransform>[0] = {};
				if (translate) compose.translate = translate;
				if (scale !== undefined) compose.scale = scale;
				if (rotate !== undefined) compose.rotate = rotate;
				if (origin) compose.origin = origin;
				const m: Affine = matrix ?? composeTransform(compose);
				if (!matrix && translate === undefined && scale === undefined && rotate === undefined && !replace) {
					throw new GraphiteError("INVALID_PARAMS", "Give translate, scale, rotate or matrix.");
				}
				await ctx.client.request("set_transform", { layer_id, matrix: m, replace });
				return ok(`${replace ? "Set" : "Applied"} transform matrix(${m.map((v) => +v.toFixed(4)).join(" ")}) on layer ${layer_id}.`, { layer_id, matrix: m, replace });
			}),
	);

	server.registerTool(
		"graphite_rename_layer",
		{
			title: "Graphite: rename a layer",
			description: "Set the name shown for a layer in the Layers panel.",
			inputSchema: { layer_id: layerId, name: z.string().trim().min(1).max(200) },
			outputSchema: { layer_id: z.string(), name: z.string() },
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async ({ layer_id, name }) =>
			run(async () => {
				const result = (await ctx.client.request("rename_layer", { layer_id, name })) as LayerResult;
				return ok(`Renamed layer ${layer_id} to "${name}".`, { layer_id: result.layer_id, name });
			}),
	);

	server.registerTool(
		"graphite_delete_layer",
		{
			title: "Graphite: delete a layer",
			description: "Delete a layer and everything inside it. Reversible with graphite_undo. Fails with LAYER_NOT_FOUND if the id is not in the active document.",
			inputSchema: { layer_id: layerId },
			outputSchema: { layer_id: z.string(), deleted: z.literal(true) },
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async ({ layer_id }) =>
			run(async () => {
				await ctx.client.request("delete_layer", { layer_id });
				return ok(`Deleted layer ${layer_id}.`, { layer_id, deleted: true as const });
			}),
	);

	server.registerTool(
		"graphite_undo",
		{
			title: "Graphite: undo",
			description: "Undo the most recent change in the active document (inserts, style, transform, rename and delete are each one step).",
			inputSchema: {},
			outputSchema: { ok: z.literal(true) },
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async () =>
			run(async () => {
				await ctx.client.request("undo", {});
				return ok("Undid the last change.", { ok: true as const });
			}),
	);

	server.registerTool(
		"graphite_redo",
		{
			title: "Graphite: redo",
			description: "Redo the most recently undone change in the active document.",
			inputSchema: {},
			outputSchema: { ok: z.literal(true) },
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async () =>
			run(async () => {
				await ctx.client.request("redo", {});
				return ok("Redid the last undone change.", { ok: true as const });
			}),
	);

	server.registerTool(
		"graphite_select_document",
		{
			title: "Graphite: switch the active document",
			description: "Make another open document the active tab. graphite_get_document lists open documents. All other tools act on the active document.",
			inputSchema: { document_id: z.string().regex(/^\d+$/) },
			outputSchema: { document_id: z.string(), name: z.string().nullable() },
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async ({ document_id }) =>
			run(async () => {
				const result = (await ctx.client.request("select_document", { document_id })) as SelectDocumentResult;
				return ok(`Document "${result.name ?? result.document_id}" is now active.`, { document_id: result.document_id, name: result.name });
			}),
	);
}

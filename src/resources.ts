/**
 * Exposes the files in the export directory as MCP resources (`graphite-export://<file name>`), so a client can list
 * and read what the connector wrote without knowing the filesystem path. Only files directly inside the default export
 * directory are visible; SVG is returned as text, everything else as a base64 blob.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./tools/shared.js";

const MIME_BY_EXTENSION: Record<string, string> = {
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".tiff": "image/tiff",
	".tif": "image/tiff",
	".bmp": "image/bmp",
	".tga": "image/x-tga",
	".ico": "image/x-icon",
};

export const EXPORT_SCHEME = "graphite-export";

export async function listExportFiles(dir: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		return entries
			.filter((e) => e.isFile() && path.extname(e.name).toLowerCase() in MIME_BY_EXTENSION)
			.map((e) => e.name)
			.sort();
	} catch {
		return [];
	}
}

export function registerExportResources(server: McpServer, ctx: ToolContext): void {
	const dir = ctx.config.defaultExportDir;
	const template = new ResourceTemplate(`${EXPORT_SCHEME}://{file}`, {
		list: async () => ({
			resources: (await listExportFiles(dir)).map((name) => ({
				uri: `${EXPORT_SCHEME}://${encodeURIComponent(name)}`,
				name,
				mimeType: MIME_BY_EXTENSION[path.extname(name).toLowerCase()] ?? "application/octet-stream",
				description: `Exported by graphite_export into ${dir}`,
			})),
		}),
	});
	server.registerResource(
		"graphite-exports",
		template,
		{ title: "Graphite exports", description: `Files written by graphite_export to ${dir}. SVG is returned as text, raster formats as base64.` },
		async (uri, variables) => {
			const raw = variables.file;
			const name = decodeURIComponent(Array.isArray(raw) ? (raw[0] ?? "") : String(raw ?? ""));
			// Only plain file names inside the export directory
			if (!name || name !== path.basename(name) || name.startsWith(".")) throw new Error(`Unknown export ${uri.href}`);
			const file = path.join(dir, name);
			const mimeType = MIME_BY_EXTENSION[path.extname(name).toLowerCase()];
			if (!mimeType) throw new Error(`Unknown export ${uri.href}`);
			const bytes = await fs.readFile(file).catch(() => {
				throw new Error(`No such export: ${name}`);
			});
			return {
				contents: [mimeType === "image/svg+xml" ? { uri: uri.href, mimeType, text: bytes.toString("utf8") } : { uri: uri.href, mimeType, blob: bytes.toString("base64") }],
			};
		},
	);
}

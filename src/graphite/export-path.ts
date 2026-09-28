/**
 * Export path safety. The model may propose a path; we only honour it when it resolves inside an approved root,
 * has the extension matching the requested format, and does not escape via `..` or symlink tricks
 * (we resolve the parent directory's real path before comparing).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { GraphiteError } from "./errors.js";
import type { ExportFormat } from "./protocol.js";

export interface ResolvedExportPath {
	/** Absolute path where the file will be written. */
	filePath: string;
	/** Base name without extension, handed to Graphite as the document/export name. */
	baseName: string;
}

const UNSAFE_NAME = /[\\/:*?"<>|\u0000-\u001f]/g;

export function sanitizeBaseName(name: string): string {
	const cleaned = name.replace(UNSAFE_NAME, "_").replace(/\.+$/, "").trim();
	return cleaned.length > 0 ? cleaned.slice(0, 120) : "graphite-export";
}

export async function resolveExportPath(
	requested: string | undefined,
	format: ExportFormat,
	roots: readonly string[],
	defaultDir: string,
	fallbackName: string,
): Promise<ResolvedExportPath> {
	const extension = `.${format}`;

	let filePath: string;
	if (requested === undefined || requested.trim() === "") {
		filePath = path.join(defaultDir, `${sanitizeBaseName(fallbackName)}${extension}`);
	} else {
		const trimmed = requested.trim();
		// A bare name or relative path is placed inside the default export directory
		filePath = path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.join(defaultDir, trimmed);
		if (trimmed.endsWith(path.sep) || trimmed.endsWith("/")) filePath = path.join(filePath, `${sanitizeBaseName(fallbackName)}${extension}`);
		if (path.extname(filePath).toLowerCase() !== extension) filePath = `${filePath}${extension}`;
	}

	const directory = path.dirname(filePath);
	await fs.mkdir(directory, { recursive: true }).catch(() => undefined);

	// Compare against the directory's real path so symlinks pointing outside the roots are caught
	const realDirectory = await fs.realpath(directory).catch(() => directory);
	const realRoots = await Promise.all(roots.map((root) => fs.realpath(root).catch(() => path.resolve(root))));
	const inside = realRoots.some((root) => realDirectory === root || realDirectory.startsWith(root + path.sep));
	if (!inside) {
		throw new GraphiteError(
			"EXPORT_PATH_NOT_ALLOWED",
			`Refusing to write outside the approved export directories. Allowed roots: ${roots.join(", ")}. Set GRAPHITE_MCP_EXPORT_ROOTS to add more.`,
			{ requested, resolved: filePath },
		);
	}

	const baseName = path.basename(filePath, extension);
	return { filePath: path.join(realDirectory, path.basename(filePath)), baseName: sanitizeBaseName(baseName) };
}

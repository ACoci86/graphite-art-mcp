import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { GraphiteClient } from "../graphite/client.js";
import { bundledFontDir, FontRegistry } from "../svg/fonts.js";
import { toGraphiteError } from "../graphite/errors.js";
import type { Config } from "../config.js";

export interface RuntimeState {
	/** Full URL (token included) of the Graphite web app this connector serves, or null when not serving. */
	webUrl: string | null;
}

export interface ToolContext {
	client: GraphiteClient;
	config: Config;
	log: (message: string) => void;
	runtime: RuntimeState;
	/** Fonts for outlining text, loaded on first use (user directories first, bundled faces last). */
	fonts(): Promise<FontRegistry>;
}

/** Builds the lazy font loader shared by the tools. */
export function fontLoader(config: Config, log: (message: string) => void): () => Promise<FontRegistry> {
	let loading: Promise<FontRegistry> | undefined;
	return () => {
		loading ??= FontRegistry.load([...config.fontDirs, bundledFontDir()], log).then((registry) => {
			if (registry.empty) log("no fonts found; <text> in inserted SVG will be dropped by Graphite");
			return registry;
		});
		return loading;
	};
}

/** Success: human-readable text plus the structured payload the tool's outputSchema describes. */
export function ok<T extends Record<string, unknown>>(text: string, structured: T): CallToolResult {
	return { content: [{ type: "text", text }], structuredContent: structured };
}

/** Failure: `isError` with a JSON envelope so the model can branch on `code`. */
export function fail(error: unknown): CallToolResult {
	const graphiteError = toGraphiteError(error);
	return { content: [{ type: "text", text: JSON.stringify(graphiteError.toJSON()) }], isError: true };
}

/** Runs a tool body and maps any throw into a structured failure. */
export async function run(body: () => Promise<CallToolResult>): Promise<CallToolResult> {
	try {
		return await body();
	} catch (error) {
		return fail(error);
	}
}

/** Node ids are u64 inside Graphite. We generate them here since the wrapper cannot return values (see docs/graphite-internals.md §2). */
export function generateNodeId(): string {
	const buffer = new BigUint64Array(1);
	crypto.getRandomValues(buffer);
	// Avoid 0 (reserved for ROOT_PARENT) and u64::MAX (used as a sentinel in places)
	let value = buffer[0] ?? 1n;
	if (value === 0n || value === 0xffff_ffff_ffff_ffffn) value = 1n + BigInt(Date.now());
	return value.toString();
}
